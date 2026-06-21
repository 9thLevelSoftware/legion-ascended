import {
  artifactRevisionSchema,
  changeIdSchema,
  gitShaSchema,
  type ArtifactPath,
  type ArtifactReference,
  type ArtifactRevision,
  type ChangeId,
  type GitSha,
  type ContentHash,
  type TaskContract
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
  hashContent,
  readJsonArtifact,
  stableProtocolJson
} from "../revisions.js";
import {
  TASKGRAPH_SCHEMA_VERSION,
  changeArtifactManifestSchema,
  taskGraphDocumentSchema,
  type ChangeArtifactManifest,
  type TaskGraphDocument
} from "./schema.js";

export interface DeriveChangeArtifactManifestInput {
  readonly changeId: ChangeId | string;
  readonly inputs: readonly ArtifactRevision[];
  readonly evidenceRefs?: readonly ArtifactReference[];
}

export interface WriteTaskGraphInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
  readonly tasks: readonly TaskContract[];
  readonly artifactInputs: readonly ArtifactRevision[];
  readonly expectedRevision?: number;
  readonly baseGitSha?: GitSha | string;
}

export interface ReadTaskGraphInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
}

export interface TaskGraphSuccess {
  readonly ok: true;
  readonly status: "created" | "updated" | "read";
  readonly document: TaskGraphDocument;
  readonly artifactPath: ArtifactPath;
  readonly reference: ArtifactReference;
  readonly revision: ArtifactRevision;
  readonly diagnostics: readonly [];
}

export interface TaskGraphFailure {
  readonly ok: false;
  readonly status: "invalid" | "not_found" | "conflict";
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

export type TaskGraphResult = TaskGraphSuccess | TaskGraphFailure;

const INVALID_TASKGRAPH_PATH = ".legion/project/changes/invalid-change/taskgraph.json" as ArtifactPath;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareReferences(left: ArtifactReference, right: ArtifactReference): number {
  return compareStrings(left.path, right.path) || compareStrings(left.sha256, right.sha256);
}

export function compareArtifactRevisions(left: ArtifactRevision, right: ArtifactRevision): number {
  return compareStrings(left.role, right.role) || compareReferences(left.artifact, right.artifact);
}

function artifactInputDiagnostics(input: {
  readonly artifactInputs: readonly unknown[];
  readonly artifactPath: ArtifactPath;
}): readonly ArtifactDiagnostic[] {
  if (input.artifactInputs.length === 0) {
    return [
      taskGraphDiagnostic({
        code: "invalid_artifact_inputs",
        message: "At least one artifact input revision is required.",
        path: input.artifactPath
      })
    ];
  }

  const diagnostics: ArtifactDiagnostic[] = [];
  const artifactPaths = new Set<string>();
  for (const [index, artifactInput] of input.artifactInputs.entries()) {
    const parsed = artifactRevisionSchema.safeParse(artifactInput);
    if (!parsed.success) {
      diagnostics.push(
        ...schemaDiagnostics({
          code: "invalid_artifact_inputs",
          path: input.artifactPath,
          issues: parsed.error.issues.map((issue) => ({
            ...issue,
            path: ["artifactInputs", index, ...(issue.path ?? [])]
          }))
        })
      );
      continue;
    }

    if (artifactPaths.has(parsed.data.artifact.path)) {
      diagnostics.push(
        taskGraphDiagnostic({
          code: "duplicate_artifact_input",
          message: `Duplicate artifact input path: ${parsed.data.artifact.path}.`,
          path: input.artifactPath
        })
      );
    }
    artifactPaths.add(parsed.data.artifact.path);
  }

  return diagnostics;
}

function failure(status: TaskGraphFailure["status"], diagnostics: readonly ArtifactDiagnostic[]): TaskGraphFailure {
  return { ok: false, status, diagnostics };
}

function taskGraphDiagnostic(input: {
  readonly code: string;
  readonly message: string;
  readonly path?: ArtifactPath;
}): ArtifactDiagnostic {
  return diagnosticForPath({
    code: input.code,
    message: input.message,
    path: input.path ?? INVALID_TASKGRAPH_PATH
  });
}

function schemaDiagnostics(input: {
  readonly code: string;
  readonly path: ArtifactPath;
  readonly issues?: readonly { readonly path?: readonly PropertyKey[]; readonly message: string }[];
}): readonly ArtifactDiagnostic[] {
  if (input.issues === undefined || input.issues.length === 0) {
    return [taskGraphDiagnostic({ code: input.code, message: "Taskgraph failed schema validation.", path: input.path })];
  }

  return input.issues.map((issue) =>
    taskGraphDiagnostic({
      code: input.code,
      message: `${issue.message}${issue.path && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
      path: input.path
    })
  );
}

function parseChangeId(input: ChangeId | string): ChangeId | TaskGraphFailure {
  const parsed = changeIdSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        taskGraphDiagnostic({
          code: "invalid_change_id",
          message: issue.message
        })
      )
    );
  }
  return parsed.data;
}

function parseBaseGitSha(input: GitSha | string | undefined, path: ArtifactPath): GitSha | undefined | TaskGraphFailure {
  if (input === undefined) return undefined;
  const parsed = gitShaSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        taskGraphDiagnostic({
          code: "invalid_base_git_sha",
          message: issue.message,
          path
        })
      )
    );
  }
  return parsed.data;
}

function assertExpectedRevision(value: number, path: ArtifactPath): TaskGraphFailure | undefined {
  if (!Number.isInteger(value) || value < 0) {
    return failure("invalid", [
      taskGraphDiagnostic({
        code: "invalid_expected_revision",
        message: "Expected revision must be a non-negative integer.",
        path
      })
    ]);
  }
  return undefined;
}

function taskgraphPath(changeId: ChangeId): ArtifactPath {
  return artifactPathForRole({ role: "taskgraph", changeId });
}

export function deriveChangeArtifactManifest(input: DeriveChangeArtifactManifestInput): ChangeArtifactManifest {
  const changeId = changeIdSchema.parse(input.changeId);
  const inputs = [...input.inputs].sort(compareArtifactRevisions);
  const evidenceRefs = [...(input.evidenceRefs ?? [])].sort(compareReferences);
  const manifestInput = {
    schemaVersion: TASKGRAPH_SCHEMA_VERSION,
    kind: "change-artifact-manifest" as const,
    changeId,
    inputs,
    evidenceRefs
  };

  return changeArtifactManifestSchema.parse({
    ...manifestInput,
    manifestHash: hashContent(stableProtocolJson(manifestInput))
  });
}

export function expectedChangeArtifactManifestHash(manifest: ChangeArtifactManifest): ContentHash {
  return hashContent(stableProtocolJson({
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    changeId: manifest.changeId,
    inputs: manifest.inputs,
    evidenceRefs: manifest.evidenceRefs
  }));
}

function manifestHashDiagnostics(input: {
  readonly manifest: ChangeArtifactManifest;
  readonly artifactPath: ArtifactPath;
}): readonly ArtifactDiagnostic[] {
  const expectedHash = expectedChangeArtifactManifestHash(input.manifest);
  if (input.manifest.manifestHash === expectedHash) return [];
  return [
    taskGraphDiagnostic({
      code: "manifest_hash_mismatch",
      message: `Artifact manifest hash ${input.manifest.manifestHash} does not match expected ${expectedHash}.`,
      path: input.artifactPath
    })
  ];
}

function manifestInputDiagnostics(input: {
  readonly document: TaskGraphDocument;
  readonly artifactPath: ArtifactPath;
}): readonly ArtifactDiagnostic[] {
  const artifactInputs = [...input.document.artifactInputs].sort(compareArtifactRevisions);
  const manifestInputs = [...input.document.artifactManifest.inputs].sort(compareArtifactRevisions);
  if (stableProtocolJson(artifactInputs) === stableProtocolJson(manifestInputs)) return [];

  return [
    taskGraphDiagnostic({
      code: "taskgraph_manifest_inputs_mismatch",
      message: "Taskgraph artifactInputs must match artifactManifest.inputs.",
      path: input.artifactPath
    })
  ];
}

function normalizeTaskGraph(input: {
  readonly changeId: ChangeId;
  readonly revision: number;
  readonly tasks: readonly TaskContract[];
  readonly artifactInputs: readonly ArtifactRevision[];
  readonly artifactPath: ArtifactPath;
}): TaskGraphDocument | TaskGraphFailure {
  const artifactInputs = [...input.artifactInputs].sort(compareArtifactRevisions);
  const artifactInputIssues = artifactInputDiagnostics({
    artifactInputs,
    artifactPath: input.artifactPath
  });
  if (artifactInputIssues.length > 0) return failure("invalid", artifactInputIssues);

  const tasks = [...input.tasks].sort((left, right) => compareStrings(left.id, right.id));
  const documentInput = {
    schemaVersion: TASKGRAPH_SCHEMA_VERSION,
    kind: "taskgraph" as const,
    changeId: input.changeId,
    revision: input.revision,
    artifactInputs,
    tasks,
    artifactManifest: deriveChangeArtifactManifest({
      changeId: input.changeId,
      inputs: artifactInputs
    })
  };
  const parsed = taskGraphDocumentSchema.safeParse(documentInput);
  if (!parsed.success) {
    return failure("invalid", schemaDiagnostics({ code: "invalid_taskgraph", path: input.artifactPath, issues: parsed.error.issues }));
  }
  return parsed.data;
}

async function currentTaskGraph(input: ReadTaskGraphInput): Promise<TaskGraphSuccess | TaskGraphFailure> {
  return readTaskGraph(input);
}

export async function writeTaskGraph(input: WriteTaskGraphInput): Promise<TaskGraphResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;

  const artifactPath = taskgraphPath(changeId);
  const expectedRevision = input.expectedRevision ?? 0;
  const revisionError = assertExpectedRevision(expectedRevision, artifactPath);
  if (revisionError !== undefined) return revisionError;

  const baseGitSha = parseBaseGitSha(input.baseGitSha, artifactPath);
  if (baseGitSha !== undefined && typeof baseGitSha !== "string") return baseGitSha;

  let supersedes: ArtifactReference | undefined;
  if (expectedRevision > 0) {
    const current = await currentTaskGraph({
      repositoryRoot: input.repositoryRoot,
      changeId
    });
    if (!current.ok) return current;
    if (current.document.revision !== expectedRevision) {
      return failure("conflict", [
        taskGraphDiagnostic({
          code: "revision_conflict",
          message: `stale artifact revision: expected ${expectedRevision}, current ${current.document.revision}`,
          path: artifactPath
        })
      ]);
    }
    supersedes = current.reference;
  }

  const document = normalizeTaskGraph({
    changeId,
    revision: expectedRevision + 1,
    tasks: input.tasks,
    artifactInputs: input.artifactInputs,
    artifactPath
  });
  if ("diagnostics" in document) return document;

  const content = stableProtocolJson(document);
  try {
    const write = await writeRevisionedArtifact({
      repositoryRoot: input.repositoryRoot,
      artifactPath,
      role: "taskgraph",
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
        taskGraphDiagnostic({
          code: "revision_conflict",
          message: error.message,
          path: artifactPath
        })
      ]);
    }
    throw error;
  }
}

export async function readTaskGraph(input: ReadTaskGraphInput): Promise<TaskGraphResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;

  const artifactPath = taskgraphPath(changeId);
  const read = await readJsonArtifact({
    repositoryRoot: input.repositoryRoot,
    artifactPath,
    schema: taskGraphDocumentSchema
  });

  if (!read.ok) {
    const status = read.diagnostics.some((diagnostic) => diagnostic.code === "not_found") ? "not_found" : "invalid";
    return failure(status, read.diagnostics);
  }

  if (read.value.changeId !== changeId) {
    return failure("invalid", [
      taskGraphDiagnostic({
        code: "taskgraph_change_mismatch",
        message: `Taskgraph change ID ${read.value.changeId} does not match requested change ${changeId}.`,
        path: artifactPath
      })
    ]);
  }

  const artifactInputIssues = artifactInputDiagnostics({
    artifactInputs: read.value.artifactInputs,
    artifactPath
  });
  if (artifactInputIssues.length > 0) return failure("invalid", artifactInputIssues);

  const manifestInputIssues = manifestInputDiagnostics({
    document: read.value,
    artifactPath
  });
  if (manifestInputIssues.length > 0) return failure("invalid", manifestInputIssues);

  const manifestDiagnostics = manifestHashDiagnostics({
    manifest: read.value.artifactManifest,
    artifactPath
  });
  if (manifestDiagnostics.length > 0) return failure("invalid", manifestDiagnostics);

  return {
    ok: true,
    status: "read",
    document: read.value,
    artifactPath,
    reference: read.reference,
    revision: artifactRevisionForContent({
      role: "taskgraph",
      path: artifactPath,
      content: read.bytes,
      revision: read.value.revision,
      mediaType: "application/json"
    }),
    diagnostics: []
  };
}
