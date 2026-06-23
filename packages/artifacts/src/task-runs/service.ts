import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  changeIdSchema,
  gitShaSchema,
  runIdSchema,
  taskRunSchema,
  type ArtifactPath,
  type ArtifactReference,
  type ArtifactRevision,
  type ChangeId,
  type GitSha,
  type RunId,
  type TaskRun
} from "@legion/protocol";

import {
  ArtifactRevisionConflictError,
  writeRevisionedArtifact
} from "../atomic-write.js";
import {
  artifactPathForRole,
  diagnosticForPath,
  type ArtifactDiagnostic
} from "../paths.js";
import {
  artifactRevisionForContent,
  readJsonArtifact,
  stableProtocolJson
} from "../revisions.js";

export interface WriteTaskRunInput {
  readonly repositoryRoot: string;
  readonly document: TaskRun;
  readonly expectedRevision?: number;
  readonly baseGitSha?: GitSha | string;
}

export interface ReadTaskRunInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
  readonly runId: RunId | string;
}

export interface ListTaskRunsInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
}

export interface TaskRunSuccess {
  readonly ok: true;
  readonly status: "created" | "updated" | "read";
  readonly document: TaskRun;
  readonly artifactPath: ArtifactPath;
  readonly reference: ArtifactReference;
  readonly revision: ArtifactRevision;
  readonly diagnostics: readonly [];
}

export interface TaskRunFailure {
  readonly ok: false;
  readonly status: "invalid" | "not_found" | "conflict";
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

export interface TaskRunListSuccess {
  readonly ok: true;
  readonly status: "read";
  readonly taskRuns: readonly TaskRunSuccess[];
  readonly diagnostics: readonly [];
}

export type TaskRunResult = TaskRunSuccess | TaskRunFailure;
export type TaskRunListResult = TaskRunListSuccess | TaskRunFailure;

const INVALID_TASK_RUN_PATH = ".legion/project/changes/invalid-change/runs/invalid-run/task-run.json" as ArtifactPath;
const ARTIFACT_REVISION_METADATA_KEY = "artifact_revision";

function failure(status: TaskRunFailure["status"], diagnostics: readonly ArtifactDiagnostic[]): TaskRunFailure {
  return { ok: false, status, diagnostics };
}

function taskRunDiagnostic(input: {
  readonly code: string;
  readonly message: string;
  readonly path?: ArtifactPath;
}): ArtifactDiagnostic {
  return diagnosticForPath({
    code: input.code,
    message: input.message,
    path: input.path ?? INVALID_TASK_RUN_PATH
  });
}

function schemaDiagnostics(input: {
  readonly code: string;
  readonly path: ArtifactPath;
  readonly issues?: readonly { readonly path?: readonly PropertyKey[]; readonly message: string }[];
}): readonly ArtifactDiagnostic[] {
  if (input.issues === undefined || input.issues.length === 0) {
    return [taskRunDiagnostic({ code: input.code, message: "Task run failed schema validation.", path: input.path })];
  }

  return input.issues.map((issue) =>
    taskRunDiagnostic({
      code: input.code,
      message: `${issue.message}${issue.path && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
      path: input.path
    })
  );
}

function parseChangeId(input: ChangeId | string): ChangeId | TaskRunFailure {
  const parsed = changeIdSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        taskRunDiagnostic({
          code: "invalid_change_id",
          message: issue.message
        })
      )
    );
  }
  return parsed.data;
}

function parseRunId(input: RunId | string): RunId | TaskRunFailure {
  const parsed = runIdSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        taskRunDiagnostic({
          code: "invalid_run_id",
          message: issue.message
        })
      )
    );
  }
  return parsed.data;
}

function parseBaseGitSha(input: GitSha | string | undefined, artifactPath: ArtifactPath): GitSha | undefined | TaskRunFailure {
  if (input === undefined) return undefined;
  const parsed = gitShaSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        taskRunDiagnostic({
          code: "invalid_base_git_sha",
          message: issue.message,
          path: artifactPath
        })
      )
    );
  }
  return parsed.data;
}

function assertExpectedRevision(value: number, path: ArtifactPath): TaskRunFailure | undefined {
  if (!Number.isInteger(value) || value < 0) {
    return failure("invalid", [
      taskRunDiagnostic({
        code: "invalid_expected_revision",
        message: "Expected revision must be a non-negative integer.",
        path
      })
    ]);
  }
  return undefined;
}

function taskRunPath(changeId: ChangeId, runId: RunId): ArtifactPath {
  return artifactPathForRole({ role: "task-run", changeId, runId });
}

function storeArtifactRevision(document: TaskRun, revision: number): TaskRun | TaskRunFailure {
  const parsed = taskRunSchema.safeParse({
    ...document,
    metadata: {
      ...(document.metadata ?? {}),
      attributes: {
        ...(document.metadata?.attributes ?? {}),
        [ARTIFACT_REVISION_METADATA_KEY]: revision
      }
    }
  });
  if (!parsed.success) {
    return failure(
      "invalid",
      schemaDiagnostics({
        code: "invalid_task_run",
        path: taskRunPath(document.changeId, document.id),
        issues: parsed.error.issues
      })
    );
  }
  return parsed.data;
}

function storedArtifactRevision(document: TaskRun): number {
  const value = document.metadata?.attributes?.[ARTIFACT_REVISION_METADATA_KEY];
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  return 1;
}

function identityDiagnostics(input: {
  readonly document: TaskRun;
  readonly changeId: ChangeId;
  readonly runId: RunId;
  readonly artifactPath: ArtifactPath;
}): readonly ArtifactDiagnostic[] {
  const diagnostics: ArtifactDiagnostic[] = [];
  if (input.document.changeId !== input.changeId) {
    diagnostics.push(
      taskRunDiagnostic({
        code: "task_run_change_mismatch",
        message: `Task run change ID ${input.document.changeId} does not match requested change ${input.changeId}.`,
        path: input.artifactPath
      })
    );
  }
  if (input.document.id !== input.runId) {
    diagnostics.push(
      taskRunDiagnostic({
        code: "task_run_id_mismatch",
        message: `Task run ID ${input.document.id} does not match requested run ${input.runId}.`,
        path: input.artifactPath
      })
    );
  }
  return diagnostics;
}

export async function writeTaskRun(input: WriteTaskRunInput): Promise<TaskRunResult> {
  const parsed = taskRunSchema.safeParse(input.document);
  if (!parsed.success) {
    return failure(
      "invalid",
      schemaDiagnostics({
        code: "invalid_task_run",
        path: INVALID_TASK_RUN_PATH,
        issues: parsed.error.issues
      })
    );
  }

  const artifactPath = taskRunPath(parsed.data.changeId, parsed.data.id);
  const expectedRevision = input.expectedRevision ?? 0;
  const revisionError = assertExpectedRevision(expectedRevision, artifactPath);
  if (revisionError !== undefined) return revisionError;

  const baseGitSha = parseBaseGitSha(input.baseGitSha, artifactPath);
  if (baseGitSha !== undefined && typeof baseGitSha !== "string") return baseGitSha;

  let supersedes: ArtifactReference | undefined;
  if (expectedRevision > 0) {
    const current = await readTaskRun({
      repositoryRoot: input.repositoryRoot,
      changeId: parsed.data.changeId,
      runId: parsed.data.id
    });
    if (!current.ok) return current;
    if (current.revision.revision !== expectedRevision) {
      return failure("conflict", [
        taskRunDiagnostic({
          code: "revision_conflict",
          message: `stale artifact revision: expected ${expectedRevision}, current ${current.revision.revision}`,
          path: artifactPath
        })
      ]);
    }
    supersedes = current.reference;
  }

  const document = storeArtifactRevision(parsed.data, expectedRevision + 1);
  if ("diagnostics" in document) return document;

  const content = stableProtocolJson(document);
  try {
    const write = await writeRevisionedArtifact({
      repositoryRoot: input.repositoryRoot,
      artifactPath,
      role: "task-run",
      content,
      expectedRevision,
      currentRevision: expectedRevision,
      mediaType: "application/json",
      ...(baseGitSha === undefined ? {} : { baseGitSha }),
      ...(supersedes === undefined ? {} : { supersedes })
    });

    return {
      ok: true,
      status: expectedRevision === 0 ? "created" : "updated",
      document,
      artifactPath: write.artifactPath,
      reference: write.reference,
      revision: write.revision,
      diagnostics: []
    };
  } catch (error) {
    if (error instanceof ArtifactRevisionConflictError) {
      return failure("conflict", [
        taskRunDiagnostic({
          code: "revision_conflict",
          message: error.message,
          path: artifactPath
        })
      ]);
    }
    throw error;
  }
}

export async function readTaskRun(input: ReadTaskRunInput): Promise<TaskRunResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;
  const runId = parseRunId(input.runId);
  if (typeof runId !== "string") return runId;

  const artifactPath = taskRunPath(changeId, runId);
  const read = await readJsonArtifact({
    repositoryRoot: input.repositoryRoot,
    artifactPath,
    schema: taskRunSchema
  });
  if (!read.ok) {
    const status = read.diagnostics.some((diagnostic) => diagnostic.code === "not_found") ? "not_found" : "invalid";
    return failure(status, read.diagnostics);
  }

  const diagnostics = identityDiagnostics({
    document: read.value,
    changeId,
    runId,
    artifactPath
  });
  if (diagnostics.length > 0) return failure("invalid", diagnostics);

  const storedRevision = storedArtifactRevision(read.value);
  return {
    ok: true,
    status: "read",
    document: read.value,
    artifactPath,
    reference: read.reference,
    revision: artifactRevisionForContent({
      role: "task-run",
      path: artifactPath,
      content: read.bytes,
      revision: storedRevision,
      mediaType: "application/json"
    }),
    diagnostics: []
  };
}

export async function listTaskRunsForChange(input: ListTaskRunsInput): Promise<TaskRunListResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;

  const runsRoot = path.join(input.repositoryRoot, ".legion", "project", "changes", changeId, "runs");
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { ok: true, status: "read", taskRuns: [], diagnostics: [] };
    }
    const message = error instanceof Error ? error.message : String(error);
    return failure("invalid", [
      taskRunDiagnostic({
        code: "task_run_discovery_failed",
        message,
        path: ".legion/project/changes/invalid-change/runs" as ArtifactPath
      })
    ]);
  }

  const taskRuns: TaskRunSuccess[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const runId = runIdSchema.safeParse(entry.name);
    if (!runId.success) continue;
    const read = await readTaskRun({
      repositoryRoot: input.repositoryRoot,
      changeId,
      runId: runId.data
    });
    if (!read.ok) return read;
    taskRuns.push(read);
  }

  taskRuns.sort((left, right) => {
    const byCreatedAt = left.document.createdAt.localeCompare(right.document.createdAt);
    if (byCreatedAt !== 0) return byCreatedAt;
    return left.document.id.localeCompare(right.document.id);
  });

  return { ok: true, status: "read", taskRuns, diagnostics: [] };
}
