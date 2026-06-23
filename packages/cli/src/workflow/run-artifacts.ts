import { createHash } from "node:crypto";
import path from "node:path";

import {
  artifactPathSchema,
  formatEntityId,
  type ArtifactPath,
  type ChangeId,
  type ContractId,
  type EvidenceId,
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
  readonly fileName: "context-pack.md" | "executor-prompt.md" | "executor-result.json" | "executor-raw.log" | "executor-redacted.log";
}): ArtifactPath {
  return artifactPathSchema.parse(`.legion/project/changes/${input.changeId}/runs/${input.runId}/${input.fileName}`);
}

export function reviewRunArtifactPath(input: {
  readonly changeId: ChangeId;
  readonly reviewId: ReviewId;
  readonly fileName: "context-pack.md" | "executor-prompt.md" | "executor-result.json" | "executor-raw.log" | "executor-redacted.log";
}): ArtifactPath {
  return artifactPathSchema.parse(`.legion/project/changes/${input.changeId}/reviews/${input.reviewId}/${input.fileName}`);
}

export function absoluteArtifactPath(repositoryRoot: string, artifactPath: ArtifactPath): string {
  return path.join(repositoryRoot, ...artifactPath.split("/"));
}
