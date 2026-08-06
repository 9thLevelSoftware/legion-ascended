import { createHash } from "node:crypto";
import path from "node:path";

import {
  artifactPathSchema,
  formatEntityId,
  type ApprovalId,
  type ArtifactPath,
  type AttestationId,
  type ChangeId,
  type ContractId,
  type EvidenceId,
  type ReleaseId,
  type ReviewId,
  type RunId,
  type TaskId
} from "@legion/protocol";

const ENTITY_SUFFIX_MAX_LENGTH = 64;
const DERIVED_ID_HASH_LENGTH = 12;

export function taskIdForContractId(contractId: ContractId): TaskId {
  return formatEntityId("task", contractId.slice("ctr_".length));
}

export function runIdForTask(input: {
  readonly taskId: TaskId;
  readonly attempt: number;
}): RunId {
  return formatEntityId("run", derivedSuffix(input.taskId.slice("tsk_".length), `-attempt-${input.attempt}`));
}

export function evidenceIdForRun(runId: RunId): EvidenceId {
  return formatEntityId("evidence", runId.slice("run_".length));
}

export function reviewIdForChange(input: {
  readonly changeId: ChangeId;
  readonly sequence: number;
}): ReviewId {
  return formatEntityId("review", derivedSuffix(input.changeId.slice("chg_".length), `-review-${input.sequence}`));
}

/**
 * The approval id for one decision about one subject.
 *
 * The id is a function of *what is being approved* — the change, the action, and
 * the one thing the action is about — and of nothing else. That is what makes an
 * approval's whole lifecycle live at one path: re-deciding rewrites the same
 * document at the next revision, so a grant and its later revocation are the
 * same bytes and cannot be separated.
 *
 * Both obvious alternatives put the negative fact in a file that can go missing
 * independently of the positive one, which is a fail-open produced by the
 * storage model rather than by a mistake:
 *
 *  - A sequence tail (`-approval-<n>`, the `reviewIdForChange` idiom) mints a
 *    new file every time. Reviews accumulate, so that is right for reviews; a
 *    decision is re-made rather than accumulated, and a second accept would
 *    leave the first grant on disk with no reader and no revocation.
 *  - A tail derived from the *review* being accepted has the same shape one
 *    level down: every review cycle is a new review, so cycle 2's approval is a
 *    new file and cycle 1's grant survives it. A gate asking "is a granted
 *    review-acceptance approval recorded here" then answers yes from a record
 *    nobody has looked at since.
 *
 * The tail is a digest rather than the readable subject, for a concrete reason:
 * `derivedSuffix` keeps the tail intact and only shortens the base, so a
 * readable tail like `-workflow-review-accept-tsk-...` pushes the reserved
 * length past 64 and throws. `-approval-<12 hex>` is 22 characters and cannot.
 * The readable discriminators live inside the document, in `scope.action` and
 * `scope.targets`, where a reader can see them.
 */
export function approvalIdForSubject(input: {
  readonly changeId: ChangeId;
  readonly action: string;
  readonly subject: { readonly kind: string; readonly id: string };
}): ApprovalId {
  const digest = createHash("sha256")
    .update(`${input.action}\n${input.subject.kind}\n${input.subject.id}`)
    .digest("hex")
    .slice(0, DERIVED_ID_HASH_LENGTH);
  return formatEntityId(
    "approval",
    derivedSuffix(input.changeId.slice("chg_".length), `-approval-${digest}`)
  ) as ApprovalId;
}

/**
 * The attestation id for one kind of assertion about one change.
 *
 * Identity is `(changeId, attests)` and nothing else, so a change carries **at
 * most one attestation of each kind** and re-attesting rewrites the same path at
 * the next revision. Three things are deliberately *not* in it, and each
 * omission is a fail-open closed:
 *
 *  - **Not the attester.** Two people attesting the same kind would otherwise be
 *    two files, and every gate here asks an existential — so the favourable
 *    record would win and the unfavourable one would sit beside it unread.
 *  - **Not the sources.** A re-attestation over fresh evidence would otherwise
 *    coexist with the record it was meant to withdraw.
 *  - **Not a sequence tail.** `reviewIdForChange`'s idiom is right for reviews,
 *    which accumulate; an assertion is retaken rather than accumulated, and a
 *    second `pass` would leave the first on disk with no reader.
 *
 * The tail is **readable** where `approvalIdForSubject`'s is a digest, and the
 * divergence is a budget fact rather than a taste one. `derivedSuffix` reserves
 * `tail.length + 13`, so an approval's unbounded subject id overruns 64 and
 * throws — hence its digest. `attests` is a closed seven-member enum whose
 * longest values are 20 characters, reserving 46 of 64, so it cannot throw, and
 * the payoff is a filename that says what the record is:
 * `att_<change>-attestation-independent-baseline.json`.
 */
export function attestationIdForKind(input: {
  readonly changeId: ChangeId;
  readonly attests: string;
}): AttestationId {
  return formatEntityId(
    "attestation",
    derivedSuffix(input.changeId.slice("chg_".length), `-attestation-${input.attests}`)
  ) as AttestationId;
}

/**
 * The release plan id for one change.
 *
 * Identity is `(changeId)` alone, because the artifact is singular per change at
 * `release.json` — the path already says which change it is about, and the id is
 * what a payload and a diagnostic can name it by. The two alternatives
 * `attestationIdForKind` rejects are rejected here for the same reasons, one
 * degree sharper:
 *
 *  - **Not a sequence tail.** `reviewIdForChange`'s idiom accumulates, which is
 *    right for reviews. A release plan is *re-planned* rather than accumulated,
 *    and the gate reads the document's `status` — so a superseded `failed` plan
 *    sitting beside a fresh `requested` one is the favourable-hides-unfavourable
 *    fail-open with the negative fact in the file that can go missing.
 *  - **Not the environment and not the author.** Two plans for two environments
 *    would be two files and the gate's existential would find whichever one was
 *    favourable; the environment lives inside the document, where a reader sees
 *    it.
 *
 * The tail is 8 characters, reserving 21 of 64, so `derivedSuffix` cannot throw.
 */
export function releaseIdForChange(input: { readonly changeId: ChangeId }): ReleaseId {
  return formatEntityId("release", derivedSuffix(input.changeId.slice("chg_".length), "-release")) as ReleaseId;
}

function derivedSuffix(baseSuffix: string, tail: string): string {
  const full = `${baseSuffix}${tail}`;
  if (full.length <= ENTITY_SUFFIX_MAX_LENGTH) return full;

  const digest = createHash("sha256").update(baseSuffix).digest("hex").slice(0, DERIVED_ID_HASH_LENGTH);
  const reservedLength = tail.length + digest.length + 1;
  const prefixLength = ENTITY_SUFFIX_MAX_LENGTH - reservedLength;
  if (prefixLength < 1) {
    throw new RangeError(`Derived entity ID suffix tail is too long: ${tail}`);
  }

  const prefix = baseSuffix.slice(0, prefixLength).replace(/-+$/u, "") || (baseSuffix[0] ?? "x");
  return `${prefix}-${digest}${tail}`;
}

export function runArtifactPath(input: {
  readonly changeId: ChangeId;
  readonly runId: RunId;
  readonly fileName: "context-pack.md" | "executor-prompt.md" | "executor-result.json" | "executor-raw.log" | "executor-redacted.log" | "diff-observation.json" | "verification-report.json" | "protected-paths.json";
}): ArtifactPath {
  return artifactPathSchema.parse(`.legion/project/changes/${input.changeId}/runs/${input.runId}/${input.fileName}`);
}

export function reviewRunArtifactPath(input: {
  readonly changeId: ChangeId;
  readonly reviewId: ReviewId;
  readonly fileName: "context-pack.md" | "executor-prompt.md" | "executor-result.json" | "executor-raw.log" | "executor-redacted.log" | "diff-observation.json" | "verification-report.json" | "protected-paths.json";
}): ArtifactPath {
  return artifactPathSchema.parse(`.legion/project/changes/${input.changeId}/reviews/${input.reviewId}/${input.fileName}`);
}

export function absoluteArtifactPath(repositoryRoot: string, artifactPath: ArtifactPath): string {
  return path.join(repositoryRoot, ...artifactPath.split("/"));
}
