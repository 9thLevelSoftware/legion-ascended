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

export function taskIdForContractId(contractId: ContractId): TaskId {
  return formatEntityId("task", contractId.slice("ctr_".length));
}

export function runIdForTask(input: {
  readonly taskId: TaskId;
  readonly attempt: number;
}): RunId {
  return formatEntityId("run", `${input.taskId.slice("tsk_".length)}-attempt-${input.attempt}`);
}

export function evidenceIdForRun(runId: RunId): EvidenceId {
  return formatEntityId("evidence", runId.slice("run_".length));
}

export function reviewIdForChange(input: {
  readonly changeId: ChangeId;
  readonly sequence: number;
}): ReviewId {
  return formatEntityId("review", `${input.changeId.slice("chg_".length)}-review-${input.sequence}`);
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
