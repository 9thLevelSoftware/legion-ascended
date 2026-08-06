import {
  listTaskRunsForChange,
  loadChangeBundle,
  readApproval,
  readEvidenceIndex,
  readTaskGraph,
  writeApproval,
  type ApprovalSuccess,
  type ChangeBundleDeltaEntry
} from "@legion/artifacts";
import {
  LEGION_PROTOCOL_VERSION,
  artifactReferenceSchema,
  buildChangeIdempotencyKey,
  oracleIdSchema,
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
import { loadOracleFacts } from "../../workflow/change-planes.js";
import { loadWorkflowProject } from "../../workflow/context.js";
import { nextAction, renderDiagnostics, renderNextAction } from "../../workflow/render.js";
import { mintPinnedReferences } from "../../workflow/pinned-references.js";
import { approvalIdForSubject, taskIdForContractId } from "../../workflow/run-artifacts.js";
import {
  changeOracleDemand,
  changeVerificationSurfaces,
  derivesApprovalOrderingGate,
  earliestExecutionRun,
  isLiveDeltaSpecGrant,
  isLiveOracleGrant,
  isLiveSurfaceReaffirmation,
  type ShipGateOracleFact
} from "../../workflow/ship-gates.js";
import { taskRunPlaneContradictions } from "./ship.js";
import { findLatestWorkflowChangeId } from "../../workflow/state.js";

const APPROVE_HELP = `legion approve <subject>

Record a human decision about part of the latest change. This writes a governance
artifact and nothing else: it does not plan, build, review or ship.

Subjects:
  spec     Approve the change's delta specs.
  oracle   Approve the oracles the change's work will be judged against.
  surface  Re-affirm a verification surface whose pinned file has been edited.

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

legion approve oracle [--oracle <id>] --approver <id> [--dry-run]

  An oracle states the criteria a task's work will be judged against. Approving
  one records a named human saying those are the right criteria — before the work
  exists, which is the whole point. The approved_spec_and_oracle risk gate at R3
  compares the last of these decisions against the instant the first task run
  started, so this belongs beside legion approve spec and before legion build.

  Nothing re-orders a decision once it has been taken. Run this after a build and
  the gate reports unsatisfied for good, with no command able to move it.

  --approver <id>     Required, same rule as above.
  --oracle <id>       Approve only this oracle. Omitted, every oracle the change's
                      tasks are judged against is approved, which is what the gate
                      asks about. Not repeatable.
  --dry-run           Report what would be approved and write nothing.

legion approve surface [--path <file>] --approver <id> [--dry-run]

  A verification surface pins the files that make it real — the compose file
  standing the service up, the schema it is checked against. legion ship
  re-hashes them, so editing one stops the declaration being believed and
  integration_or_real_interface_checks reports unsatisfied. That is the point,
  and it is also why there has to be a way back: maintaining the integration
  harness is the honest thing to do, and nothing else re-mints a pin.

  This records a named human saying the declaration still describes what they
  meant, against the bytes on disk now. It re-affirms nothing that has not
  drifted, and nothing whose file cannot be read.

  --approver <id>     Required, same rule as above.
  --path <file>       Re-affirm only this pinned file. Omitted, every drifted pin
                      in the change is re-affirmed. Not repeatable.
  --dry-run           Report what would be re-affirmed and write nothing.

Examples:
  legion approve spec --approver dasbl
  legion approve spec --approver dasbl --dry-run
  legion approve spec --requirement req_editor-saves-metadata --approver dasbl
  legion approve oracle --approver dasbl
  legion approve oracle --oracle orc_phase-1-c1 --approver dasbl
  legion approve surface --approver dasbl
  legion approve surface --path ops/compose.integration.yml --approver dasbl`;

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
 * The action an oracle approval carries.
 *
 * Spelled out here and in `ship-gates.ts` rather than shared, on
 * `DELTA_SPEC_APPROVE_ACTION`'s rule: the gate and the writer are two sides of a
 * contract, and a shared symbol would let a rename move both at once and leave
 * every approval already on disk unreadable by the gate that reads them.
 */
const ORACLE_APPROVE_ACTION = "oracle.approve";

/**
 * Which narrowing flag belongs to which subject, and what it means.
 *
 * A table rather than the two-way ternary this replaces, and the replacement is a
 * defect fix rather than tidiness. The old form was
 * `const foreign = subject === "spec" ? "path" : "requirement"`, which does not
 * generalize: with a third subject it refuses `--requirement` for `oracle` by
 * accident and **accepts `legion approve oracle --path ops/x.yml` in silence** —
 * exactly the "a flag the operator typed is ignored" failure the guard exists to
 * prevent, failing open, in the direction where the command reports success for a
 * thing it did not do.
 *
 * `declared-options.ts` holds one list for every subject, because
 * `undeclaredOptionError` runs before this handler and cannot see which subject
 * was named. So the per-subject boundary has to be here, and it has to refuse
 * every option owned by another subject rather than one of them.
 */
const SUBJECT_OPTIONS = {
  spec: {
    owns: "requirement",
    hint: "It narrows a delta-spec approval to one requirement: legion approve spec --requirement <id>."
  },
  oracle: {
    owns: "oracle",
    hint: "It narrows an oracle approval to one oracle: legion approve oracle --oracle <id>."
  },
  surface: {
    owns: "path",
    hint: "It narrows a surface re-affirmation to one pinned file: legion approve surface --path <file>."
  }
} as const;

type ApprovalSubject = keyof typeof SUBJECT_OPTIONS;

const APPROVAL_SUBJECTS = Object.keys(SUBJECT_OPTIONS) as readonly ApprovalSubject[];

/**
 * `legion approve <subject>`, a subject positional rather than `--spec`.
 *
 * Later work approves protected paths. As booleans those become mutually
 * exclusive flags needing runtime cross-validation; as a positional they are a
 * closed switch whose `default:` arm enumerates what exists.
 *
 * Bare `legion approve` is a usage error rather than a help screen. A host that
 * mis-splits its argv must not read a help screen as a completed approval.
 */
export async function handleApproveWorkflow(context: CliContext): Promise<CliResult> {
  const subject = context.args.positionals[0];
  if (hasFlag(context, "help") || subject === "help") {
    return helpResult(APPROVE_HELP);
  }
  const supported = APPROVAL_SUBJECTS.join(", ");
  if (subject === undefined) {
    return usageError(
      `legion approve requires a subject. Supported subjects: ${supported}. Example: legion approve spec --approver <id>.`
    );
  }
  if (!APPROVAL_SUBJECTS.includes(subject as ApprovalSubject)) {
    return usageError(`Unknown approval subject: legion approve ${subject}. Supported subjects: ${supported}.`);
  }
  const named = subject as ApprovalSubject;

  // Every option another subject owns is refused by name, with the sentence that
  // says what it would have done there. A silent ignore here is how a command
  // reports success for a thing it did not do.
  for (const other of APPROVAL_SUBJECTS) {
    if (other === named) continue;
    const foreign = SUBJECT_OPTIONS[other].owns;
    if (!context.args.options.has(foreign)) continue;
    return usageError(
      `--${foreign} is not an option of legion approve ${named}. ${SUBJECT_OPTIONS[other].hint}`
    );
  }

  if (named === "surface") return approveVerificationSurfaces(context);
  if (named === "oracle") return approveOracles(context);
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

  // The ordering warning, which this verb did not carry and its sibling did.
  //
  // `legion approve oracle` and `legion approve spec` feed the *same* gate at R3,
  // and only one of them said so. Adversarial review followed ship's own advice on
  // an already-built R3 change — `legion approve spec --approver dasbl` — and got
  // `status: "approved"`, `warnings: undefined`, and a gate that had moved from
  // `unevaluable` to permanently `unsatisfied` with nothing in the payload
  // recording that anything had changed for the worse. At R2 the same command is
  // exactly as useful after a build as before it, which is why the warning is
  // gated on the tier that derives the ordering gate rather than emitted always.
  //
  // The task graph is read only for the tier. It failing to read is not a reason
  // to refuse an approval — the decision is a governance fact about the delta
  // specs, which loaded — so an unreadable graph degrades to no warning, which is
  // the pre-existing behaviour rather than a new refusal.
  const taskgraph = await readTaskGraph({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });
  const ordered = taskgraph.ok && derivesApprovalOrderingGate(taskgraph.document.tasks);
  const execution = await executionAlreadyStarted(context.repositoryRoot, latestChange.changeId);
  const executionWarnings = orderingWarnings({ changeId: latestChange.changeId, execution, ordered });
  const alreadyRan = executionWarnings.length > 0;

  if (hasFlag(context, "dry-run")) {
    const unapproved = unapprovedNow;
    const action = dryRunNextActionFor(unapproved, bundle.bundle.deltas.length, { ordered, alreadyRan });
    return success(
      {
        ok: true,
        status: "ready",
        dryRun: true,
        change: { changeId: latestChange.changeId },
        approver: approver.approver,
        ...(executionWarnings.length === 0 ? {} : { warnings: executionWarnings }),
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
        ...executionWarnings.map((warning) => `Warning: ${warning.message}`),
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
      existing: entry.existing,
      subject: entry.delta.requirementId,
      action: DELTA_SPEC_APPROVE_ACTION,
      target: { kind: "requirement", id: entry.delta.requirementId },
      command: "legion approve spec",
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
  const action = nextActionFor(unapproved, bundle.bundle.deltas.length, { ordered, alreadyRan });
  const decided = planned.filter((entry) => entry.action !== "unchanged").length;
  const warnings = [
    ...executionWarnings,
    ...superseded.map((record) => ({
      code: "withdrawn_approval_superseded",
      message:
        `${record.document.decidedBy?.id ?? "someone"} had recorded this approval as ${record.document.status}` +
        `${record.document.decisionReason === undefined ? "" : ` ("${record.document.decisionReason}")`}` +
        `, and this grant supersedes that decision. The withdrawal is preserved at ${record.artifactPath} ` +
        "and is the standing record of it; nothing was deleted.",
      path: record.artifactPath
    }))
  ];
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
  state: { readonly existing?: ApprovalSuccess; readonly approved: boolean },
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
  readonly existing: ApprovalSuccess | undefined;
  /** What the decision was about, in the operator's terms. */
  readonly subject: string;
  /** The action and target the archive's derived id is minted under. */
  readonly action: string;
  readonly target: { readonly kind: string; readonly id: string };
  /** The verb to advise if the archive refuses. */
  readonly command: string;
  readonly decidedAt: ReturnType<typeof currentUtcTimestamp>;
}): Promise<
  | { readonly ok: true; readonly record?: ApprovalSuccess }
  | { readonly ok: false; readonly diagnostics: readonly unknown[]; readonly action: ReturnType<typeof nextAction> }
> {
  const existing = input.existing;
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
            `Approval ${document.id} for ${input.subject} was ${document.status} at ${document.decidedAt}, ` +
            `which is not before this run's decision instant ${input.decidedAt}. A grant only supersedes a withdrawal when it is ` +
            "strictly later, so writing one now would leave the withdrawal standing and the change unshippable. Nothing was written.",
          path: existing.artifactPath
        }
      ],
      action: nextAction(
        input.command,
        "The recorded withdrawal is dated at or after now, so no grant taken now can supersede it. Check the clock on the machine that wrote it, then run this again."
      )
    };
  }

  const archiveId = approvalIdForSubject({
    changeId: document.changeId,
    // The subject of the archive is "the decision that stood at revision N",
    // which is what makes the id distinct and stable: a second withdrawal of the
    // same subject is a different revision and lands beside this one rather
    // than on it. Colliding ids would fail the write, which is a refusal — never
    // an overwrite.
    action: `${input.action}.superseded.r${existing.revision.revision}`,
    subject: input.target
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
        input.command,
        `The ${document.status} approval for ${input.subject} could not be copied aside, so nothing was overwritten. ` +
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
function nextActionFor(
  unapproved: readonly string[],
  total: number,
  execution: { readonly ordered: boolean; readonly alreadyRan: boolean }
): ReturnType<typeof nextAction> {
  if (unapproved.length > 0) {
    return nextAction(
      "legion approve spec",
      `${unapproved.length} of ${total} delta specs in this change are still unapproved (${unapproved.join(", ")}); ` +
        "the approved_delta_spec gate is satisfied only when every one of them carries a granted approval."
    );
  }
  // Two corrections in one branch, both measured on real R3 changes.
  //
  // A change already built was advised to build again — "the change is ready for
  // guided build execution" on a change that had run, which is the advice that
  // made its ordering unrepairable in the first place. And at R3 the delta specs
  // are only half of what `approved_spec_and_oracle` reads: routing straight to a
  // build here skips the oracles entirely, so the operator builds a change whose
  // oracle half nobody has approved and can no longer approve in time.
  if (execution.alreadyRan) {
    return nextAction(
      "legion ship",
      "Every delta spec in this change is approved, and this change has already run. approved_spec_and_oracle " +
        "compares the decision instants against the start of execution; legion ship reports which gates that leaves " +
        "unmet and why."
    );
  }
  if (execution.ordered) {
    return nextAction(
      "legion approve oracle --approver <id>",
      "Every delta spec in this change is approved. At R3 approved_spec_and_oracle reads the oracles too, and both " +
        "halves have to be decided before the first task run: approve the oracles next, then build."
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
function dryRunNextActionFor(
  unapproved: readonly string[],
  total: number,
  execution: { readonly ordered: boolean; readonly alreadyRan: boolean }
): ReturnType<typeof nextAction> {
  if (unapproved.length === 0) {
    if (execution.alreadyRan) {
      return nextAction(
        "legion ship",
        `All ${total} delta spec${total === 1 ? "" : "s"} in this change already carry a granted approval, and this ` +
          "change has already run; legion ship reports which gates that leaves unmet and why."
      );
    }
    if (execution.ordered) {
      return nextAction(
        "legion approve oracle --approver <id>",
        `All ${total} delta spec${total === 1 ? "" : "s"} in this change already carry a granted approval. At R3 ` +
          "approved_spec_and_oracle reads the oracles too, and both halves have to be decided before the first task run."
      );
    }
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
async function resolveSpecApprover(
  context: CliContext,
  subject: { readonly command: string; readonly decision: string } = {
    command: "legion approve spec",
    decision: "a delta spec"
  }
): Promise<SpecApproverDecision> {
  const raw = stringOption(context, "approver")?.trim();
  if (context.args.options.get("approver") === true || raw === "") {
    return {
      ok: false,
      result: usageError(`Missing required value for --approver. Example: ${subject.command} --approver dasbl.`)
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
              `${subject.command} records a human's decision about ${subject.decision}, so it requires --approver <id> ` +
              `naming a human decision owner recorded in ${PROJECT_MANIFEST_PATH}. ` +
              "No approver is inferred from the environment, from git config, or from a project having only one owner — " +
              "an approval recorded against a defaulted identity is not a human approval.",
            path: PROJECT_MANIFEST_PATH
          }
        ],
        nextAction(`${subject.command} --approver <id>`, `Recording a decision about ${subject.decision} requires a named human approver.`)
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
          `${subject.command} --approver <id>`,
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

/** What the approvals plane already records about one of the change's oracles. */
interface OracleState {
  readonly oracleId: string;
  readonly fact: ShipGateOracleFact;
  /** Which tasks are judged against it, for the sentence the operator reads. */
  readonly taskIds: readonly string[];
  readonly approvalId: ReturnType<typeof approvalIdForSubject>;
  readonly existing?: ApprovalSuccess;
  /**
   * Does the document on disk already satisfy the gate's oracle half for this
   * oracle — whoever granted it?
   *
   * `isLiveOracleGrant`, the gate's own predicate, imported rather than
   * restated. A writer whose idea of "done" is weaker than the reader's idea of
   * "satisfied" reports success, writes nothing, and leaves the change blocked
   * forever with no flag that would make it write.
   */
  readonly approved: boolean;
}

interface PlannedOracleApproval extends OracleState {
  readonly action: "grant" | "regrant" | "unchanged";
  readonly previousStatus?: Approval["status"];
}

/**
 * `legion approve oracle` — the decision `approved_spec_and_oracle` orders.
 *
 * An oracle states the criteria a task's work will be judged against.
 * `legion plan` writes one per executable acceptance criterion plus one covering
 * the manual ones, and until this release nothing anywhere recorded a human
 * agreeing to them — so ADR-006's R3 gate, whose whole question is whether the
 * spec and the oracle were approved *before* gated execution proceeded, fell
 * through `evaluateGate`'s `default:` arm and every R3 change was structurally
 * unshippable.
 *
 * Three things about this verb are deliberate and each closes a hole:
 *
 *  - **The subject set is the gate's, computed by the gate's own function.**
 *    `changeOracleDemand` is what the gate quantifies over — the oracles the
 *    change's *tasks name*, not the files its oracle directory happens to hold —
 *    and a writer walking its own set could approve an oracle the gate does not
 *    read or miss one it does. `legion approve surface` calls
 *    `changeVerificationSurfaces` for the same reason.
 *  - **The pin is `fact.reference`, copied whole.** That is the digest the
 *    artifact service hashed off the bytes in the read this decision is about,
 *    and it is one of the families `shipGatePinnedReferences` pre-resolves. The
 *    taskgraph carries a second, independently staleable copy of the same
 *    sha256; pinning that, or minting a third by hand, would answer `unverified`
 *    at ship time forever against a record this command reported as written.
 *  - **It warns when execution has already begun.** The "already approved"
 *    predicate deliberately excludes the ordering clause — including it would
 *    make a harmless rerun write a fresh `decidedAt` and make the ordering
 *    strictly worse — so a decision taken after a build succeeds here and can
 *    never satisfy the gate. Saying so at the one moment the operator could still
 *    act on it is what stops that from being the silent no-route-out loop PR 2
 *    closed for delta specs.
 */
async function approveOracles(context: CliContext): Promise<CliResult> {
  const oracleRaw = stringOption(context, "oracle")?.trim();
  if (context.args.options.get("oracle") === true || oracleRaw === "") {
    return usageError(
      "Missing required value for --oracle. Example: legion approve oracle --oracle orc_phase-1-c1."
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
    return blockedApprove(bundle.diagnostics, recoveryForDiscovery(bundle.diagnostics), {
      change: { changeId: latestChange.changeId }
    });
  }

  const taskgraph = await readTaskGraph({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });
  if (!taskgraph.ok) {
    return blockedApprove(
      taskgraph.diagnostics,
      nextAction(
        "legion plan 1",
        "Which oracles this change's work is judged against is recorded on its task contracts, and the task graph could not be read."
      ),
      { change: { changeId: latestChange.changeId } }
    );
  }

  const oracles = await loadOracleFacts({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });
  if (oracles === undefined) {
    // The deliberate divergence from `legion approve surface`, which ignores an
    // unreadable oracle because that state routes its operator somewhere else
    // entirely. Here the oracles *are* the subject: approving a subset of a set
    // that could not be established would write records for whichever documents
    // happened to read, which is the partial-plane fail-open one level up.
    return blockedApprove(
      [
        {
          code: "oracle_plane_unreadable",
          message:
            `The oracles of ${latestChange.changeId} could not be read as a complete set, so which criteria this ` +
            "change's work is judged against is unestablished. The manifest fails on any malformed oracle in the " +
            "directory; correct or remove it, then run this again.",
          path: `.legion/project/changes/${latestChange.changeId}/oracle`
        }
      ],
      // `legion ship`, not `legion dev change validate`.
      //
      // The first draft named the validate verb, and adversarial review measured
      // it: drop any unparseable `.yaml` under `oracle/` and `legion dev change
      // validate <changeId>` exits 0 with `{"ok":true,"diagnostics":[]}` on
      // exactly that repository, because it checks the bundle's schema rather
      // than the oracle plane. Being sent to a command that reports success on
      // the broken state ends the investigation at "nothing is wrong" — PR 4's
      // named defect, reproduced in this release's new command. `legion ship` is
      // the command that does see it: on the same repository it reports
      // `change_traceability_broken` naming the offending file by path, which is
      // the one fact this refusal cannot supply — the oracle manifest fails as a
      // whole and reports the directory.
      nextAction(
        "legion ship",
        "An oracle document in this change will not parse, and the manifest fails as a set, so this names the " +
          "directory rather than the file. legion ship reports change_traceability_broken naming the file itself; " +
          "correct or remove it, then run this again. Approving a subset of a set that cannot be established would " +
          "record a decision about criteria nobody can read."
      ),
      { change: { changeId: latestChange.changeId } }
    );
  }

  const demand = changeOracleDemand({
    tasks: taskgraph.document.tasks,
    taskIdFor: (task) => taskIdForContractId(task.id),
    change: {
      changeId: latestChange.changeId,
      acceptance: undefined,
      approvals: undefined,
      attestations: undefined,
      deltas: undefined,
      oracles,
      taskRuns: undefined,
      release: undefined,
      evaluatedAt: undefined,
      // Never consulted: `changeOracleDemand` resolves ids against documents and
      // asks nothing about disk. Supplied because the facts shape requires it,
      // and `unverified`/`unread` are the values that cannot be mistaken for a
      // check that passed.
      verifyPin: () => "unverified",
      classifySource: () => ({ kind: "unread", reason: "this command reads no attestation source" })
    }
  });

  const missing = demand.unresolved[0];
  if (missing !== undefined) {
    return blockedApprove(
      [
        {
          code: "oracle_not_in_change",
          message:
            `Task ${missing.taskId} is judged against oracle ${missing.oracleId}, and no such oracle document is in ` +
            `${latestChange.changeId}. Approving the oracles that are there would record a decision about a set this ` +
            "change cannot show you. Restore the missing oracle, or re-plan the work as a new change.",
          path: `.legion/project/changes/${latestChange.changeId}/oracle/${missing.oracleId}.yaml`
        }
      ],
      nextAction(
        "legion ship",
        "An oracle a task names is not on disk. legion ship names which gate that leaves unmet and why, which is a different repair from this one."
      ),
      { change: { changeId: latestChange.changeId } }
    );
  }

  if (demand.referenced.length === 0) {
    return blockedApprove(
      [
        {
          code: "no_referenced_oracle",
          message:
            `No task contract in ${latestChange.changeId} references an oracle, so there are no criteria to approve. ` +
            "legion plan writes one oracle per executable acceptance criterion and one covering the manual ones; a " +
            "change built from a legacy import or a hand-written task graph may reference none.",
          path: taskgraph.artifactPath
        }
      ],
      nextAction(
        "legion ship",
        "Nothing here can be approved. legion ship names which gate is unmet and why, which is a different repair from this one."
      ),
      { change: { changeId: latestChange.changeId } }
    );
  }

  // A `--oracle` naming nothing in the change is blocked rather than a usage
  // error, on `selectDeltas`' precedent: the argv is well formed, and what
  // refuses is the change's own contents.
  if (oracleRaw !== undefined && !demand.referenced.some((entry) => entry.oracleId === oracleRaw)) {
    return blockedApprove(
      [
        {
          code: "oracle_not_in_change",
          message:
            `--oracle ${oracleRaw} is not an oracle this change's tasks are judged against. ` +
            `They name: ${demand.referenced.map((entry) => entry.oracleId).join(", ")}. ` +
            "Approving an oracle Legion cannot show you would approve nothing.",
          path: taskgraph.artifactPath
        }
      ],
      nextAction("legion approve oracle --approver <id>", "Name an oracle this change's tasks actually reference."),
      { change: { changeId: latestChange.changeId } }
    );
  }

  // Resolved before the dry run returns, and before any approval is read: a dry
  // run that resolves nothing answers "yes" to `--approver dasbi`.
  const approver = await resolveSpecApprover(context, {
    command: "legion approve oracle",
    decision: "an oracle"
  });
  if (!approver.ok) return approver.result;

  // One instant for the whole run: the clock the gate's expiry comparison is
  // made against *and* the decision instant written into every approval this run
  // records. Two reads would let a grant be judged live against one moment and
  // dated at another.
  const decidedAt = currentUtcTimestamp();
  const selectedIds = new Set(
    demand.referenced
      .filter((entry) => oracleRaw === undefined || entry.oracleId === oracleRaw)
      .map((entry) => entry.oracleId)
  );

  const states: OracleState[] = [];
  for (const entry of demand.referenced) {
    const approvalId = approvalIdForSubject({
      changeId: bundle.bundle.change.id,
      action: ORACLE_APPROVE_ACTION,
      subject: { kind: "oracle", id: entry.oracleId }
    });
    const existing = await readApproval({
      repositoryRoot: context.repositoryRoot,
      changeId: bundle.bundle.change.id,
      approvalId
    });
    if (!existing.ok && existing.status !== "not_found") {
      // Blocking only for an oracle this run would write. Creating over an
      // unread existing approval is the one way to silently replace a revocation
      // with a fresh grant.
      if (selectedIds.has(entry.oracleId)) {
        return blockedApprove(
          existing.diagnostics,
          nextAction(
            "legion approve oracle",
            `An approval already exists for ${entry.oracleId} and could not be read. Correct it by hand, then run this again.`
          ),
          { change: { changeId: latestChange.changeId } }
        );
      }
      states.push({ oracleId: entry.oracleId, fact: entry.fact, taskIds: entry.taskIds, approvalId, approved: false });
      continue;
    }

    states.push({
      oracleId: entry.oracleId,
      fact: entry.fact,
      taskIds: entry.taskIds,
      approvalId,
      approved:
        existing.ok &&
        isLiveOracleGrant({
          approval: existing.document,
          changeId: bundle.bundle.change.id,
          oracle: entry.fact,
          evaluatedAt: decidedAt
        }),
      ...(existing.ok ? { existing } : {})
    });
  }

  const planned: PlannedOracleApproval[] = states
    .filter((state) => selectedIds.has(state.oracleId))
    .map((state) => ({ ...state, ...plannedActionFor(state, approver.approver) }));

  // Two different questions. A dry run writes nothing, so it reports the state
  // as it stands; the write path reports the state this run leaves behind.
  const unapprovedNow = states.filter((state) => !state.approved).map((state) => state.oracleId);
  const unapprovedAfter = states
    .filter((state) => !state.approved && !selectedIds.has(state.oracleId))
    .map((state) => state.oracleId);

  const ordered = derivesApprovalOrderingGate(taskgraph.document.tasks);
  const execution = await executionAlreadyStarted(context.repositoryRoot, latestChange.changeId);
  const executionWarnings = orderingWarnings({ changeId: latestChange.changeId, execution, ordered });
  const alreadyRan = executionWarnings.length > 0;

  if (hasFlag(context, "dry-run")) {
    const action = dryRunOracleNextAction(unapprovedNow, states.length, alreadyRan);
    return success(
      {
        ok: true,
        status: "ready",
        dryRun: true,
        change: { changeId: latestChange.changeId },
        approver: approver.approver,
        ...(executionWarnings.length === 0 ? {} : { warnings: executionWarnings }),
        // No `status` and no `decidedAt`: nothing was decided, and a dry-run
        // payload carrying them would read as a record of a decision to anything
        // parsing it.
        approvals: planned.map((entry) => ({
          oracleId: entry.oracleId,
          oraclePath: entry.fact.reference.path,
          taskIds: entry.taskIds,
          approvalId: entry.approvalId,
          pinned: entry.fact.reference,
          action: entry.action,
          ...(entry.previousStatus === undefined ? {} : { previousStatus: entry.previousStatus })
        })),
        unapproved: unapprovedNow,
        ...(demand.unreferenced.length === 0 ? {} : { unreferencedOracles: demand.unreferenced }),
        nextAction: action,
        diagnostics: []
      },
      [
        "Approve ready.",
        `Dry run: ${planned.length} oracle${planned.length === 1 ? "" : "s"} of ${latestChange.changeId}.`,
        ...planned.map((entry) => `  ${entry.action.padEnd(9)} ${entry.oracleId}  ${entry.fact.reference.path}`),
        `Approver: ${approver.approver.id} (${approver.approver.kind}).`,
        ...executionWarnings.map((warning) => `Warning: ${warning.message}`),
        "No approval was written.",
        renderNextAction(action)
      ].join("\n")
    );
  }

  const written: ApprovalSuccess[] = [];
  const superseded: ApprovalSuccess[] = [];
  for (const entry of planned) {
    if (entry.action === "unchanged") continue;

    const archived = await archiveWithdrawnDecision({
      repositoryRoot: context.repositoryRoot,
      existing: entry.existing,
      subject: entry.oracleId,
      action: ORACLE_APPROVE_ACTION,
      target: { kind: "oracle", id: entry.oracleId },
      command: "legion approve oracle",
      decidedAt
    });
    if (!archived.ok) {
      return blockedApprove(archived.diagnostics, archived.action, {
        change: { changeId: latestChange.changeId },
        approvals: written.map(approvalSummary)
      });
    }
    if (archived.record !== undefined) superseded.push(archived.record);

    const write = await writeApproval({
      repositoryRoot: context.repositoryRoot,
      expectedRevision: entry.existing === undefined ? 0 : entry.existing.revision.revision,
      baseGitSha: resolveBaseGitSha(context.repositoryRoot),
      document: oracleApproval({
        entry,
        projectId: bundle.bundle.change.projectId,
        changeId: bundle.bundle.change.id,
        approver: approver.approver,
        decidedAt,
        ...(archived.record === undefined ? {} : { superseding: archived.record })
      })
    });
    if (!write.ok) {
      return blockedApprove(
        write.diagnostics,
        nextAction(
          "legion approve oracle",
          "Some oracles were approved and one write failed. Rerunning re-decides only what is not already approved."
        ),
        {
          change: { changeId: latestChange.changeId },
          approvals: written.map(approvalSummary)
        }
      );
    }
    written.push(write);
  }

  const action = oracleNextActionFor(unapprovedAfter, states.length, alreadyRan);
  const decided = planned.filter((entry) => entry.action !== "unchanged").length;
  const warnings = [
    ...executionWarnings,
    ...superseded.map((record) => ({
      code: "withdrawn_approval_superseded",
      message:
        `${record.document.decidedBy?.id ?? "someone"} had recorded this approval as ${record.document.status}` +
        `${record.document.decisionReason === undefined ? "" : ` ("${record.document.decisionReason}")`}` +
        `, and this grant supersedes that decision. The withdrawal is preserved at ${record.artifactPath} ` +
        "and is the standing record of it; nothing was deleted.",
      path: record.artifactPath
    }))
  ];

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
          oracleId: entry.oracleId,
          oraclePath: entry.fact.reference.path,
          taskIds: entry.taskIds,
          approvalId: entry.approvalId,
          pinned: entry.fact.reference,
          action: entry.action,
          ...(entry.previousStatus === undefined ? {} : { previousStatus: entry.previousStatus }),
          artifactPath: record?.artifactPath ?? entry.existing?.artifactPath,
          status: "granted",
          decidedBy: record?.document.decidedBy ?? entry.existing?.document.decidedBy,
          decidedAt: record?.document.decidedAt ?? entry.existing?.document.decidedAt
        };
      }),
      // The field an obvious implementation omits: the gate is change-scoped and
      // satisfied only by full coverage, so approving one of three oracles
      // leaves ship blocked over two the operator never saw.
      unapproved: unapprovedAfter,
      // Reported and never approved. An oracle no task references proves nothing
      // about the criteria the work was judged against, and writing a governance
      // record for a decision nobody had to make is what `legion approve surface`
      // already refuses to do for an undrifted pin.
      ...(demand.unreferenced.length === 0 ? {} : { unreferencedOracles: demand.unreferenced }),
      nextAction: action,
      diagnostics: []
    },
    [
      decided === 0
        ? `Already approved: ${planned.length} oracle${planned.length === 1 ? "" : "s"} of ${latestChange.changeId}.`
        : `Approved ${decided} oracle${decided === 1 ? "" : "s"} for ${latestChange.changeId}.`,
      ...planned.map((entry) => `  ${entry.action.padEnd(9)} ${entry.oracleId}  ${entry.fact.reference.path}`),
      `Approver: ${approver.approver.id} (${approver.approver.kind}).`,
      ...warnings.map((warning) => `Warning: ${warning.message}`),
      renderNextAction(action)
    ].join("\n")
  );
}

/** What this change's records say about whether gated execution has begun. */
type ExecutionEvidence =
  | { readonly kind: "started"; readonly startedAt: string; readonly runId: string; readonly taskId: string }
  | { readonly kind: "contradicted"; readonly detail: string }
  | { readonly kind: "none" };

/**
 * Has gated execution for this change already begun?
 *
 * Read here, in a verb whose contract is otherwise "write a governance artifact
 * and nothing else", because the alternative is silence at the one moment the
 * operator could still act. `approved_spec_and_oracle` compares the last of these
 * decisions against `min(startedAt)`, and nothing re-orders a decision once
 * taken — so a run that already exists means this command will exit 0 and leave
 * ship blocked forever. That is the shape PR 2 closed for delta specs by making
 * the writer call the reader; here the writer *cannot* refuse (the record is
 * still a true governance fact, and refusing would leave no way to record one at
 * all), so it warns instead.
 *
 * `earliestExecutionRun` is the gate's own minimum rather than a second one. The
 * listing is read raw rather than through `completeTaskRuns`: a partial listing
 * makes the gate answer `unevaluable`, but for a *warning* any run that is
 * visible is enough, and a warning suppressed because one sibling file would not
 * parse is a warning that fails in the direction of silence.
 *
 * **The evidence index is read too, and that is a correction.** The first draft
 * read only the run plane, so `rm -rf .../runs/*` silenced this warning
 * completely: adversarial review built a change, emptied its run directory,
 * approved everything, rebuilt, and this command reported no warning at all —
 * because it was asking the same emptied directory the gate would later be misled
 * by. `taskRunPlaneContradictions` is `legion ship`'s own corroboration rule,
 * reused rather than paraphrased, so the warning fires whenever the change's other
 * records say execution happened and the run plane cannot show it.
 */
async function executionAlreadyStarted(repositoryRoot: string, changeId: string): Promise<ExecutionEvidence> {
  let listing;
  let index;
  try {
    listing = await listTaskRunsForChange({ repositoryRoot, changeId });
    index = await readEvidenceIndex({ repositoryRoot, changeId });
  } catch {
    return { kind: "none" };
  }
  if (!listing.ok) return { kind: "none" };

  const taskRuns = listing.taskRuns.map((run) => run.document);
  const earliest = earliestExecutionRun(taskRuns);
  if (earliest !== undefined) return { kind: "started", ...earliest };

  const entries = index !== undefined && index.ok ? index.document.entries : [];
  const contradictions = taskRunPlaneContradictions({ taskRuns, entries });
  if (contradictions.length > 0) return { kind: "contradicted", detail: contradictions.join(" ") };
  return { kind: "none" };
}

/**
 * The warning both approve verbs owe an R3 change whose work has already run.
 *
 * Shared, because the first draft carried it on `legion approve oracle` and not on
 * `legion approve spec`, and the two feed the *same* gate — so the operator
 * following ship's own advice to `legion approve spec` on an already-built R3
 * change got `status: "approved"`, `warnings: undefined`, and a gate that had
 * silently moved from `unevaluable` to permanently `unsatisfied`. Review
 * reproduced that end to end and it is the sharpest instance in this series of a
 * command exiting 0 while making the change strictly worse.
 *
 * Gated on the change deriving the gate at all. Only R3 does, and a warning that
 * an R2 operator can do nothing with — `approved_delta_spec` has no ordering
 * clause — is noise that teaches people to ignore the line that matters.
 */
function orderingWarnings(input: {
  readonly changeId: string;
  readonly execution: ExecutionEvidence;
  readonly ordered: boolean;
}) {
  if (!input.ordered) return [];
  const runs = `.legion/project/changes/${input.changeId}/runs`;
  if (input.execution.kind === "started") {
    return [
      {
        code: "approval_after_execution",
        message:
          `Gated execution for ${input.changeId} began at ${input.execution.startedAt} (run ${input.execution.runId} of ` +
          `${input.execution.taskId}). A decision recorded now is dated after it, and approved_spec_and_oracle compares ` +
          "those two instants: at R3 this change cannot satisfy that gate, and no command re-orders a decision " +
          "that has already been taken. Approving is still recorded — the governance fact is real — but plan the " +
          "remaining work as a new change if the gate has to pass.",
        path: runs
      }
    ];
  }
  if (input.execution.kind === "contradicted") {
    return [
      {
        code: "execution_record_incomplete",
        message:
          `${input.execution.detail} So this change's run directory cannot say when gated execution began, and ` +
          "approved_spec_and_oracle compares the last of these decisions against exactly that instant: it will report " +
          "unevaluable until the run records are restored, and a decision recorded now may already be later than the " +
          "work it claims to gate. Approving is still recorded — the governance fact is real.",
        path: runs
      }
    ];
  }
  return [];
}

/**
 * The oracle approval document, pinning the bytes of the oracle it is about.
 *
 * `artifacts` is `fact.reference` copied whole rather than a digest minted here.
 * `readOracleArtifact` hashes the file in the same read that produced the
 * document this decision is about, so the reference has already been established
 * against disk *by this same command*; hashing again would establish the same
 * fact twice. It is also the reference `shipGatePinnedReferences` pre-resolves,
 * and it must be that one and no other — an approval pinning any other path
 * answers `unverified` at ship time and pins the gate at `unevaluable` forever.
 *
 * `scope.targets` names the oracle itself, which is where this departs from
 * `legion approve surface`: `approvalTargetReferenceSchema` has had a
 * first-class `{kind: "oracle"}` member since the protocol was written, so no
 * `{kind: "change"}` fallback is needed and the gate can filter on an exact
 * target.
 *
 * `taskId` and `runId` are omitted even though an oracle is named by exactly one
 * task today. The decision is about the criteria, not about an execution — and
 * the gate refuses an approval carrying either, by name, because a document that
 * claims a task says something this act does not.
 */
function oracleApproval(input: {
  readonly entry: PlannedOracleApproval;
  readonly projectId: Parameters<typeof buildChangeIdempotencyKey>[0]["projectId"];
  readonly changeId: Parameters<typeof buildChangeIdempotencyKey>[0]["changeId"];
  readonly approver: Actor;
  readonly decidedAt: ReturnType<typeof currentUtcTimestamp>;
  /** The withdrawal this grant overrules, once it has been safely copied aside. */
  readonly superseding?: ApprovalSuccess;
}): Approval {
  const existing = input.entry.existing;
  const reference = input.entry.fact.reference;
  return {
    schemaVersion: LEGION_PROTOCOL_VERSION,
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
      action: ORACLE_APPROVE_ACTION,
      targets: [
        // Re-parsed rather than cast. `changeOracleDemand` types an oracle id as
        // a plain string, because `ship-gates.ts` deliberately keeps protocol
        // brands out of its fact shapes — and a cast here would put an
        // unvalidated string into `scope.targets`, where the gate's exact-target
        // filter is the only thing that stops one approval answering for
        // another.
        { kind: "oracle", id: oracleIdSchema.parse(input.entry.oracleId) },
        { kind: "change", id: input.changeId }
      ]
    },
    idempotencyKey: buildChangeIdempotencyKey({
      projectId: input.projectId,
      changeId: input.changeId,
      effectKind: ORACLE_APPROVE_ACTION,
      targetHash: reference.sha256
    }),
    artifacts: [reference],
    status: "granted",
    decidedBy: input.approver,
    decidedAt: input.decidedAt,
    decisionReason:
      `${input.approver.id} approved oracle ${input.entry.oracleId} at ${reference.sha256} via legion approve oracle. ` +
      `It states the criteria ${input.entry.taskIds.join(", ")} will be judged against.` +
      (input.superseding === undefined
        ? ""
        : ` This supersedes the ${input.superseding.document.status} decision recorded by ` +
          `${input.superseding.document.decidedBy?.id ?? "an unnamed decider"} at ${input.superseding.document.decidedAt}, preserved at ${input.superseding.artifactPath}.`)
  };
}

/**
 * Where the operator goes next after an oracle approval.
 *
 * `legion build` once nothing is left unapproved — but only while no run exists.
 * Once one does, the ordering this gate checks is already settled and advising a
 * build would route the operator past the only thing that could still be said
 * about it.
 */
function oracleNextActionFor(
  unapproved: readonly string[],
  total: number,
  executionStarted: boolean
): ReturnType<typeof nextAction> {
  if (unapproved.length > 0) {
    return nextAction(
      "legion approve oracle",
      `${unapproved.length} of ${total} oracles this change's tasks are judged against are still unapproved ` +
        `(${unapproved.join(", ")}); the approved_spec_and_oracle gate is satisfied only when every one of them carries ` +
        "a granted approval."
    );
  }
  if (executionStarted) {
    return nextAction(
      "legion ship",
      "Every oracle this change's tasks are judged against is approved, and this change has already run. " +
        "approved_spec_and_oracle compares the decision instants against the start of execution; legion ship reports " +
        "what that ordering leaves unmet."
    );
  }
  return nextAction(
    "legion build",
    "Every oracle this change's tasks are judged against is approved. Approve its delta specs too if you have not — " +
      "approved_spec_and_oracle reads both — and then build, which is what these decisions have to precede."
  );
}

function dryRunOracleNextAction(
  unapproved: readonly string[],
  total: number,
  executionStarted: boolean
): ReturnType<typeof nextAction> {
  if (unapproved.length === 0) {
    return nextAction(
      executionStarted ? "legion ship" : "legion build",
      `All ${total} oracle${total === 1 ? "" : "s"} this change's tasks are judged against already carry a granted ` +
        "approval, and this dry run found nothing left to decide."
    );
  }
  return nextAction(
    "legion approve oracle --approver <id>",
    `This was a dry run and no approval was written. ${unapproved.length} of ${total} oracles are unapproved ` +
      `(${unapproved.join(", ")}); the approved_spec_and_oracle gate stays unmet until this command is run without ` +
      "--dry-run."
  );
}

/**
 * The action a verification-surface re-affirmation carries.
 *
 * Spelled out here and in `ship-gates.ts` rather than shared, on
 * `DELTA_SPEC_APPROVE_ACTION`'s rule: the gate and the writer are two sides of a
 * contract, and a shared symbol would let a rename move both at once and leave
 * every approval already on disk unreadable by the gate that reads them.
 */
const SURFACE_REAFFIRM_ACTION = "verification.surface.reaffirm";

/** One pinned file of the change's declared verification surfaces. */
interface SurfacePinState {
  readonly path: string;
  /** The digests the declarations record for it, in declaration order. */
  readonly declared: readonly string[];
  /** Which surfaces pin it, for the sentence the operator reads. */
  readonly interfaces: readonly string[];
  /** What the file hashes to now, or `undefined` when it cannot be read. */
  readonly current?: string;
  readonly approvalId: ReturnType<typeof approvalIdForSubject>;
  readonly existing?: ApprovalSuccess;
  /**
   * Would the gate accept this pin as it stands?
   *
   * True when the bytes still match a declared digest, or when a live
   * re-affirmation already covers the bytes that are there. The second half is
   * computed through the gate's own predicate — see `isLiveSurfaceReaffirmation`
   * — rather than through a rule of this command's own.
   */
  readonly settled: boolean;
}

interface PlannedReaffirmation extends SurfacePinState {
  readonly action: "grant" | "regrant" | "unchanged";
  readonly previousStatus?: Approval["status"];
}

/**
 * `legion approve surface` — the way back from a legitimately edited pin.
 *
 * A verification surface pins the files that make it real, and `legion ship`
 * re-hashes them: edit one and `integration_or_real_interface_checks` reports
 * `unsatisfied`, which is exactly what the gate is for. What made that a defect
 * rather than a feature is that there was no way back. `surface.pinned` is
 * written once, by `buildRequirements`, whose only caller is `legion start
 * --finalize`; a second interview cannot finalize over the first
 * (`requirement_set_conflict`) and a finalized session cannot be aborted. So the
 * first byte changed in an integration harness — the honest maintenance the
 * whole declaration exists to encourage — permanently blocked every R2 change
 * tracing that requirement, with no command anywhere able to repair it.
 *
 * The repair is a decision, not a rewrite. Re-affirming a declaration after a
 * legitimate edit is the same kind of act as approving a delta spec: a named
 * human saying "yes, this still describes what I meant". So it writes the same
 * artifact under a different action, resolves `--approver` through the same
 * `resolveApprover`, and leaves the requirement, the task graph and the oracles
 * untouched — nothing is re-minted in place, and no command performs this
 * silently. A silent re-mint would launder an out-of-band edit into a
 * declaration, which is what PR 2 refused to do for delta specs.
 *
 * It is deliberately narrow. Only a pin that has actually drifted is offered:
 * re-affirming an unchanged file would write a governance record for a decision
 * nobody had to make, and `decidedAt` is what PR 5's ordering gate compares
 * against a run's start.
 */
async function approveVerificationSurfaces(context: CliContext): Promise<CliResult> {
  const pathRaw = stringOption(context, "path")?.trim();
  if (context.args.options.get("path") === true || pathRaw === "") {
    return usageError(
      "Missing required value for --path. Example: legion approve surface --path ops/compose.integration.yml."
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
    return blockedApprove(bundle.diagnostics, recoveryForDiscovery(bundle.diagnostics), {
      change: { changeId: latestChange.changeId }
    });
  }

  const taskgraph = await readTaskGraph({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });
  if (!taskgraph.ok) {
    return blockedApprove(
      taskgraph.diagnostics,
      nextAction(
        "legion plan 1",
        "A verification surface is declared on a task contract, and the task graph could not be read."
      ),
      { change: { changeId: latestChange.changeId } }
    );
  }

  // The same set `integration_or_real_interface_checks` quantifies over,
  // computed by the gate's own function rather than re-walked here. A writer
  // walking its own smaller set could re-affirm a pin the gate does not read, or
  // miss one it does — the writer/reader drift PR 2 closed for delta specs.
  const oracles = await loadOracleFacts({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });
  //
  // `unreadableOracles` is deliberately not consumed. An operator reaches this
  // command because `legion ship` reported a pin as drifted, and ship cannot
  // report drift over a plane it could not read — an unreadable oracle makes that
  // gate `unevaluable`, which routes somewhere else entirely. Refusing here on a
  // fact that cannot coexist with the state this command repairs would add a
  // branch no operator can be in.
  const { surfaces } = changeVerificationSurfaces({
    tasks: taskgraph.document.tasks,
    taskIdFor: (task) => taskIdForContractId(task.id),
    change: {
      changeId: latestChange.changeId,
      acceptance: undefined,
      approvals: undefined,
      attestations: undefined,
      deltas: undefined,
      oracles,
      taskRuns: undefined,
      release: undefined,
      evaluatedAt: undefined,
      // Never consulted: nothing below asks whether a *declared* pin still
      // matches through this verifier, because this command hashes the files
      // itself and compares against the declaration. Supplied because the facts
      // shape requires it, and answering `unverified`/`unread` are the values
      // that cannot be mistaken for a check that passed.
      verifyPin: () => "unverified",
      classifySource: () => ({ kind: "unread", reason: "this command reads no attestation source" })
    }
  });

  // Unit surfaces carry pins too, and the gate never checks them: its all-unit
  // branch is decided from the declarations rather than from disk. Offering to
  // re-affirm one would write a record no gate reads.
  const nonUnit = surfaces.filter((declared) => declared.surface.kind !== "unit");

  const declaredByPath = new Map<string, { declared: string[]; interfaces: string[] }>();
  for (const entry of nonUnit) {
    for (const pin of entry.surface.pinned) {
      const record = declaredByPath.get(pin.path) ?? { declared: [], interfaces: [] };
      if (!record.declared.includes(pin.sha256)) record.declared.push(pin.sha256);
      if (!record.interfaces.includes(entry.surface.interface)) record.interfaces.push(entry.surface.interface);
      declaredByPath.set(pin.path, record);
    }
  }

  if (declaredByPath.size === 0) {
    return blockedApprove(
      [
        {
          code: "no_declared_surface",
          message:
            `No task contract or oracle in ${latestChange.changeId} declares a verification surface beyond unit, so there is ` +
            "no pin to re-affirm. A surface is authored on an executable acceptance criterion at legion start --intake and " +
            "copied onto the plan; a change planned before this release, or from an interview that declined the question, " +
            "declares none.",
          path: taskgraph.artifactPath
        }
      ],
      nextAction(
        "legion ship",
        "Nothing here can be re-affirmed. legion ship names which gate is unmet and why, which is a different repair from this one."
      ),
      { change: { changeId: latestChange.changeId } }
    );
  }

  if (pathRaw !== undefined && !declaredByPath.has(pathRaw)) {
    return blockedApprove(
      [
        {
          code: "path_not_pinned",
          message:
            `--path ${pathRaw} is not pinned by any verification surface in this change. ` +
            `The pinned files are: ${[...declaredByPath.keys()].join(", ")}. ` +
            "Re-affirming a file no declaration names would record a decision nothing reads.",
          path: taskgraph.artifactPath
        }
      ],
      nextAction("legion approve surface --approver <id>", "Name a file one of this change's surfaces actually pins."),
      { change: { changeId: latestChange.changeId } }
    );
  }

  // Resolved before the dry run returns. A dry run exists to answer "will this
  // command line work", and one that resolved nothing answers yes to
  // `--approver dasbi`.
  const approver = await resolveSpecApprover(context, {
    command: "legion approve surface",
    decision: "a verification surface declaration"
  });
  if (!approver.ok) return approver.result;

  // One instant for the whole run: the clock a live grant's expiry is judged
  // against *and* the decision instant written into every approval this run
  // records. Two reads would let a grant be judged live at one moment and dated
  // at another.
  const decidedAt = currentUtcTimestamp();

  // Hashed once, through the resolver that minted the declaration and the one
  // that re-checks it at ship time. A bare readFile plus hashContent would mint
  // a pin for a path `resolvePinnedReferences` refuses — an NTFS
  // alternate-data-stream path, a case-folded alias, a symlink out of the
  // repository — and the gate would then answer `unverified` forever against a
  // record this command reported as written.
  const mintPin = await mintPinnedReferences({
    repositoryRoot: context.repositoryRoot,
    paths: [...declaredByPath.keys()]
  });

  const states: SurfacePinState[] = [];
  for (const [pinPath, record] of declaredByPath) {
    const minted = mintPin(pinPath);
    const approvalId = approvalIdForSubject({
      changeId: bundle.bundle.change.id,
      action: SURFACE_REAFFIRM_ACTION,
      subject: { kind: "surface", id: pinPath }
    });
    const existing = await readApproval({
      repositoryRoot: context.repositoryRoot,
      changeId: bundle.bundle.change.id,
      approvalId
    });
    if (!existing.ok && existing.status !== "not_found") {
      // Blocking only for a path this run would write. Creating over an unread
      // existing approval is the one way to silently replace a revocation with a
      // fresh grant, which is exactly what an audit trail must not permit.
      if (pathRaw === undefined || pathRaw === pinPath) {
        return blockedApprove(
          existing.diagnostics,
          nextAction(
            "legion approve surface",
            `A re-affirmation already exists for ${pinPath} and could not be read. Correct it by hand, then run this again.`
          ),
          { change: { changeId: latestChange.changeId } }
        );
      }
      states.push({
        path: pinPath,
        declared: record.declared,
        interfaces: record.interfaces,
        ...(minted === undefined ? {} : { current: minted.sha256 }),
        approvalId,
        settled: false
      });
      continue;
    }

    const current = minted?.sha256;
    const settled =
      current !== undefined &&
      (record.declared.includes(current) ||
        (existing.ok &&
          isLiveSurfaceReaffirmation({
            approval: existing.document,
            changeId: bundle.bundle.change.id,
            path: pinPath,
            currentSha256: current,
            evaluatedAt: decidedAt
          })));

    states.push({
      path: pinPath,
      declared: record.declared,
      interfaces: record.interfaces,
      ...(current === undefined ? {} : { current }),
      approvalId,
      settled,
      ...(existing.ok ? { existing } : {})
    });
  }

  const selected = states.filter((state) => pathRaw === undefined || state.path === pathRaw);

  // A file that cannot be hashed cannot be re-affirmed, and saying so beats
  // writing a record that pins nothing. It is also the one drift state the gate
  // deliberately does not offer this cure for: a `missing` pin is `unsatisfied`
  // with no re-affirmation branch, because no document this command could write
  // would answer it.
  const unreadable = selected.filter((state) => state.current === undefined);
  if (unreadable.length > 0) {
    return blockedApprove(
      unreadable.map((state) => ({
        code: "unreadable_surface_pin",
        message:
          `${state.path} is pinned by the ${state.interfaces.join(", ")} surface and no readable file is there, so there ` +
          "are no bytes to re-affirm. Restore the file, or re-plan the change from an interview that pins one that exists.",
        path: state.path
      })),
      nextAction(
        "legion approve surface --approver <id>",
        "A re-affirmation records the digest of the file on disk. A file that is not there has no digest."
      ),
      { change: { changeId: latestChange.changeId } }
    );
  }

  const planned: PlannedReaffirmation[] = selected
    .filter((state) => !state.settled)
    .map((state) => ({ ...state, ...plannedReaffirmationFor(state, approver.approver) }));

  // Two different questions, and answering both with one number is how the spec
  // path's dry run came to advise a build on a change where nothing was
  // approved. A dry run writes nothing, so it reports the state as it stands;
  // the write path reports the state this run leaves behind.
  const driftedNow = states.filter((state) => !state.settled).map((state) => state.path);
  const driftedAfter = states
    .filter((state) => !state.settled && !(pathRaw === undefined || state.path === pathRaw))
    .map((state) => state.path);

  if (hasFlag(context, "dry-run")) {
    const action = dryRunSurfaceNextAction(driftedNow);
    return success(
      {
        ok: true,
        status: "ready",
        dryRun: true,
        change: { changeId: latestChange.changeId },
        approver: approver.approver,
        // No `status` and no `decidedAt`: nothing was decided, and a dry-run
        // payload carrying them would read as a record of a decision to anything
        // parsing it.
        reaffirmations: planned.map((entry) => ({
          path: entry.path,
          interfaces: entry.interfaces,
          declaredSha256: entry.declared,
          currentSha256: entry.current,
          approvalId: entry.approvalId,
          action: entry.action,
          ...(entry.previousStatus === undefined ? {} : { previousStatus: entry.previousStatus })
        })),
        drifted: driftedNow,
        nextAction: action,
        diagnostics: []
      },
      [
        "Approve ready.",
        `Dry run: ${planned.length} verification surface pin${planned.length === 1 ? "" : "s"} of ${latestChange.changeId}.`,
        ...planned.map((entry) => `  ${entry.action.padEnd(9)} ${entry.path}  ${entry.interfaces.join(", ")}`),
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

    const archived = await archiveWithdrawnDecision({
      repositoryRoot: context.repositoryRoot,
      existing: entry.existing,
      subject: entry.path,
      action: SURFACE_REAFFIRM_ACTION,
      target: { kind: "surface", id: entry.path },
      command: "legion approve surface",
      decidedAt
    });
    if (!archived.ok) {
      return blockedApprove(archived.diagnostics, archived.action, {
        change: { changeId: latestChange.changeId },
        reaffirmations: written.map(approvalSummary)
      });
    }
    if (archived.record !== undefined) superseded.push(archived.record);

    const write = await writeApproval({
      repositoryRoot: context.repositoryRoot,
      expectedRevision: entry.existing === undefined ? 0 : entry.existing.revision.revision,
      baseGitSha: resolveBaseGitSha(context.repositoryRoot),
      document: surfaceReaffirmation({
        entry,
        projectId: bundle.bundle.change.projectId,
        changeId: bundle.bundle.change.id,
        approver: approver.approver,
        decidedAt,
        ...(archived.record === undefined ? {} : { superseding: archived.record })
      })
    });
    if (!write.ok) {
      return blockedApprove(
        write.diagnostics,
        nextAction(
          "legion approve surface",
          "Some pins were re-affirmed and one write failed. Rerunning re-decides only what is still drifted."
        ),
        {
          change: { changeId: latestChange.changeId },
          reaffirmations: written.map(approvalSummary)
        }
      );
    }
    written.push(write);
  }

  const action = surfaceNextAction(driftedAfter);
  const decided = planned.filter((entry) => entry.action !== "unchanged").length;
  const warnings = superseded.map((record) => ({
    code: "withdrawn_approval_superseded",
    message:
      `${record.document.decidedBy?.id ?? "someone"} had recorded this re-affirmation as ${record.document.status}` +
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
      reaffirmations: planned.map((entry) => {
        const record = written.find((candidate) => candidate.document.id === entry.approvalId);
        return {
          path: entry.path,
          interfaces: entry.interfaces,
          declaredSha256: entry.declared,
          currentSha256: entry.current,
          approvalId: entry.approvalId,
          action: entry.action,
          ...(entry.previousStatus === undefined ? {} : { previousStatus: entry.previousStatus }),
          artifactPath: record?.artifactPath ?? entry.existing?.artifactPath,
          status: "granted",
          decidedBy: record?.document.decidedBy ?? entry.existing?.document.decidedBy,
          decidedAt: record?.document.decidedAt ?? entry.existing?.document.decidedAt
        };
      }),
      // Pins this run leaves drifted, for the same reason `unapproved` exists on
      // the spec path: the gate reads every declaration in the change, so
      // re-affirming one of three leaves ship blocked over two the operator
      // never saw.
      drifted: driftedAfter,
      nextAction: action,
      diagnostics: []
    },
    [
      decided === 0
        ? `Nothing to re-affirm: every verification surface pin in ${latestChange.changeId} still matches what was declared or re-affirmed.`
        : `Re-affirmed ${decided} verification surface pin${decided === 1 ? "" : "s"} for ${latestChange.changeId}.`,
      ...planned.map((entry) => `  ${entry.action.padEnd(9)} ${entry.path}  ${entry.interfaces.join(", ")}`),
      `Approver: ${approver.approver.id} (${approver.approver.kind}).`,
      ...warnings.map((warning) => `Warning: ${warning.message}`),
      renderNextAction(action)
    ].join("\n")
  );
}

/**
 * What this run would do to one pinned file's re-affirmation.
 *
 * `plannedActionFor`'s rule, over a different subject. `state.settled` is the
 * gate's own predicate — `isLiveSurfaceReaffirmation` — rather than a paraphrase
 * of it, so this command cannot report "already re-affirmed" over a document the
 * gate rejects. That failure mode has a name in this file's history: a writer
 * whose idea of done is weaker than the reader's idea of satisfied leaves the
 * change permanently blocked with a command that exits 0.
 */
function plannedReaffirmationFor(
  state: SurfacePinState,
  approver: Actor
): { readonly action: PlannedReaffirmation["action"]; readonly previousStatus?: Approval["status"] } {
  const existing = state.existing;
  if (existing === undefined) return { action: "grant" };
  if (state.settled && existing.document.decidedBy?.id === approver.id) {
    return { action: "unchanged", previousStatus: existing.document.status };
  }
  return { action: "regrant", previousStatus: existing.document.status };
}

/**
 * The re-affirmation document, pinning the bytes the approver looked at.
 *
 * `artifacts` is the digest hashed off disk during *this* run, and that is what
 * stops the record being a blanket exemption. `legion ship` re-hashes it, so the
 * approval covers exactly one revision of the file: the next edit drifts again
 * and needs its own decision. An approval that named only the path would
 * permanently disable the pin check for that file, which is the fail-open the
 * whole declaration exists to prevent.
 *
 * `scope.targets` names the change rather than the file, because
 * `approvalTargetReferenceSchema` has no `surface` or `path` member and
 * inventing one would be a protocol change inside a diff about a gate. The path
 * is carried in `artifacts`, which is where the gate reads it and where it
 * belongs: `targets` names *what* was decided about by id, `artifacts` names the
 * content that was in front of the approver.
 *
 * No `taskId` and no `runId`. A pinned file is shared by every task whose
 * criterion declares it, so naming one would assert a pairing this decision does
 * not make.
 */
function surfaceReaffirmation(input: {
  readonly entry: PlannedReaffirmation;
  readonly projectId: Parameters<typeof buildChangeIdempotencyKey>[0]["projectId"];
  readonly changeId: Parameters<typeof buildChangeIdempotencyKey>[0]["changeId"];
  readonly approver: Actor;
  readonly decidedAt: ReturnType<typeof currentUtcTimestamp>;
  /** The withdrawal this grant overrules, once it has been safely copied aside. */
  readonly superseding?: ApprovalSuccess;
}): Approval {
  const existing = input.entry.existing;
  // Non-optional by the time this runs: every state with no digest was refused
  // by the `unreadable` branch above, which exists so this cast is a statement
  // about a checked precondition rather than a hope.
  const current = input.entry.current as string;
  return {
    schemaVersion: LEGION_PROTOCOL_VERSION,
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
      action: SURFACE_REAFFIRM_ACTION,
      targets: [{ kind: "change", id: input.changeId }]
    },
    idempotencyKey: buildChangeIdempotencyKey({
      projectId: input.projectId,
      changeId: input.changeId,
      effectKind: SURFACE_REAFFIRM_ACTION,
      targetHash: current as Parameters<typeof buildChangeIdempotencyKey>[0]["targetHash"]
    }),
    artifacts: [artifactReferenceSchema.parse({ path: input.entry.path, sha256: current })],
    status: "granted",
    decidedBy: input.approver,
    decidedAt: input.decidedAt,
    decisionReason:
      `${input.approver.id} re-affirmed the ${input.entry.interfaces.join(", ")} verification surface against ` +
      `${input.entry.path} at ${current} via legion approve surface. It was declared at ` +
      `${input.entry.declared.join(", ")}.` +
      (input.superseding === undefined
        ? ""
        : ` This supersedes the ${input.superseding.document.status} decision recorded by ` +
          `${input.superseding.document.decidedBy?.id ?? "an unnamed decider"} at ${input.superseding.document.decidedAt}, preserved at ${input.superseding.artifactPath}.`)
  };
}

/**
 * Where the operator goes after a run that re-affirmed what it could.
 *
 * `legion ship`, not `legion build`. Re-affirming changes no evidence: it
 * changes whether the gate believes a declaration it already had, and ship is
 * what re-reads it. Advising a build would be the "successful command routes you
 * past the thing you still have to do" defect the spec path recorded.
 */
function surfaceNextAction(drifted: readonly string[]): ReturnType<typeof nextAction> {
  if (drifted.length > 0) {
    return nextAction(
      "legion approve surface --approver <id>",
      `${drifted.length} pinned file${drifted.length === 1 ? "" : "s"} in this change ${drifted.length === 1 ? "is" : "are"} ` +
        `still drifted (${drifted.join(", ")}); integration_or_real_interface_checks stays unsatisfied until every one of ` +
        "them either matches its declaration or carries a re-affirmation."
    );
  }
  return nextAction(
    "legion ship",
    "Every verification surface pin in this change now matches what a human declared or re-affirmed; rerun the readiness gate."
  );
}

function dryRunSurfaceNextAction(drifted: readonly string[]): ReturnType<typeof nextAction> {
  if (drifted.length === 0) {
    return nextAction(
      "legion ship",
      "Every verification surface pin in this change already matches what was declared or re-affirmed, and this dry run found nothing to decide."
    );
  }
  return nextAction(
    "legion approve surface --approver <id>",
    `This was a dry run and no approval was written. ${drifted.length} pinned file${drifted.length === 1 ? "" : "s"} ` +
      `(${drifted.join(", ")}) ${drifted.length === 1 ? "is" : "are"} drifted; the gate stays unsatisfied until this command ` +
      "is run without --dry-run."
  );
}
