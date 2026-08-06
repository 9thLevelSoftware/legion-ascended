import {
  listTaskRunsForChange,
  loadChangeBundle,
  readAttestation,
  readEvidenceIndex,
  readTaskGraph,
  writeAttestation,
  type AttestationSuccess
} from "@legion/artifacts";
import {
  LEGION_PROTOCOL_VERSION,
  WAIVER_REASON_MIN_LENGTH,
  attestationKindSchema,
  attestationVerdictSchema,
  isSubstantiveWaiverReason,
  taskIdSchema,
  type Actor,
  type ArtifactReference,
  type Attestation,
  type AttestationKind,
  type AttestationVerdict
} from "@legion/protocol";

import {
  failure,
  hasFlag,
  helpResult,
  repeatedStringOptions,
  stringOption,
  success,
  usageError,
  type CliContext,
  type CliResult
} from "../../runtime.js";
import { describeDecisionOwners, resolveApprover, PROJECT_MANIFEST_PATH } from "../../workflow/approver.js";
import { currentUtcTimestamp, resolveBaseGitSha } from "../../workflow/change-input.js";
import { loadWorkflowProject } from "../../workflow/context.js";
import {
  classifyEvidenceSource,
  EVIDENCE_SOURCE_PRODUCERS,
  UNRECOGNISED_SOURCE_HINT,
  type EvidenceSourceVerdict
} from "../../workflow/evidence-sources.js";
import { mintPinnedReferences, resolvePinnedReferenceReader } from "../../workflow/pinned-references.js";
import { nextAction, renderDiagnostics, renderNextAction } from "../../workflow/render.js";
import { attestationIdForKind, taskIdForContractId } from "../../workflow/run-artifacts.js";
import {
  attestationEvidenceRule,
  earliestExecutionRun,
  isSatisfyingAttestation,
  ATTESTATION_GATE_KINDS,
  GATE_READ_ATTESTATION_KINDS
} from "../../workflow/ship-gates.js";
import { findLatestWorkflowChangeId } from "../../workflow/state.js";

const ATTEST_HELP = `legion attest <kind>

Record that a named human asserts specific hash-pinned files are this change's
evidence for one of the questions ADR-006 asks. This writes a governance artifact
and nothing else: it does not run a check, plan, build, review or ship.

Kinds:
  independent-baseline   A baseline the change's work was measured against.
  security-evaluation    A security evaluation of the change.
  e2e-evaluation         An end-to-end evaluation of the change.
  architecture-review    An architecture review of the change.
  rollback-evidence      Evidence that this change can be rolled back.
  forward-fix-evidence   Evidence that this change can be forward-fixed.
  release-observation    A release observation plan or record.

legion attest <kind> --attested-by <id> --verdict <verdict> --source <path>...
                     [--covers <taskId>...] [--statement <text>]
                     [--waiver-reason <text>] [--dry-run]

  --attested-by <id>    Required. A human decision owner recorded in
                        .legion/project/project.json. No attester is inferred
                        from the environment, from git config, or from a project
                        having only one owner.
  --verdict <v>         Required. pass | fail | unknown | not_applicable.
  --source <path>       Required, repeatable. A file in this repository whose
                        bytes the assertion is about. Every one is pinned by
                        content hash and legion ship re-hashes them.
  --covers <taskId>     Repeatable. Which of this change's tasks the assertion
                        speaks for. Omitted, every task of the change.
  --statement <text>    What is being asserted, in the attester's own words.
                        Required for --verdict pass on architecture-review, which
                        no report in this repository can evidence: there, the
                        sentence is the whole record.
  --waiver-reason <t>   Required for --verdict not_applicable, and refused for
                        every other verdict. At least 24 characters and more than
                        one word: a waiver is a reason a reviewer can disagree
                        with, which is a sentence rather than a token.
  --dry-run             Report what would be recorded and write nothing.

This is not a rubber stamp. For a source shape Legion recognises — the
threat-model report, the rollback-policy report, the A/B comparison — the file is
parsed and --verdict pass is refused when the report's own verdict is negative,
and a waiver is refused over a failing report of the very check being waived. A
shape Legion does not recognise cannot carry a pass either: a verdict it cannot
check is a rubber stamp. A rollback-policy report additionally has to be about
*this* repository: it records the tree it audited, and one taken in another
checkout is refused however green it is.

architecture-review is the one kind whose pass rests on a person rather than on a
report, because an architecture review is a competent judgement and no program
here emits one. Its pass therefore needs a human attester, hash-pinned sources
that are still what they were, none of them a red report, and an authored
--statement — and legion ship echoes every one of them as a
risk_gate_human_judgement warning, because nothing machine-checkable was read.

Examples:
  legion attest security-evaluation --attested-by dasbl --verdict pass \\
    --source docs/next/evidence/P13-T02/threat-model.json
  legion dev release rollback-verify --backup-manifest <path> \\
    --report docs/next/evidence/rollback-policy.json
  legion attest rollback-evidence --attested-by dasbl --verdict pass \\
    --source docs/next/evidence/rollback-policy.json
  legion attest independent-baseline --attested-by dasbl --verdict not_applicable \\
    --waiver-reason "No sealed baseline corpus covers this change's surface." \\
    --source docs/adr/ADR-006-risk-gates.md`;

const ATTESTATION_KINDS = attestationKindSchema.options as readonly AttestationKind[];
const ATTESTATION_VERDICTS = attestationVerdictSchema.options as readonly AttestationVerdict[];

// The waiver floor is `attestationSchema`'s own predicate, imported rather than
// restated: a command whose idea of an acceptable waiver is looser than the
// schema's reports success and writes nothing.

/**
 * `legion attest <kind>`, a flat verb rather than a subject tree.
 *
 * Four reasons, in the order they decide it. The kinds are already a closed
 * enum **in the protocol**, so the positional is validated by
 * `attestationKindSchema` rather than by a hand-written list — which is the
 * argument `legion approve`'s positional makes, with a validator instead of a
 * switch. Every kind takes the identical flag set, so `SUBJECT_OPTIONS`-style
 * cross-refusal machinery would ship with nothing to own; `legion approve` grew
 * that machinery as a defect fix for subjects that genuinely differ.
 * `declared-options.ts` is per-verb regardless, so a tree would buy no flag
 * isolation. And bare `legion attest` is a usage error listing the kinds rather
 * than a help screen, on `handleApproveWorkflow`'s rule: a host that mis-splits
 * its argv must not read a help screen as a completed attestation.
 */
export async function handleAttestWorkflow(context: CliContext): Promise<CliResult> {
  const kindRaw = context.args.positionals[0];
  if (hasFlag(context, "help") || kindRaw === "help") {
    return helpResult(ATTEST_HELP);
  }
  const supported = ATTESTATION_KINDS.join(", ");
  if (kindRaw === undefined) {
    return usageError(
      `legion attest requires a kind. Supported kinds: ${supported}. Example: legion attest security-evaluation --attested-by <id> --verdict pass --source <path>.`
    );
  }
  const parsedKind = attestationKindSchema.safeParse(kindRaw);
  if (!parsedKind.success) {
    return usageError(`Unknown attestation kind: legion attest ${kindRaw}. Supported kinds: ${supported}.`);
  }
  const attests = parsedKind.data;

  const verdictRaw = stringOption(context, "verdict")?.trim();
  if (context.args.options.get("verdict") === true || verdictRaw === "") {
    return usageError(
      `Missing required value for --verdict. Supported verdicts: ${ATTESTATION_VERDICTS.join(", ")}.`
    );
  }
  if (verdictRaw === undefined) {
    return usageError(
      `legion attest requires --verdict. Supported verdicts: ${ATTESTATION_VERDICTS.join(", ")}. ` +
        "There is no default: an attestation whose verdict Legion chose is not an assertion anybody made."
    );
  }
  const parsedVerdict = attestationVerdictSchema.safeParse(verdictRaw);
  if (!parsedVerdict.success) {
    return usageError(
      `Unknown verdict: --verdict ${verdictRaw}. Supported verdicts: ${ATTESTATION_VERDICTS.join(", ")}.`
    );
  }
  const verdict = parsedVerdict.data;

  const waiverReason = stringOption(context, "waiver-reason")?.trim();
  if (context.args.options.get("waiver-reason") === true) {
    return usageError("Missing required value for --waiver-reason.");
  }
  // Checked here as well as in the schema, because the schema's message names a
  // field and this one names the decision the operator is being asked to take.
  if (verdict === "not_applicable" && (waiverReason === undefined || !isSubstantiveWaiverReason(waiverReason))) {
    return blockedAttest(
      [
        {
          code: "waiver_requires_reason",
          message:
            "--verdict not_applicable requires --waiver-reason <text> of at least " +
            `${WAIVER_REASON_MIN_LENGTH} characters and more than one word. ADR-006 permits a waived gate only as an ` +
            "audited waiver: a named human, a recorded time, and a reason a reviewer can disagree with. A single " +
            "word is not a reason, however long the word is.",
          path: PROJECT_MANIFEST_PATH
        }
      ],
      nextAction(
        `legion attest ${attests} --verdict not_applicable --waiver-reason <text> --attested-by <id>`,
        "Say why this check does not apply to this change, in a sentence somebody could argue with."
      )
    );
  }
  if (verdict !== "not_applicable" && waiverReason !== undefined) {
    return usageError(
      `--waiver-reason is only meaningful with --verdict not_applicable; this run records --verdict ${verdict}. ` +
        "A waiver sentence attached to any other verdict reads as a waiver of that verdict."
    );
  }

  const sourcePaths = [...new Set(repeatedStringOptions(context, "source").map((value) => value.trim()))].filter(
    (value) => value.length > 0
  );
  if (context.args.options.get("source") === true || sourcePaths.length === 0) {
    return blockedAttest(
      [
        {
          code: "source_required",
          message:
            "legion attest requires at least one --source <path>. An attestation's whole content is that specific " +
            "bytes are this change's evidence, so a record citing nothing asserts a link to nothing — including a " +
            "waiver, which cites the decision record that supports it.",
          path: PROJECT_MANIFEST_PATH
        }
      ],
      nextAction(
        `legion attest ${attests} --attested-by <id> --verdict ${verdict} --source <path>`,
        "Name the file this assertion is about."
      )
    );
  }

  const latestChange = await findLatestWorkflowChangeId(context.repositoryRoot);
  if (!latestChange.ok) {
    return blockedAttest(
      latestChange.diagnostics,
      nextAction("legion plan 1", "Attesting requires a planned change.")
    );
  }

  const bundle = await loadChangeBundle({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });
  if (!bundle.ok) {
    return blockedAttest(
      bundle.diagnostics,
      nextAction("legion ship", "The change this attestation would be about could not be read; legion ship names why."),
      { change: { changeId: latestChange.changeId } }
    );
  }

  const taskgraph = await readTaskGraph({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId
  });
  if (!taskgraph.ok) {
    return blockedAttest(
      taskgraph.diagnostics,
      nextAction("legion plan 1", "An attestation names the tasks it covers, and the task graph could not be read."),
      { change: { changeId: latestChange.changeId } }
    );
  }
  const taskIds = taskgraph.document.tasks.map((task) => taskIdForContractId(task.id) as string);

  // Resolved before the dry run returns and before anything is read off the
  // attestation plane: a dry run that resolves nothing answers "yes" to a
  // mistyped identity, which is `legion approve`'s recorded fifth defect.
  const attester = await resolveAttester(context, attests);
  if (!attester.ok) return attester.result;

  const coversRaw = [...new Set(repeatedStringOptions(context, "covers").map((value) => value.trim()))].filter(
    (value) => value.length > 0
  );
  if (context.args.options.get("covers") === true) {
    return usageError("Missing required value for --covers. Example: --covers tsk_phase-1-c1.");
  }
  const unknownTask = coversRaw.find((value) => !taskIds.includes(value));
  if (unknownTask !== undefined) {
    return blockedAttest(
      [
        {
          code: "task_not_in_change",
          message:
            `--covers ${unknownTask} is not a task of ${latestChange.changeId}. Its tasks are: ${taskIds.join(", ")}. ` +
            "Claiming to cover a task Legion cannot show you covers nothing.",
          path: taskgraph.artifactPath
        }
      ],
      nextAction(`legion attest ${attests} --covers <taskId>`, "Name a task this change actually carries."),
      { change: { changeId: latestChange.changeId } }
    );
  }
  // Every task by default, because the gates quantify over every task of the
  // change that derives them. A per-task default would make the
  // successful-looking path the one that leaves ship blocked over a task the
  // operator never heard of, which is `legion approve spec --requirement`'s
  // recorded rule.
  const covers = coversRaw.length > 0 ? coversRaw : taskIds;
  if (covers.length === 0) {
    return blockedAttest(
      [
        {
          code: "change_has_no_tasks",
          message:
            `${latestChange.changeId} carries no task contracts, so there is nothing for an attestation to cover. ` +
            "Plan the change first; an attestation that covers nothing satisfies no gate.",
          path: taskgraph.artifactPath
        }
      ],
      nextAction("legion plan 1", "An attestation names the tasks it speaks for, and this change has none."),
      { change: { changeId: latestChange.changeId } }
    );
  }

  // Minted through the resolver ship will later verify with, never through a
  // bare readFile plus hashContent. `mintPinnedReferences`' own comment records
  // why: mint and verify must agree about which paths exist, or a pin is minted
  // for a path the verifier will never answer for and ship reports the
  // attestation's source as unchecked forever with nothing naming the cause.
  const mint = await mintPinnedReferences({ repositoryRoot: context.repositoryRoot, paths: sourcePaths });
  const sources: ArtifactReference[] = [];
  for (const sourcePath of sourcePaths) {
    const reference = mint(sourcePath);
    if (reference === undefined) {
      return blockedAttest(
        [
          {
            code: "source_unpinnable",
            message:
              `${sourcePath} could not be pinned, so nothing was written. A source is refused when it is absent, when ` +
              "it leaves the repository through a link, when it names an NTFS alternate data stream (a `:` in the " +
              "path), when it case-folds onto a differently-cased file, or when it is not a repository-relative " +
              "path. legion ship checks these pins through the same resolver, so a pin minted any other way would be " +
              "reported as unchecked forever.",
            path: sourcePath
          }
        ],
        nextAction(
          `legion attest ${attests} --source <path>`,
          "Name a repository-relative path to a readable file inside this repository."
        ),
        { change: { changeId: latestChange.changeId } }
      );
    }
    sources.push(reference);
  }

  // The digests are re-verified and the bytes are read in one pass, so what the
  // refusal below reads and what the pin records are the same state of the file.
  // A file edited between the mint and this read answers `drift` and is refused
  // rather than recorded, which is the one window a two-pass writer would leave.
  const pinned = await resolvePinnedReferenceReader({
    repositoryRoot: context.repositoryRoot,
    references: sources,
    retainContentFor: sourcePaths
  });
  const moved = sources.find((source) => pinned.verifyPin(source) !== "match");
  if (moved !== undefined) {
    return blockedAttest(
      [
        {
          code: "source_changed_while_reading",
          message:
            `${moved.path} changed while this command was reading it, so the digest it would have pinned and the ` +
            "contents this command checked describe two different states of the file. Nothing was written.",
          path: moved.path
        }
      ],
      nextAction(`legion attest ${attests}`, "Run this again once the file has stopped changing."),
      { change: { changeId: latestChange.changeId } }
    );
  }

  const classified = sources.map((source) => ({
    source,
    verdict: classifyEvidenceSource(pinned.contentOf(source), { repositoryRoot: context.repositoryRoot })
  }));
  const authoredStatement = stringOption(context, "statement")?.trim();
  const refusal = sourceRefusal({ attests, verdict, classified, authoredStatement });
  if (refusal !== undefined) {
    return blockedAttest(refusal.diagnostics, refusal.action, { change: { changeId: latestChange.changeId } });
  }

  const attestedAt = currentUtcTimestamp();
  const attestationId = attestationIdForKind({ changeId: bundle.bundle.change.id, attests });
  const existing = await readAttestation({
    repositoryRoot: context.repositoryRoot,
    changeId: bundle.bundle.change.id,
    attestationId
  });
  if (!existing.ok && existing.status !== "not_found") {
    return blockedAttest(
      existing.diagnostics,
      nextAction(
        `legion attest ${attests}`,
        `An attestation already exists for ${attests} on this change and could not be read. Writing over an ` +
          "unread record is the one way to silently replace a fail with a pass, so nothing was written. Correct it " +
          "by hand, then run this again."
      ),
      { change: { changeId: latestChange.changeId } }
    );
  }

  const statement =
    authoredStatement ||
    `${attester.attester.id} attests ${attests} for ${latestChange.changeId} as ${verdict} against ${sources.length} source${
      sources.length === 1 ? "" : "s"
    }: ${sources.map((source) => source.path).join(", ")}.`;

  const document = attestationDocument({
    attestationId,
    attests,
    verdict,
    projectId: bundle.bundle.change.projectId,
    changeId: bundle.bundle.change.id,
    attester: attester.attester,
    attestedAt,
    sources,
    covers,
    statement,
    ...(waiverReason === undefined ? {} : { waiverReason }),
    ...(existing.ok ? { existing } : {})
  });

  // The writer's "already recorded" question is the gate's own predicate, called
  // rather than paraphrased. PR 2's lesson: a writer whose idea of done is
  // weaker than the reader's idea of satisfied reports success, writes nothing,
  // and leaves the change blocked forever with no flag that would make it write.
  const gate = gateReading(attests);
  const alreadySatisfying =
    existing.ok &&
    gate !== undefined &&
    existing.document.attestedBy.id === attester.attester.id &&
    existing.document.verdict === verdict &&
    isSatisfyingAttestation({
      attestation: existing.document,
      gate: gate.gate,
      kinds: gate.kinds,
      changeId: bundle.bundle.change.id,
      tasks: taskgraph.document.tasks,
      taskIdFor: (task) => taskIdForContractId(task.id),
      verifyPin: pinned.verifyPin,
      classifySource: (reference) =>
        classifyEvidenceSource(pinned.contentOf(reference), { repositoryRoot: context.repositoryRoot })
    });
  const action: "record" | "re-record" | "unchanged" = existing.ok
    ? alreadySatisfying
      ? "unchanged"
      : "re-record"
    : "record";

  const warnings = await attestationWarnings({
    repositoryRoot: context.repositoryRoot,
    changeId: latestChange.changeId,
    attests,
    verdict,
    covers,
    taskIds,
    ...(existing.ok ? { previous: existing } : {})
  });

  if (hasFlag(context, "dry-run")) {
    const dryRunAction = nextAction(
      action === "unchanged" ? "legion ship" : `legion attest ${attests} --attested-by <id> --verdict ${verdict}`,
      action === "unchanged"
        ? `This change already carries a ${attests} attestation by ${attester.attester.id} that satisfies the gate reading it; this dry run found nothing to record.`
        : "This was a dry run and no attestation was written. The gate reading this kind stays unmet until this command is run without --dry-run."
    );
    return success(
      {
        ok: true,
        status: "ready",
        dryRun: true,
        change: { changeId: latestChange.changeId },
        attester: attester.attester,
        ...(warnings.length === 0 ? {} : { warnings }),
        attestation: {
          attestationId,
          attests,
          verdict,
          action,
          covers,
          sources,
          sourceShapes: classified.map((entry) => describeClassification(entry.verdict))
        },
        nextAction: dryRunAction,
        diagnostics: []
      },
      [
        "Attest ready.",
        `Dry run: ${action} ${attests} for ${latestChange.changeId} as ${verdict}.`,
        ...sources.map((source) => `  source  ${source.path}  ${source.sha256}`),
        `Attester: ${attester.attester.id} (${attester.attester.kind}).`,
        ...warnings.map((warning) => `Warning: ${warning.message}`),
        "No attestation was written.",
        renderNextAction(dryRunAction)
      ].join("\n")
    );
  }

  let written: AttestationSuccess | undefined;
  if (action !== "unchanged") {
    const write = await writeAttestation({
      repositoryRoot: context.repositoryRoot,
      expectedRevision: existing.ok ? existing.revision.revision : 0,
      baseGitSha: resolveBaseGitSha(context.repositoryRoot),
      document
    });
    if (!write.ok) {
      return blockedAttest(
        write.diagnostics,
        nextAction(`legion attest ${attests}`, "The attestation could not be written. Correct the reported problem, then run this again."),
        { change: { changeId: latestChange.changeId } }
      );
    }
    written = write;
  }

  const record = written ?? (existing.ok ? existing : undefined);
  const resultAction = nextAction(
    "legion ship",
    `The ${attests} attestation for ${latestChange.changeId} is recorded. legion ship re-hashes every file it cites ` +
      "and re-reads the report they hold, and reports which gates that leaves unmet."
  );
  return success(
    {
      ok: true,
      status: action === "unchanged" ? "unchanged" : "attested",
      change: { changeId: latestChange.changeId },
      attester: attester.attester,
      ...(warnings.length === 0 ? {} : { warnings }),
      attestation: {
        attestationId,
        attests,
        verdict,
        action,
        covers,
        sources,
        sourceShapes: classified.map((entry) => describeClassification(entry.verdict)),
        artifactPath: record?.artifactPath,
        attestedBy: record?.document.attestedBy,
        attestedAt: record?.document.attestedAt
      },
      nextAction: resultAction,
      diagnostics: []
    },
    [
      action === "unchanged"
        ? `Already attested: ${attests} for ${latestChange.changeId}.`
        : `Attested ${attests} for ${latestChange.changeId} as ${verdict}.`,
      ...sources.map((source) => `  source  ${source.path}  ${source.sha256}`),
      `Attester: ${attester.attester.id} (${attester.attester.kind}).`,
      ...warnings.map((warning) => `Warning: ${warning.message}`),
      renderNextAction(resultAction)
    ].join("\n")
  );
}

/** Which gate, if any, reads this kind — and every kind that gate accepts. */
function gateReading(
  attests: AttestationKind
): { readonly gate: keyof typeof ATTESTATION_GATE_KINDS; readonly kinds: readonly AttestationKind[] } | undefined {
  for (const [gate, kinds] of Object.entries(ATTESTATION_GATE_KINDS)) {
    if ((kinds ?? []).includes(attests)) {
      return { gate: gate as keyof typeof ATTESTATION_GATE_KINDS, kinds: kinds as readonly AttestationKind[] };
    }
  }
  return undefined;
}

function describeClassification(verdict: EvidenceSourceVerdict): string {
  if (verdict.kind === "clean") return `${verdict.shape} (clean)`;
  if (verdict.kind === "blocking") return `${verdict.shape} (blocking)`;
  if (verdict.kind === "unrecognised") return "unrecognised";
  return "unread";
}

/**
 * The refusals that make this verb something other than a rubber stamp.
 *
 * Every one is a **positive** requirement rather than a negative filter: a
 * `pass` has to point at a report this command can read a green verdict out of,
 * and every shape that is not that — blocking, unrecognised, unreadable, or
 * recognised-but-never-evidence-of-a-pass — falls out of the arm rather than
 * into it. Lesson 4, in the place a rubber stamp would live.
 */
function sourceRefusal(input: {
  readonly attests: AttestationKind;
  readonly verdict: AttestationVerdict;
  readonly classified: readonly { readonly source: ArtifactReference; readonly verdict: EvidenceSourceVerdict }[];
  /**
   * `--statement` as the operator typed it, before the synthesised fallback.
   *
   * Passed in rather than re-read here, because the distinction this refusal
   * turns on — did a person write this sentence — is destroyed by the `||`
   * fallback and is only visible on the raw option.
   */
  readonly authoredStatement: string | undefined;
}):
  | { readonly diagnostics: readonly unknown[]; readonly action: ReturnType<typeof nextAction> }
  | undefined {
  if (input.verdict === "fail" || input.verdict === "unknown") return undefined;

  // A red report contradicts a pass and a waiver alike, and the waiver case is
  // the worse of the two: waiving a check that ran and failed converts a
  // negative result into a satisfied gate with no evidence in between.
  const blocking = input.classified.find((entry) => entry.verdict.kind === "blocking");
  if (blocking !== undefined && blocking.verdict.kind === "blocking") {
    const producer = EVIDENCE_SOURCE_PRODUCERS[blocking.verdict.shape];
    return {
      diagnostics: [
        {
          code:
            input.verdict === "not_applicable"
              ? "waiver_contradicted_by_source"
              : "source_contradicts_verdict",
          message:
            `--verdict ${input.verdict} is refused. ${blocking.source.path} is a ${blocking.verdict.shape} report ` +
            `(${producer}) and it is negative by its own rule: ${blocking.verdict.reason}. ` +
            (input.verdict === "not_applicable"
              ? "A waiver states that a check does not apply to this change; this file is a report OF that check, and " +
                "it is failing. Waiving a check that ran and failed is the one thing an audited waiver must not be " +
                "able to do. Record --verdict fail, or waive against a document that supports the claim that the " +
                "check does not apply."
              : "Recording a pass over it would put a governance record on top of evidence that says the opposite, and " +
                "legion ship re-reads this file — the attestation would be written and then contradicted by the gate " +
                "it was written for. Re-run the check until it passes, or record what this file actually says with " +
                "--verdict fail."),
          path: blocking.source.path
        }
      ],
      action: nextAction(
        producer,
        "The cited report is red. Attesting cannot make it green; producing a green report can."
      )
    };
  }

  if (input.verdict === "not_applicable") return undefined;

  const rule = attestationEvidenceRule(input.attests);
  if (rule.kind === "human-judgement") {
    // The one refusal this arm keeps, and it is a **writer-only floor**. A pass
    // on a kind no report in this repository can evidence is a sentence somebody
    // wrote, so there has to be a sentence somebody wrote: `--statement` is
    // synthesised when it is omitted, and the synthesised one is long enough and
    // wordy enough that a substantiveness check at the *reader* would be
    // vacuously satisfied by it. So the floor lives here, where the difference is
    // still visible, and the residual is stated rather than described as a check:
    // a hand-written attestation file bypasses it, exactly as a hand-written
    // waiver bypasses `--waiver-reason`'s.
    if (input.authoredStatement === undefined || !isSubstantiveWaiverReason(input.authoredStatement)) {
      return {
        diagnostics: [
          {
            code: "judgement_requires_statement",
            message:
              `--verdict pass for ${input.attests} requires --statement <text> of at least ` +
              `${WAIVER_REASON_MIN_LENGTH} characters and more than one word. No report shape in this repository ` +
              "states a verdict for this question and none is expected to — it asks for a competent person's " +
              "judgement rather than a program's output — so the record's whole content is what the attester says " +
              "about it. A pass carrying a statement Legion wrote for you asserts nothing anybody said. The floor is " +
              "the audited waiver's, for the audited waiver's reason.",
            path: input.classified[0]?.source.path ?? PROJECT_MANIFEST_PATH
          }
        ],
        action: nextAction(
          `legion attest ${input.attests} --verdict pass --attested-by <id> --statement <text> --source <path>`,
          "Say what was reviewed and what it concluded, in a sentence somebody could disagree with."
        )
      };
    }
    return undefined;
  }
  if (rule.kind === "none") {
    return {
      diagnostics: [
        {
          code: "kind_has_no_evidence_shape",
          message:
            `--verdict pass is refused for ${input.attests}. No report shape in this repository can evidence it, so ` +
            "there is nothing legion attest could check the claim against, and a verdict it cannot check is a rubber " +
            `stamp. ${UNRECOGNISED_SOURCE_HINT} Record the citation without asserting it passed, with --verdict ` +
            "unknown, or — if the check does not apply to this change — as an audited waiver with --verdict " +
            "not_applicable --waiver-reason <text>.",
          path: input.classified[0]?.source.path ?? PROJECT_MANIFEST_PATH
        }
      ],
      action: nextAction(
        `legion attest ${input.attests} --verdict unknown --attested-by <id> --source <path>`,
        "Record the citation as an unproven assertion rather than as a pass Legion cannot check."
      )
    };
  }

  const admissible = rule.shapes;
  const admitted = new Set<string>(admissible);
  const evidencing = input.classified.filter(
    (entry) => entry.verdict.kind === "clean" && admitted.has(entry.verdict.shape)
  );
  if (evidencing.length === 0) {
    const shapes = input.classified.map((entry) => `${entry.source.path}: ${describeClassification(entry.verdict)}`);
    return {
      diagnostics: [
        {
          code: "source_shape_not_admissible",
          message:
            `--verdict pass for ${input.attests} needs at least one source that is a ${admissible.join(" or ")} ` +
            `report Legion can read a verdict out of. Of the ${input.classified.length} file${
              input.classified.length === 1 ? "" : "s"
            } named, none is (${shapes.join("; ")}). A hash pin proves which bytes you meant; it does not prove what ` +
            `they say. ${UNRECOGNISED_SOURCE_HINT}`,
          path: input.classified[0]?.source.path ?? PROJECT_MANIFEST_PATH
        }
      ],
      action: nextAction(
        `legion attest ${input.attests} --verdict unknown --attested-by <id> --source <path>`,
        "Cite a report Legion recognises, or record the citation as unknown rather than as a pass."
      )
    };
  }

  return undefined;
}

/**
 * Everything the operator has to learn at the one moment they could still act.
 *
 * The ordering warning is `legion approve`'s `approval_after_execution` applied
 * to the one attestation kind that carries an ordering rule, and it exists for
 * the same reason: the "already recorded" predicate deliberately excludes the
 * ordering clause — carrying it would make a harmless rerun write a fresh
 * `attestedAt` and make the gate strictly worse — so a baseline recorded after a
 * build succeeds here and can never satisfy the gate on the pass arm.
 */
async function attestationWarnings(input: {
  readonly repositoryRoot: string;
  readonly changeId: string;
  readonly attests: AttestationKind;
  readonly verdict: AttestationVerdict;
  readonly covers: readonly string[];
  readonly taskIds: readonly string[];
  readonly previous?: AttestationSuccess;
}): Promise<readonly { readonly code: string; readonly message: string; readonly path?: string }[]> {
  const warnings: { code: string; message: string; path?: string }[] = [];

  if (!GATE_READ_ATTESTATION_KINDS.has(input.attests)) {
    // Accepted and written, never refused. Refusing would make a true governance
    // fact unrecordable and force the release that adds the gate to ship the CLI
    // plumbing alongside it. Succeeding in silence would be worse: the operator
    // would see `status: "attested"` and believe a gate had moved. The set is
    // the gate module's own, so this sentence cannot go stale — the release that
    // adds the reader deletes the warning by adding one line there.
    warnings.push({
      code: "attestation_kind_has_no_reader",
      message:
        `No ship gate reads attests: "${input.attests}" yet, so this record does not move any gate. It is a true ` +
        "governance fact and is preserved; it is not yet an input to any verdict."
    });
  }

  // Every verdict, not only `pass`, and that breadth is deliberate. The rule the
  // warning is about — `attestedAt < executionStartedAt` — closes the evidence
  // arm of `independent_baseline` for this change permanently once a run exists,
  // and the operator needs to know that whether they are recording a pass they
  // hoped would satisfy it, an `unknown`, or the waiver they reached for because
  // it could not. Narrowed to `pass` it would be a warning with no reachable
  // path in this repository at all: the pass arm additionally requires an A/B
  // comparison with a populated baseline side, which the committed corpus cannot
  // produce for a change, so the refusal would fire first every time and the
  // warning would be dead code wearing the name of a safeguard.
  if (input.attests === "independent-baseline") {
    const earliest = await earliestRun(input.repositoryRoot, input.changeId);
    if (earliest !== undefined) {
      warnings.push({
        code: "attestation_after_execution",
        message:
          `Gated execution for ${input.changeId} began at ${earliest.startedAt} (run ${earliest.runId} of ` +
          `${earliest.taskId}). A baseline recorded now is dated after it, and independent_baseline compares those ` +
          "two instants: this change can no longer satisfy that gate on the evidence arm, and no command re-dates an " +
          "attestation — attesting again writes a later instant and makes it strictly worse. The record is still " +
          "written, because the governance fact is real. Plan the remaining work as a new change and attest its " +
          "baseline before building it if the gate has to pass on evidence; an audited waiver is the only route out " +
          "for this one.",
        path: `.legion/project/changes/${input.changeId}/runs`
      });
    }
  }

  const uncovered = input.taskIds.filter((taskId) => !input.covers.includes(taskId));
  if (uncovered.length > 0) {
    warnings.push({
      code: "attestation_partial_coverage",
      message:
        `This attestation covers ${input.covers.length} of ${input.taskIds.length} tasks and leaves ` +
        `${uncovered.join(", ")} uncovered. The gate reading this kind quantifies over every task of the change that ` +
        "derives it, so ship will report it unsatisfied while any of those is missing.",
      path: `.legion/project/changes/${input.changeId}/taskgraph.json`
    });
  }

  const previous = input.previous;
  if (previous !== undefined && previous.document.verdict !== input.verdict) {
    warnings.push({
      code: "attestation_verdict_superseded",
      message:
        `${previous.document.attestedBy.id} had recorded this as "${previous.document.verdict}" at ` +
        `${previous.document.attestedAt} ("${previous.document.statement}"), and this run replaces it with ` +
        `"${input.verdict}". Legion keeps one attestation per change per kind, so the previous verdict is superseded ` +
        "rather than kept beside this one; its bytes remain in the artifact's revision chain.",
      path: previous.artifactPath
    });
  }

  return warnings;
}

/** The earliest run start this change records, read raw. */
async function earliestRun(
  repositoryRoot: string,
  changeId: string
): Promise<{ readonly startedAt: string; readonly runId: string; readonly taskId: string } | undefined> {
  try {
    const listing = await listTaskRunsForChange({ repositoryRoot, changeId });
    if (!listing.ok) return undefined;
    // Read raw rather than through `completeTaskRuns`, on
    // `executionAlreadyStarted`'s rule: a partial listing makes the *gate*
    // answer `unevaluable`, but for a warning any run that is visible is enough,
    // and a warning suppressed because one sibling file would not parse is a
    // warning that fails in the direction of silence.
    const earliest = earliestExecutionRun(listing.taskRuns.map((run) => run.document));
    if (earliest !== undefined) return earliest;
    // The evidence index is consulted too, so emptying `runs/` does not silence
    // this: `legion ship`'s own corroboration rule would still refuse to answer
    // from what is left.
    const index = await readEvidenceIndex({ repositoryRoot, changeId });
    if (index.ok && index.document.entries.length > 0) {
      const created = index.document.entries
        .map((entry) => entry.evidence.createdAt as string | undefined)
        .filter((value): value is string => value !== undefined)
        .sort()[0];
      if (created !== undefined) {
        return { startedAt: created, runId: "an unnamed run", taskId: "an unnamed task" };
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function attestationDocument(input: {
  readonly attestationId: ReturnType<typeof attestationIdForKind>;
  readonly attests: AttestationKind;
  readonly verdict: AttestationVerdict;
  readonly projectId: Attestation["projectId"];
  readonly changeId: Attestation["changeId"];
  readonly attester: Actor;
  readonly attestedAt: ReturnType<typeof currentUtcTimestamp>;
  readonly sources: readonly ArtifactReference[];
  readonly covers: readonly string[];
  readonly statement: string;
  readonly waiverReason?: string;
  readonly existing?: AttestationSuccess;
}): Attestation {
  const existing = input.existing;
  return {
    schemaVersion: LEGION_PROTOCOL_VERSION,
    // `createdAt` is the instant the record first existed and survives every
    // re-attestation, so the listing's sort order does not move when an
    // assertion is retaken. `attestedAt` is the instant of *this* assertion.
    createdAt: existing === undefined ? input.attestedAt : existing.document.createdAt,
    updatedAt: input.attestedAt,
    kind: "attestation",
    id: input.attestationId,
    projectId: input.projectId,
    changeId: input.changeId,
    attests: input.attests,
    verdict: input.verdict,
    attestedBy: input.attester,
    attestedAt: input.attestedAt,
    sources: [...input.sources],
    // Re-parsed rather than cast: `taskIdForContractId` returns a branded id but
    // `--covers` values come from argv, and a cast would put an unvalidated
    // string where the gate's set comparison is the only thing that stops one
    // attestation answering for a task it never named.
    covers: input.covers.map((taskId) => ({ kind: "task" as const, id: taskIdSchema.parse(taskId) })),
    statement: input.statement,
    ...(input.waiverReason === undefined ? {} : { waiverReason: input.waiverReason })
  };
}

type AttesterDecision =
  | { readonly ok: true; readonly attester: Actor }
  | { readonly ok: false; readonly result: CliResult };

/**
 * Turn `--attested-by <id>` into an actor, and refuse when it is absent.
 *
 * `resolveApprover`, reused unchanged, for the reason `legion approve` records:
 * a second identity rule is a second thing to get wrong, and the first already
 * refuses an unknown id, an ambiguous one and a non-human owner by name. No
 * environment variable, no git config, no "the project has one owner so it must
 * be them".
 *
 * A consequence worth stating: `legion attest` therefore only ever writes
 * `attestedBy.kind === "human"`. `actorSchema` admits worker, system, runtime
 * and tool because a later collector may legitimately write a `system` attester
 * through the service directly; this verb records a human act, which is the
 * whole of what makes the re-keying auditable.
 */
async function resolveAttester(context: CliContext, attests: AttestationKind): Promise<AttesterDecision> {
  const raw = stringOption(context, "attested-by")?.trim();
  if (context.args.options.get("attested-by") === true || raw === "") {
    return {
      ok: false,
      result: usageError(`Missing required value for --attested-by. Example: legion attest ${attests} --attested-by dasbl.`)
    };
  }
  if (raw === undefined) {
    return {
      ok: false,
      result: blockedAttest(
        [
          {
            code: "attester_required",
            message:
              `legion attest records a named human's assertion about ${attests}, so it requires --attested-by <id> ` +
              `naming a human decision owner recorded in ${PROJECT_MANIFEST_PATH}. No attester is inferred from the ` +
              "environment, from git config, or from a project having only one owner — an attestation recorded " +
              "against a defaulted identity is exactly the inference this artifact exists to replace.",
            path: PROJECT_MANIFEST_PATH
          }
        ],
        nextAction(`legion attest ${attests} --attested-by <id>`, "Recording an assertion requires a named human.")
      )
    };
  }

  const project = await loadWorkflowProject(context);
  if (!project.ok) {
    return {
      ok: false,
      result: blockedAttest(
        project.diagnostics,
        nextAction("legion start", "The project manifest records who may decide, and it could not be read.")
      )
    };
  }

  const owners = project.loaded.project.policy.decisionOwners;
  const resolved = resolveApprover({ raw, decisionOwners: owners });
  if (!resolved.ok) {
    return {
      ok: false,
      result: blockedAttest(
        resolved.diagnostics,
        nextAction(
          `legion attest ${attests} --attested-by <id>`,
          `Name a human decision owner recorded in ${PROJECT_MANIFEST_PATH}. Recorded owners: ${describeDecisionOwners(owners)}.`
        )
      )
    };
  }

  return { ok: true, attester: resolved.approver };
}

function blockedAttest(
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
    ["Attest blocked.", renderDiagnostics(diagnostics), renderNextAction(action)].join("\n")
  );
}
