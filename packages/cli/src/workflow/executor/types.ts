import type { ArtifactPath, ChangeId, RunId, TaskContract } from "@legion/protocol";

export type ExecutionAdapterKind = "codex" | "manual" | "fake";
export type ExecutionMode = "build" | "review" | "fix";
export type ExecutionStatus = "succeeded" | "failed" | "blocked";

export interface ExecutionCommandResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number;
}

export interface ExecutionFinding {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly severity: "minor" | "major" | "blocking";
  readonly evidenceRefs?: readonly string[];
}

export interface ExecutionReviewVerdicts {
  readonly specification: "pass" | "fail" | "unknown" | "not_verified" | "not_applicable";
  readonly integration: "pass" | "fail" | "unknown" | "not_verified" | "not_applicable";
  readonly evidence: "pass" | "fail" | "unknown" | "not_verified" | "not_applicable";
}

export interface ExecutionResult {
  readonly ok: boolean;
  readonly status: ExecutionStatus;
  readonly summary: string;
  readonly filesChanged: readonly string[];
  readonly commandsRun: readonly ExecutionCommandResult[];
  readonly findings: readonly ExecutionFinding[];
  readonly reviewVerdicts?: ExecutionReviewVerdicts;
  readonly rawOutput?: string;
  readonly exitCode?: number;
}

export interface ExecutionRequest {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId;
  readonly runId: RunId;
  readonly task: TaskContract;
  readonly mode: ExecutionMode;
  readonly executor: ExecutionAdapterKind;
  readonly readOnly: boolean;
  readonly prompt: string;
  readonly contextPackArtifactPath: ArtifactPath;
  readonly contextPackAbsolutePath: string;
  readonly promptArtifactPath: ArtifactPath;
  readonly promptAbsolutePath: string;
  readonly resultArtifactPath: ArtifactPath;
  readonly resultAbsolutePath: string;
  readonly rawLogArtifactPath: ArtifactPath;
  readonly rawLogAbsolutePath: string;
  readonly redactedLogArtifactPath: ArtifactPath;
  readonly redactedLogAbsolutePath: string;
}

export interface ExecutionAdapter {
  readonly kind: ExecutionAdapterKind;
  run(request: ExecutionRequest): Promise<ExecutionResult>;
}
