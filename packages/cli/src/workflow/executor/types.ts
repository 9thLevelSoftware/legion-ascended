import type { ArtifactPath, ChangeId, RunId, TaskContract } from "@legion/protocol";

export type ExecutionAdapterKind = "claude" | "codex" | "hermes" | "grok" | "manual" | "fake";
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
  /**
   * The adapter's structured reply, when it produced one separately from its
   * process output.
   *
   * `rawOutput` is stdout and stderr. Parsing typed fields back out of that
   * found log noise, not the JSON the contract asked for, so an exploration
   * could return a valid typed reply and still be recorded with nothing but a
   * fallback summary.
   */
  readonly structuredOutput?: string;
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
  /**
   * Optional isolated root for adapter-owned transcripts/results. The execution
   * working directory remains `repositoryRoot`; this root is only for generic
   * adapter persistence and is removed by callers that use ephemeral artifacts.
   */
  readonly artifactRepositoryRoot?: string;
}

export interface ExecutionAdapter {
  readonly kind: ExecutionAdapterKind;
  run(request: ExecutionRequest): Promise<ExecutionResult>;
}
