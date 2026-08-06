import {
  loadChangeBundle,
  readApproval,
  writeApproval,
  type ApprovalSuccess,
  type ChangeBundleDeltaEntry
} from "@legion/artifacts";
import {
  LEGION_PROTOCOL_VERSION,
  buildChangeIdempotencyKey,
  type Actor,
  type Approval
} from "@legion/protocol";

import {
  failure,
  hasFlag,
  helpResult,
  stringOption,
  success,
  usageError,
  type CliContext,
  type CliResult
} from "../../runtime.js";
import {
  describeDecisionOwners,
  resolveApprover,
  PROJECT_MANIFEST_PATH
} from "../../workflow/approver.js";
import { currentUtcTimestamp, resolveBaseGitSha } from "../../workflow/change-input.js";
import { loadWorkflowProject } from "../../workflow/context.js";
import { nextAction, renderDiagnostics, renderNextAction } from "../../workflow/render.js";
import { approvalIdForSubject } from "../../workflow/run-artifacts.js";
import { isLiveDeltaSpecGrant } from "../../workflow/ship-gates.js";
import { findLatestWorkflowChangeId } from "../../workflow/state.js";

const APPROVE_HELP = `legion approve <subject>

Record a human decision about part of the latest change. This writes a governance
artifact and nothing else: it does not plan, build, review or ship.

Subjects:
  spec    Approve the change's delta specs.

legion approve spec [--requirement <id>] --approver <id> [--dry-run]

  --approver <id>     Required. A human decision owner recorded in
                      .legion/project/project.json. No approver is inferred from
                      the environment, from git config, or from a project having
                      only one owner.
  --requirement <id>  Approve only this requirement's delta spec. Omitted, every
                      delta spec in the change is approved, which is what the
                      approved_delta_spec ship gate asks about. Not repeatable:
                      a second --requirement replaces the first.
  --dry-run           Resolve the approver and the delta specs, report what would
                      be written, and write nothing.

Examples:
  legion approve spec --approver dasbl
  legion approve spec --approver dasbl --dry-run
  legion approve spec --requirement req_editor-saves-metadata --approver dasbl`;

/**
 * The action a delta-spec approval carries.
 *
 * The same literal `ship-gates.ts` matches on, written out in both places rather
 * than shared through a constant, for the reason `REVIEW_ACCEPT_ACTION` in
 * `review.ts` already records: the gate and the writer are two sides of a
 * contract, and a shared symbol would let a rename move both at once and leave
 * every approval already on disk unreadable by the gate that reads them.
 */
const DELTA_SPEC_APPROVE_ACTION = "spec.delta.approve";

/**
 * `legion approve <subject>`, a subject positional rather than `--spec`.
 *
 * Later work approves oracles and protected paths. As booleans those become
 * mutually exclusive flags needing runtime cross-validation; as a positional
 * they are a closed switch whose `default:` arm enumerates what exists.
 *
 * Bare `legion approve` is a usage error rather than a help screen. A host that
 * mis-splits its argv must not read a help screen as a completed approval.
 */
export async function handleApproveWorkflow(context: CliContext): Promise<CliResult> {
  const subject = context.args.positionals[0];
  if (hasFlag(context, "help") || subject === "help") {
    return helpResult(APPROVE_HELP);
  }
  if (subject === undefined) {
    return usageError(
      "legion approve requires a subject. Supported subjects: spec. Example: legion approve spec --approver <id>."
    );
  }
  if (subject !== "spec") {
    return usageError(
      `Unknown approval subject: legion approve ${subject}. Supported subjects: spec.`
    );
  }

  return approveDeltaSpecs(context);
}

/** What the approvals plane already records about one of the change's delta specs. */
interface DeltaSpecState {
  readonly delta: ChangeBundleDeltaEntry;
  readonly approvalId: ReturnType<typeof approvalIdForSubject>;
  readonly existing?: ApprovalSuccess;
  /**
   * Does the document on disk already satisfy `approved_delta_spec` for this
   * delta — whoever granted it?
   *
   * The gate's own predicate answers this, imported rather than restated. It is
   * what `unapproved` is computed from, so that field reports requirements
   * without a live grant rather than requirements this invocation did not
   * select.
   */
  readonly approved: boolean;
}

/** What one delta spec's approval will be, before anything is written. */
interface PlannedApproval extends DeltaSpecState {
  /**
   * `grant` — nothing is recorded yet.
   * `regrant` — a document exists that does not satisfy the gate for this
   *   approver, so this run decides it and replaces it as the next revision.
   * `unchanged` — this approver's grant already satisfies the gate against these
   *   exact bytes, so there is nothing to decide and nothing is written.
   */
  readonly action: "grant" | "regrant" | "unchanged";
  readonly previousStatus?: Approval["status"];
}

async function approveDeltaSpecs(context: CliContext): Promise<CliResult> {
  const requirementRaw = stringOption(context, "requirement")?.trim();
  if (context.args.options.get("requirement") === true || requirementRaw === "") {
    return usageError(
      "Missing required value for --requirement. Example: legion approve spec --requirement req_editor-saves-metadata."
    );
  }

  const latestChange = await findLatestWorkflowChangeId(context.repositoryRoot);
  if (!latestChange.ok) {
    return blockedApprove(latestChange.diagnostics, recoveryForDiscovery(latestChange.diagnostics));
  }

  const bundle = await loadChangeBundle({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });
  if (!bundle.ok) {
    // Defensive, and reached only if the bundle stops loading between the
    // listing above and here: `findLatestWorkflowChangeId` loads every change
    // bundle to find the newest one, so a bundle this command cannot read has
    // already failed discovery. The loader's own diagnostics pass through
    // unchanged either way, so `delta_artifact_mismatch` reaches the operator by
    // its own name rather than as "approve failed".
    return blockedApprove(bundle.diagnostics, recoveryForDiscovery(bundle.diagnostics), {
      change: { changeId: latestChange.changeId }
    });
  }

  const selected = selectDeltas(bundle.bundle.deltas, requirementRaw);
  if (!selected.ok) {
    return blockedApprove(
      selected.diagnostics,
      nextAction("legion approve spec", "Approve a delta spec this change actually records."),
      { change: { changeId: latestChange.changeId } }
    );
  }

  // Resolved before the dry run returns, and before any approval is read. A dry
  // run exists to answer "will this command line work", and one that resolves
  // nothing answers yes to `--approver dasbi` — the fifth defect the review verb
  // recorded, restated here rather than rediscovered.
  const approver = await resolveSpecApprover(context);
  if (!approver.ok) return approver.result;

  // One instant for the whole run, read before anything is decided: it is the
  // clock the gate's expiry comparison is made against *and* the decision
  // instant written into every approval this run records. Two reads would let a
  // grant be judged live against one moment and dated at another.
  const decidedAt = currentUtcTimestamp();
  const selectedIds = new Set(selected.deltas.map((delta) => delta.requirementId));

  // Every delta of the change is read, not only the selected ones. `unapproved`
  // has to answer "which requirements does this change still ship without a
  // grant", and an earlier draft answered "which did this invocation not
  // select" — so `legion approve spec --requirement b` on a change whose `a` was
  // already approved reported `a` as unapproved and advised approving it again.
  // That is the one field an operator is meant to trust to tell them the job is
  // unfinished, wrong in the direction that trains them to ignore it.
  const states: DeltaSpecState[] = [];
  for (const delta of bundle.bundle.deltas) {
    const approvalId = approvalIdForSubject({
      changeId: bundle.bundle.change.id,
      action: DELTA_SPEC_APPROVE_ACTION,
      subject: { kind: "requirement", id: delta.requirementId }
    });
    const existing = await readApproval({
      repositoryRoot: context.repositoryRoot,
      changeId: bundle.bundle.change.id,
      approvalId
    });
    if (!existing.ok && existing.status !== "not_found") {
      // Blocking only for a requirement this run would write. Creating over an
      // unread existing approval is the one way to silently replace a revocation
      // with a fresh grant, which is exactly what an audit trail must not
      // permit. For a requirement this run is not deciding, an unreadable
      // document is not a reason to refuse the whole command — it is counted as
      // unapproved, which is the conservative direction and the one that leaves
      // the operator with the thread.
      if (selectedIds.has(delta.requirementId)) {
        return blockedApprove(
          existing.diagnostics,
          nextAction(
            "legion approve spec",
            `An approval already exists for ${delta.requirementId} and could not be read. Correct it by hand, then run this again.`
          ),
          { change: { changeId: latestChange.changeId } }
        );
      }
      states.push({ delta, approvalId, approved: false });
      continue;
    }

    states.push({
      delta,
      approvalId,
      approved:
        existing.ok &&
        isLiveDeltaSpecGrant({
          approval: existing.document,
          changeId: bundle.bundle.change.id,
          delta,
          evaluatedAt: decidedAt
        }),
      ...(existing.ok ? { existing } : {})
    });
  }

  const planned: PlannedApproval[] = states
    .filter((state) => selectedIds.has(state.delta.requirementId))
    .map((state) => ({ ...state, ...plannedActionFor(state, approver.approver) }));

  // Two different questions, and answering both with one number is how the dry
  // run came to advise `legion build` on a change where nothing was approved.
  // A dry run writes nothing, so what it must report is the state as it stands;
  // the write path reports the state this run leaves behind.
  const unapprovedNow = states.filter((state) => !state.approved).map((state) => state.delta.requirementId);
  const unapprovedAfter = states
    .filter((state) => !state.approved && !selectedIds.has(state.delta.requirementId))
    .map((state) => state.delta.requirementId);

  if (hasFlag(context, "dry-run")) {
    const unapproved = unapprovedNow;
    const action = dryRunNextActionFor(unapproved, bundle.bundle.deltas.length);
    return success(
      {
        ok: true,
        status: "ready",
        dryRun: true,
        change: { changeId: latestChange.changeId },
        approver: approver.approver,
        // No `status` and no `decidedAt` on these entries: nothing was decided,
        // and a dry-run payload that carried them would read as a record of a
        // decision to anything parsing it.
        approvals: planned.map((entry) => ({
          requirementId: entry.delta.requirementId,
          deltaSpecPath: entry.delta.path,
          approvalId: entry.approvalId,
          pinned: entry.delta.delta,
          action: entry.action,
          ...(entry.previousStatus === undefined ? {} : { previousStatus: entry.previousStatus })
        })),
        unapproved,
        nextAction: action,
        diagnostics: []
      },
      [
        "Approve ready.",
        `Dry run: ${planned.length} delta spec${planned.length === 1 ? "" : "s"} of ${latestChange.changeId}.`,
        ...planned.map((entry) => `  ${entry.action.padEnd(9)} ${entry.delta.requirementId}  ${entry.delta.path}`),
        `Approver: ${approver.approver.id} (${approver.approver.kind}).`,
        "No approval was written.",
        renderNextAction(action)
      ].join("\n")
    );
  }

  const written: ApprovalSuccess[] = [];
  const superseded: ApprovalSuccess[] = [];
  for (const entry of planned) {
    if (entry.action === "unchanged") continue;

    // The withdrawal is copied out before the grant lands on top of it.
    //
    // `writeApproval` computes a `supersedes` reference and `atomic-write.ts`
    // uses it only as a pre-write hash check before `rename()` replaces the
    // file: it is a sha256 of bytes that are then deleted, and it is never
    // persisted into any document. So the commit that introduced this verb was
    // wrong to justify having no `--force` by saying the store chains the
    // superseded revision. It does not, and re-granting over a revocation
    // deleted the only record of it — from the plane whose entire purpose is
    // holding the negative fact.
    const archived = await archiveWithdrawnDecision({
      repositoryRoot: context.repositoryRoot,
      entry,
      decidedAt
    });
    if (!archived.ok) {
      return blockedApprove(archived.diagnostics, archived.action, {
        change: { changeId: latestChange.changeId },
        approvals: written.map(approvalSummary)
      });
    }
    if (archived.record !== undefined) superseded.push(archived.record);

    const document = deltaSpecApproval({
      entry,
      projectId: bundle.bundle.change.projectId,
      changeId: bundle.bundle.change.id,
      approver: approver.approver,
      decidedAt,
      ...(archived.record === undefined ? {} : { superseding: archived.record })
    });
    const write = await writeApproval({
      repositoryRoot: context.repositoryRoot,
      expectedRevision: entry.existing === undefined ? 0 : entry.existing.revision.revision,
      baseGitSha: resolveBaseGitSha(context.repositoryRoot),
      document
    });
    if (!write.ok) {
      // The approvals that already landed are named in the failure payload. A
      // mid-loop failure leaves a partial state, and rerunning is safe: an
      // already-current requirement reports `unchanged` and is not re-decided.
      return blockedApprove(
        write.diagnostics,
        nextAction(
          "legion approve spec",
          "Some delta specs were approved and one write failed. Rerunning re-decides only what is not already approved."
        ),
        {
          change: { changeId: latestChange.changeId },
          approvals: written.map(approvalSummary)
        }
      );
    }
    written.push(write);
  }

  const unapproved = unapprovedAfter;
  const action = nextActionFor(unapproved, bundle.bundle.deltas.length);
  const decided = planned.filter((entry) => entry.action !== "unchanged").length;
  const warnings = superseded.map((record) => ({
    code: "withdrawn_approval_superseded",
    message:
      `${record.document.decidedBy?.id ?? "someone"} had recorded this approval as ${record.document.status}` +
      `${record.document.decisionReason === undefined ? "" : ` ("${record.document.decisionReason}")`}` +
      `, and this grant supersedes that decision. The withdrawal is preserved at ${record.artifactPath} ` +
      "and is the standing record of it; nothing was deleted.",
    path: record.artifactPath
  }));
  return success(
    {
      ok: true,
      status: decided === 0 ? "unchanged" : "approved",
      change: { changeId: latestChange.changeId },
      approver: approver.approver,
      ...(warnings.length === 0 ? {} : { warnings }),
      ...(superseded.length === 0 ? {} : { supersededDecisions: superseded.map(approvalSummary) }),
      approvals: planned.map((entry) => {
        const record = written.find((candidate) => candidate.document.id === entry.approvalId);
        return {
          requirementId: entry.delta.requirementId,
          deltaSpecPath: entry.delta.path,
          approvalId: entry.approvalId,
          pinned: entry.delta.delta,
          action: entry.action,
          ...(entry.previousStatus === undefined ? {} : { previousStatus: entry.previousStatus }),
          artifactPath: record?.artifactPath ?? entry.existing?.artifactPath,
          status: "granted",
          decidedBy: record?.document.decidedBy ?? entry.existing?.document.decidedBy,
          decidedAt: record?.document.decidedAt ?? entry.existing?.document.decidedAt
        };
      }),
      // The field an obvious implementation omits, and the one that stops an
      // operator believing a partial approval finished the job: the gate is
      // change-scoped and satisfied only by full coverage, so approving one of
      // three requirements leaves ship blocked over two the operator never saw.
      unapproved,
      nextAction: action,
      diagnostics: []
    },
    [
      decided === 0
        ? `Already approved: ${planned.length} delta spec${planned.length === 1 ? "" : "s"} of ${latestChange.changeId}.`
        : `Approved ${decided} delta spec${decided === 1 ? "" : "s"} for ${latestChange.changeId}.`,
      ...planned.map((entry) => `  ${entry.action.padEnd(9)} ${entry.delta.requirementId}  ${entry.delta.path}`),
      `Approver: ${approver.approver.id} (${approver.approver.kind}).`,
      ...warnings.map((warning) => `Warning: ${warning.message}`),
      renderNextAction(action)
    ].join("\n")
  );
}

/**
 * What to advise when the change could not be loaded.
 *
 * `legion ship` answers this state with `legion plan <n>`, which cannot perform
 * the repair it promises: plan is create-only and exits with
 * `artifact_already_exists` against a change that already exists. That is a real
 * defect and it is not this verb's to fix — the ship traceability suite runs the
 * recoveries ship emits — but this verb must not reproduce it.
 *
 * `delta_artifact_mismatch` is the one code with a specific answer, and it is
 * the state an operator of *this* verb is most likely to be in. Nothing in the
 * tree rewrites a delta spec: `legion plan` refuses to re-plan and no other
 * command writes one, so the bytes have been changed out of band and restoring
 * them is the only repair. Saying "re-approve it" would launder an out-of-band
 * edit into a governance record.
 */
function recoveryForDiscovery(diagnostics: readonly unknown[]): ReturnType<typeof nextAction> {
  const codes = new Set(
    diagnostics
      .map((diagnostic) =>
        diagnostic !== null && typeof diagnostic === "object" && "code" in diagnostic
          ? String((diagnostic as { readonly code: unknown }).code)
          : ""
      )
      .filter((code) => code.length > 0)
  );
  if (codes.has("delta_artifact_mismatch")) {
    return nextAction(
      "legion approve spec",
      "A delta spec's bytes no longer match the hash its change bundle records, so the change will not load. " +
        "No command rewrites a delta spec — plan is create-only — so restore the file to the bytes the bundle " +
        "records, then run this again. Re-approving edited bytes is deliberately not offered."
    );
  }
  return nextAction("legion plan 1", "Approving a delta spec requires a planned change.");
}

/**
 * What this run would do to one requirement's approval.
 *
 * Three outcomes, decided from the artifacts rather than from a flag. There is
 * no `--force` and no `--reapprove`, because every one of these is decidable:
 *
 *  - No document, or one that does not already satisfy the gate for this
 *    approver: this is a decision, so record it.
 *  - A document that already satisfies `approved_delta_spec` and records *this*
 *    approver: nothing was decided, so nothing is written. Rewriting would mint
 *    a new revision and move `decidedAt` forward for a decision nobody re-made —
 *    and `decidedAt` is what a later ordering gate compares against a run's
 *    start, so a harmless rerun would turn a valid ordering into an invalid one.
 *
 * **`unchanged` is the gate's own predicate and not a paraphrase of it.**
 * `state.approved` comes from `isLiveDeltaSpecGrant`, which runs the gate. The
 * draft this replaces asked a strictly weaker question — granted, human, no
 * expiry, some pin at the path — and so reported "already approved" over four
 * document shapes the gate rejects: two pins at the delta's path, a stray
 * `taskId`, a `scope.action` that is not `spec.delta.approve`, and a requirement
 * target naming something else. Each of those left `legion ship` blocked on this
 * gate with no command anywhere that would write, which is the no-route-out loop
 * `shipGateRecovery` exists to close, reintroduced by the verb that closes it.
 * Anything the gate would not accept now falls through to `regrant`.
 *
 * The approver is checked on top of the gate rather than inside it. The gate
 * does not care who granted an approval, but this command does: a rerun by the
 * same person re-decides nothing, while the same words from a different decision
 * owner are a different person's decision and are recorded.
 *
 * A revoked or denied document is re-granted rather than refused — a gate that
 * could never recover from a withdrawn approval would push operators to delete
 * artifacts to unblock a ship. What makes that safe is `archiveWithdrawnDecision`
 * below, not the storage model, which does not preserve anything on its own.
 */
function plannedActionFor(
  state: DeltaSpecState,
  approver: Actor
): { readonly action: PlannedApproval["action"]; readonly previousStatus?: Approval["status"] } {
  const existing = state.existing;
  if (existing === undefined) return { action: "grant" };

  const document = existing.document;
  if (state.approved && document.decidedBy?.id === approver.id) {
    return { action: "unchanged", previousStatus: document.status };
  }

  return { action: "regrant", previousStatus: document.status };
}

/**
 * Copy a withdrawn decision out of the way before a grant overwrites it.
 *
 * `denied` and `revoked` only. Both carry a decider, an instant and a reason —
 * the schema requires all three of a decided approval — so the copy is a
 * complete record of somebody's negative decision. `expired` and `requested`
 * are deliberately excluded and the exclusion is load-bearing rather than
 * tidiness: `expired` admits a document with no `decidedAt`, and
 * `deltaSpecApprovalStatus` treats a negative with no decision instant as one no
 * later grant can ever supersede. Archiving one of those would leave a change
 * permanently unshippable with no command able to repair it — trading a lost
 * record for a bricked change. An expired grant is a lapse rather than
 * somebody's withdrawal, and re-deciding it in place loses no human decision.
 *
 * The copy is a second approval document rather than a field on the new one,
 * because the plane is what `legion ship` reads. Its `scope` is unchanged, so
 * the gate sees the revocation, applies the supersession rule PR 1 built for
 * exactly this — a standing negative blocks unless a *strictly later* grant
 * supersedes it — and reaches `satisfied` because this run's `decidedAt` is
 * later. That rule was previously unreachable through any Legion writer; it now
 * has a producer.
 *
 * Which is also why an out-of-order withdrawal is refused rather than archived:
 * if the negative is dated at or after the instant this run is granting at, the
 * archived copy would stand and the change would be unshippable with the command
 * that could fix it reporting success. Refusing says so, names both instants,
 * and leaves the file untouched.
 */
async function archiveWithdrawnDecision(input: {
  readonly repositoryRoot: string;
  readonly entry: PlannedApproval;
  readonly decidedAt: ReturnType<typeof currentUtcTimestamp>;
}): Promise<
  | { readonly ok: true; readonly record?: ApprovalSuccess }
  | { readonly ok: false; readonly diagnostics: readonly unknown[]; readonly action: ReturnType<typeof nextAction> }
> {
  const existing = input.entry.existing;
  if (existing === undefined) return { ok: true };
  const document = existing.document;
  if (document.status !== "denied" && document.status !== "revoked") return { ok: true };

  if (document.decidedAt >= input.decidedAt) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "withdrawal_not_superseded",
          message:
            `Approval ${document.id} for ${input.entry.delta.requirementId} was ${document.status} at ${document.decidedAt}, ` +
            `which is not before this run's decision instant ${input.decidedAt}. A grant only supersedes a withdrawal when it is ` +
            "strictly later, so writing one now would leave the withdrawal standing and the change unshippable. Nothing was written.",
          path: existing.artifactPath
        }
      ],
      action: nextAction(
        "legion approve spec",
        "The recorded withdrawal is dated at or after now, so no grant taken now can supersede it. Check the clock on the machine that wrote it, then run this again."
      )
    };
  }

  const archiveId = approvalIdForSubject({
    changeId: document.changeId,
    // The subject of the archive is "the decision that stood at revision N",
    // which is what makes the id distinct and stable: a second withdrawal of the
    // same requirement is a different revision and lands beside this one rather
    // than on it. Colliding ids would fail the write, which is a refusal — never
    // an overwrite.
    action: `${DELTA_SPEC_APPROVE_ACTION}.superseded.r${existing.revision.revision}`,
    subject: { kind: "requirement", id: input.entry.delta.requirementId }
  });

  const write = await writeApproval({
    repositoryRoot: input.repositoryRoot,
    expectedRevision: 0,
    baseGitSha: resolveBaseGitSha(input.repositoryRoot),
    document: {
      ...document,
      id: archiveId,
      updatedAt: input.decidedAt,
      metadata: {
        ...(document.metadata ?? {}),
        attributes: {
          ...(document.metadata?.attributes ?? {}),
          superseded_approval_id: document.id,
          superseded_at: input.decidedAt
        }
      }
    }
  });
  if (!write.ok) {
    return {
      ok: false,
      diagnostics: write.diagnostics,
      action: nextAction(
        "legion approve spec",
        `The ${document.status} approval for ${input.entry.delta.requirementId} could not be copied aside, so nothing was overwritten. ` +
          "A grant is not written over a withdrawal that cannot first be preserved."
      )
    };
  }
  return { ok: true, record: write };
}

/**
 * The approval document, pinning the delta spec's bytes.
 *
 * `artifacts` is `delta.delta` copied whole rather than a hash minted here.
 * `loadChangeBundle` re-reads every delta spec and refuses the bundle when the
 * bytes disagree with the reference it carries, so by the time this runs the
 * reference has already been checked against disk *by this same command*.
 * Hashing again would establish the same fact twice and add a refusal branch
 * that nothing can reach and no test can drive.
 *
 * It must be that reference and no other. `legion ship` pre-resolves only
 * `bundle.deltas[].delta` and the oracle references, so an approval pinning any
 * other path answers `unverified` and the gate goes permanently `unevaluable` —
 * a gate that looks implemented and can never pass.
 *
 * `taskId` and `runId` are omitted. A delta spec is a property of the change;
 * naming a task would assert a pairing this decision does not make, and no run
 * exists at all between `legion plan` and `legion build`.
 *
 * `requestedBy` is the approver, which is where this departs from
 * `legion review --accept`. There the review gate genuinely raised a request a
 * human then decided, so the requester is the tool. Here the operator raised and
 * decided in one act, and `requestedAt === decidedAt` records that. Inventing a
 * tool requester would trade a true statement for a false one.
 */
function deltaSpecApproval(input: {
  readonly entry: PlannedApproval;
  readonly projectId: Parameters<typeof buildChangeIdempotencyKey>[0]["projectId"];
  readonly changeId: Parameters<typeof buildChangeIdempotencyKey>[0]["changeId"];
  readonly approver: Actor;
  readonly decidedAt: ReturnType<typeof currentUtcTimestamp>;
  /** The withdrawal this grant overrules, once it has been safely copied aside. */
  readonly superseding?: ApprovalSuccess;
}): Approval {
  const existing = input.entry.existing;
  return {
    schemaVersion: LEGION_PROTOCOL_VERSION,
    // `createdAt` and `requestedAt` are the request instant and survive every
    // re-decision, so the approvals listing's sort order does not move when a
    // requirement is re-approved. `decidedAt` is the instant of *this* decision.
    createdAt: existing === undefined ? input.decidedAt : existing.document.createdAt,
    updatedAt: input.decidedAt,
    kind: "approval",
    id: input.entry.approvalId,
    projectId: input.projectId,
    changeId: input.changeId,
    requestedBy: input.approver,
    requestedAt: existing === undefined ? input.decidedAt : existing.document.requestedAt,
    scope: {
      // S1: a local idempotent write of one of Legion's own governance
      // artifacts. Nothing here deploys, deletes or rotates anything.
      effectClass: "S1",
      action: DELTA_SPEC_APPROVE_ACTION,
      targets: [
        { kind: "requirement", id: input.entry.delta.requirementId },
        { kind: "change", id: input.changeId }
      ]
    },
    idempotencyKey: buildChangeIdempotencyKey({
      projectId: input.projectId,
      changeId: input.changeId,
      effectKind: DELTA_SPEC_APPROVE_ACTION,
      targetHash: input.entry.delta.delta.sha256
    }),
    artifacts: [input.entry.delta.delta],
    status: "granted",
    decidedBy: input.approver,
    decidedAt: input.decidedAt,
    // The overruled withdrawal is named in the grant as well as preserved beside
    // it. The copy is the record; this sentence is what a reader of *this*
    // document sees without having to list the directory, and it is why the
    // supersession does not depend on somebody noticing a second file.
    decisionReason:
      `${input.approver.id} approved the delta spec for ${input.entry.delta.requirementId} at ${input.entry.delta.delta.sha256} via legion approve spec.` +
      (input.superseding === undefined
        ? ""
        : ` This supersedes the ${input.superseding.document.status} decision recorded by ` +
          `${input.superseding.document.decidedBy?.id ?? "an unnamed decider"} at ${input.superseding.document.decidedAt}, preserved at ${input.superseding.artifactPath}.`)
  };
}

/**
 * Which delta specs this run is about.
 *
 * `--requirement` is optional and approving every delta spec is the default,
 * because the gate's own quantifier is over every `bundle.deltas[].requirementId`.
 * A per-requirement default would make the successful-looking path the one that
 * leaves ship blocked over a requirement the operator never heard of. It is also
 * not repeatable: `parseCliArgs` stores options in a Map, so a second
 * `--requirement` replaces the first, and inventing comma-splitting would add a
 * second parser to keep honest for ids that contain no comma.
 *
 * A `--requirement` naming nothing in the change is blocked rather than a usage
 * error: the argv is well formed, and what refuses is the change's own contents.
 */
function selectDeltas(
  deltas: readonly ChangeBundleDeltaEntry[],
  requirementId: string | undefined
):
  | { readonly ok: true; readonly deltas: readonly ChangeBundleDeltaEntry[] }
  | { readonly ok: false; readonly diagnostics: readonly unknown[] } {
  if (requirementId === undefined) return { ok: true, deltas };

  const matched = deltas.filter((delta) => delta.requirementId === requirementId);
  if (matched.length === 0) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "requirement_not_in_change",
          message:
            `--requirement ${requirementId} has no delta spec in this change. ` +
            `This change's delta specs cover: ${deltas.map((delta) => delta.requirementId).join(", ")}. ` +
            "A requirement with no delta spec is not part of this change, and approving one Legion cannot show you would approve nothing."
        }
      ]
    };
  }
  return { ok: true, deltas: matched };
}

/**
 * Where the operator goes next, after this run has written what it is going to.
 *
 * This is what places `approve` in the plan-to-build chain without touching
 * `resolveWorkflowState`. The stage machine still routes a planned change to
 * `legion build`, and eight pinned assertions plus the dogfood harness depend on
 * that; changing it belongs in the same diff as the dogfood that proves it.
 *
 * `unapproved` must be requirements left without a live grant, not requirements
 * this invocation did not select — see `unapprovedAfter` at the call site.
 */
function nextActionFor(unapproved: readonly string[], total: number): ReturnType<typeof nextAction> {
  if (unapproved.length > 0) {
    return nextAction(
      "legion approve spec",
      `${unapproved.length} of ${total} delta specs in this change are still unapproved (${unapproved.join(", ")}); ` +
        "the approved_delta_spec gate is satisfied only when every one of them carries a granted approval."
    );
  }
  return nextAction(
    "legion build",
    "Every delta spec in this change is approved; the change is ready for guided build execution."
  );
}

/**
 * Where the operator goes next after a run that wrote nothing.
 *
 * A separate function, because the shared one told the operator to build. A dry
 * run selects every delta by default, so "nothing was left unselected" was true
 * on a change where nothing had been approved at all, and the payload said
 * `nextAction: legion build` with the reason "Every delta spec in this change is
 * approved". `commands/approve.md` makes the dry run step 1 of its process and
 * tells the host to present `nextAction` as its recommendation — so the one
 * command whose contract is "write nothing and tell you the truth" routed
 * straight past itself to a build, and `legion ship` then blocked on the gate
 * this verb exists to satisfy. The human-readable text carried "No approval was
 * written."; the JSON, which is what hosts parse, carried only `dryRun: true`.
 *
 * The advice is always this command, never the next stage: after a dry run
 * nothing has been decided, so the next act is to take the decision.
 */
function dryRunNextActionFor(unapproved: readonly string[], total: number): ReturnType<typeof nextAction> {
  if (unapproved.length === 0) {
    return nextAction(
      "legion build",
      `All ${total} delta spec${total === 1 ? "" : "s"} in this change already carry a granted approval, and this dry run ` +
        "found nothing left to decide; the change is ready for guided build execution."
    );
  }
  return nextAction(
    "legion approve spec --approver <id>",
    `This was a dry run and no approval was written. ${unapproved.length} of ${total} delta specs in this change are ` +
      `unapproved (${unapproved.join(", ")}); the approved_delta_spec gate stays unsatisfied until this command is run without --dry-run.`
  );
}

type SpecApproverDecision =
  | { readonly ok: true; readonly approver: Actor }
  | { readonly ok: false; readonly result: CliResult };

/**
 * Turn `--approver <id>` into an actor, and refuse when it is absent.
 *
 * Unlike `legion review`, where the approver is required only when a task
 * derives the human-approval gate, it is required here at every tier: the whole
 * artifact this verb writes *is* a human's decision, so there is no branch in
 * which it can be absent and the record still mean anything.
 *
 * The identity rule itself is `resolveApprover`, reused unchanged. A second
 * identity rule would be a second thing to get wrong, and the first one already
 * refuses an unknown id, an ambiguous one and a non-human owner by name.
 */
async function resolveSpecApprover(context: CliContext): Promise<SpecApproverDecision> {
  const raw = stringOption(context, "approver")?.trim();
  if (context.args.options.get("approver") === true || raw === "") {
    return {
      ok: false,
      result: usageError("Missing required value for --approver. Example: legion approve spec --approver dasbl.")
    };
  }

  if (raw === undefined) {
    return {
      ok: false,
      result: blockedApprove(
        [
          {
            code: "approver_required",
            message:
              "legion approve spec records a human's decision about a delta spec, so it requires --approver <id> " +
              `naming a human decision owner recorded in ${PROJECT_MANIFEST_PATH}. ` +
              "No approver is inferred from the environment, from git config, or from a project having only one owner — " +
              "an approval recorded against a defaulted identity is not a human approval.",
            path: PROJECT_MANIFEST_PATH
          }
        ],
        nextAction("legion approve spec --approver <id>", "A delta-spec approval requires a named human approver.")
      )
    };
  }

  const project = await loadWorkflowProject(context);
  if (!project.ok) {
    return {
      ok: false,
      result: blockedApprove(
        project.diagnostics,
        nextAction("legion start", "The project manifest records who may approve, and it could not be read.")
      )
    };
  }

  const owners = project.loaded.project.policy.decisionOwners;
  const resolved = resolveApprover({ raw, decisionOwners: owners });
  if (!resolved.ok) {
    return {
      ok: false,
      result: blockedApprove(
        resolved.diagnostics,
        nextAction(
          "legion approve spec --approver <id>",
          `Name a human decision owner recorded in ${PROJECT_MANIFEST_PATH}. Recorded owners: ${describeDecisionOwners(owners)}.`
        )
      )
    };
  }

  return { ok: true, approver: resolved.approver };
}

/** What a host needs to show that a delta spec was approved, and by whom. */
function approvalSummary(approval: ApprovalSuccess): Record<string, unknown> {
  return {
    approvalId: approval.document.id,
    artifactPath: approval.artifactPath,
    status: approval.document.status,
    action: approval.document.scope.action,
    pinned: approval.document.artifacts?.[0],
    decidedBy: approval.document.decidedBy,
    decidedAt: approval.document.decidedAt
  };
}

function blockedApprove(
  diagnostics: readonly unknown[],
  action: ReturnType<typeof nextAction>,
  extras: Record<string, unknown> = {}
): CliResult {
  return failure(
    {
      ok: false,
      status: "blocked",
      ...extras,
      diagnostics,
      nextAction: action
    },
    ["Approve blocked.", renderDiagnostics(diagnostics), renderNextAction(action)].join("\n")
  );
}
