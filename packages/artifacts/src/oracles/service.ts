import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  changeIdSchema,
  gitShaSchema,
  oracleIdSchema,
  oracleSchema,
  type ArtifactPath,
  type ArtifactReference,
  type ArtifactRevision,
  type ChangeId,
  type GitSha,
  type Oracle,
  type OracleId
} from "@legion/protocol";

import {
  ArtifactRevisionConflictError,
  writeRevisionedArtifact
} from "../atomic-write.js";
import {
  PROJECT_ARTIFACT_PATHS,
  artifactPathForRole,
  canonicalProjectArtifactPath,
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
  ORACLE_ARTIFACT_SCHEMA_VERSION,
  oracleArtifactDocumentSchema,
  oracleManifestSchema,
  type OracleArtifactDocument,
  type OracleManifest
} from "./schema.js";

export interface CreateOracleArtifactInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
  readonly oracle: Oracle;
  readonly baseGitSha?: GitSha | string;
}

export interface UpdateOracleArtifactInput extends CreateOracleArtifactInput {
  readonly expectedRevision: number;
}

export interface ReadOracleArtifactInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
  readonly oracleId: OracleId | string;
}

export interface DeriveOracleManifestInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
}

export interface OracleArtifactSuccess {
  readonly ok: true;
  readonly status: "created" | "updated" | "read";
  readonly document: Oracle;
  readonly artifactDocument: OracleArtifactDocument;
  readonly artifactPath: ArtifactPath;
  readonly reference: ArtifactReference;
  readonly revision: ArtifactRevision;
  readonly diagnostics: readonly [];
}

export interface OracleManifestSuccess {
  readonly ok: true;
  readonly status: "derived";
  readonly manifest: OracleManifest;
  readonly diagnostics: readonly [];
}

export interface OracleArtifactFailure {
  readonly ok: false;
  readonly status: "invalid" | "not_found" | "conflict";
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

export type OracleArtifactResult = OracleArtifactSuccess | OracleArtifactFailure;
export type OracleManifestResult = OracleManifestSuccess | OracleArtifactFailure;

const INVALID_ORACLE_PATH = ".legion/project/changes/invalid-change/oracle/invalid.yaml" as ArtifactPath;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOracleRevisions(left: ArtifactRevision, right: ArtifactRevision): number {
  return compareStrings(left.artifact.path, right.artifact.path) || compareStrings(left.artifact.sha256, right.artifact.sha256);
}

function failure(status: OracleArtifactFailure["status"], diagnostics: readonly ArtifactDiagnostic[]): OracleArtifactFailure {
  return { ok: false, status, diagnostics };
}

function oracleDiagnostic(input: {
  readonly code: string;
  readonly message: string;
  readonly path?: ArtifactPath;
}): ArtifactDiagnostic {
  return diagnosticForPath({
    code: input.code,
    message: input.message,
    path: input.path ?? INVALID_ORACLE_PATH
  });
}

function schemaDiagnostics(input: {
  readonly code: string;
  readonly path: ArtifactPath;
  readonly issues?: readonly { readonly path?: readonly PropertyKey[]; readonly message: string }[];
}): readonly ArtifactDiagnostic[] {
  if (input.issues === undefined || input.issues.length === 0) {
    return [oracleDiagnostic({ code: input.code, message: "Oracle artifact failed schema validation.", path: input.path })];
  }

  return input.issues.map((issue) =>
    oracleDiagnostic({
      code: input.code,
      message: `${issue.message}${issue.path && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
      path: input.path
    })
  );
}

function parseChangeId(input: ChangeId | string): ChangeId | OracleArtifactFailure {
  const parsed = changeIdSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        oracleDiagnostic({
          code: "invalid_change_id",
          message: issue.message
        })
      )
    );
  }
  return parsed.data;
}

function parseOracleId(input: OracleId | string, path: ArtifactPath): OracleId | OracleArtifactFailure {
  const parsed = oracleIdSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        oracleDiagnostic({
          code: "invalid_oracle_id",
          message: issue.message,
          path
        })
      )
    );
  }
  return parsed.data;
}

function parseBaseGitSha(input: GitSha | string | undefined, path: ArtifactPath): GitSha | undefined | OracleArtifactFailure {
  if (input === undefined) return undefined;
  const parsed = gitShaSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        oracleDiagnostic({
          code: "invalid_base_git_sha",
          message: issue.message,
          path
        })
      )
    );
  }
  return parsed.data;
}

function assertExpectedRevision(value: number, path: ArtifactPath): OracleArtifactFailure | undefined {
  if (!Number.isInteger(value) || value <= 0) {
    return failure("invalid", [
      oracleDiagnostic({
        code: "invalid_expected_revision",
        message: "Oracle update expectedRevision must be a positive integer.",
        path
      })
    ]);
  }
  return undefined;
}

function oraclePath(changeId: ChangeId, oracleId: OracleId): ArtifactPath {
  return artifactPathForRole({ role: "oracle", changeId, oracleId });
}

function normalizeOracle(input: {
  readonly oracle: Oracle;
  readonly artifactPath: ArtifactPath;
}): Oracle | OracleArtifactFailure {
  const parsed = oracleSchema.safeParse(input.oracle);
  if (!parsed.success) {
    return failure("invalid", schemaDiagnostics({ code: "invalid_oracle", path: input.artifactPath, issues: parsed.error.issues }));
  }

  const diagnostics: ArtifactDiagnostic[] = [];
  for (const protectedPath of parsed.data.protectedPaths) {
    try {
      canonicalProjectArtifactPath(protectedPath);
    } catch (error) {
      diagnostics.push(
        oracleDiagnostic({
          code: "invalid_protected_path",
          message: error instanceof Error ? error.message : String(error),
          path: input.artifactPath
        })
      );
    }
  }

  if (diagnostics.length > 0) return failure("invalid", diagnostics);
  return parsed.data;
}

function oracleArtifactDocument(input: {
  readonly oracle: Oracle;
  readonly revision: number;
  readonly artifactPath: ArtifactPath;
}): OracleArtifactDocument | OracleArtifactFailure {
  const parsed = oracleArtifactDocumentSchema.safeParse({
    schemaVersion: ORACLE_ARTIFACT_SCHEMA_VERSION,
    kind: "oracle-artifact",
    revision: input.revision,
    oracle: input.oracle
  });
  if (!parsed.success) {
    return failure("invalid", schemaDiagnostics({ code: "invalid_oracle_artifact", path: input.artifactPath, issues: parsed.error.issues }));
  }
  return parsed.data;
}

function manifestFor(changeId: ChangeId, oracles: readonly ArtifactRevision[]): OracleManifest {
  const sortedOracles = [...oracles].sort(compareOracleRevisions);
  const manifestInput = {
    schemaVersion: ORACLE_ARTIFACT_SCHEMA_VERSION,
    kind: "oracle-manifest" as const,
    changeId,
    oracles: sortedOracles
  };

  return oracleManifestSchema.parse({
    ...manifestInput,
    manifestHash: hashContent(stableProtocolJson(manifestInput))
  });
}

async function writeOracleArtifact(input: {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId;
  readonly oracle: Oracle;
  readonly artifactPath: ArtifactPath;
  readonly expectedRevision: number;
  readonly currentRevision: number;
  readonly baseGitSha?: GitSha;
  readonly supersedes?: ArtifactReference;
  readonly status: OracleArtifactSuccess["status"];
}): Promise<OracleArtifactResult> {
  const artifactDocument = oracleArtifactDocument({
    oracle: input.oracle,
    revision: input.currentRevision + 1,
    artifactPath: input.artifactPath
  });
  if ("diagnostics" in artifactDocument) return artifactDocument;

  const content = stableProtocolJson(artifactDocument);
  try {
    const write = await writeRevisionedArtifact({
      repositoryRoot: input.repositoryRoot,
      artifactPath: input.artifactPath,
      role: "oracle",
      content,
      expectedRevision: input.expectedRevision,
      currentRevision: input.currentRevision,
      mediaType: "application/json",
      ...(input.baseGitSha === undefined ? {} : { baseGitSha: input.baseGitSha }),
      ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes })
    });

    return {
      ok: true,
      status: input.status,
      document: input.oracle,
      artifactDocument,
      artifactPath: write.artifactPath,
      reference: write.reference,
      revision: write.revision,
      diagnostics: []
    };
  } catch (error) {
    if (error instanceof ArtifactRevisionConflictError) {
      return failure("conflict", [
        oracleDiagnostic({
          code: "revision_conflict",
          message: error.message,
          path: input.artifactPath
        })
      ]);
    }
    throw error;
  }
}

export async function createOracleArtifact(input: CreateOracleArtifactInput): Promise<OracleArtifactResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;

  const oracleId = parseOracleId(input.oracle.id, INVALID_ORACLE_PATH);
  if (typeof oracleId !== "string") return oracleId;

  const artifactPath = oraclePath(changeId, oracleId);
  const oracle = normalizeOracle({ oracle: input.oracle, artifactPath });
  if ("diagnostics" in oracle) return oracle;

  const baseGitSha = parseBaseGitSha(input.baseGitSha, artifactPath);
  if (baseGitSha !== undefined && typeof baseGitSha !== "string") return baseGitSha;

  return writeOracleArtifact({
    repositoryRoot: input.repositoryRoot,
    changeId,
    oracle,
    artifactPath,
    expectedRevision: 0,
    currentRevision: 0,
    ...(baseGitSha === undefined ? {} : { baseGitSha }),
    status: "created"
  });
}

export async function updateOracleArtifact(input: UpdateOracleArtifactInput): Promise<OracleArtifactResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;

  const oracleId = parseOracleId(input.oracle.id, INVALID_ORACLE_PATH);
  if (typeof oracleId !== "string") return oracleId;

  const artifactPath = oraclePath(changeId, oracleId);
  const revisionError = assertExpectedRevision(input.expectedRevision, artifactPath);
  if (revisionError !== undefined) return revisionError;

  const oracle = normalizeOracle({ oracle: input.oracle, artifactPath });
  if ("diagnostics" in oracle) return oracle;

  const baseGitSha = parseBaseGitSha(input.baseGitSha, artifactPath);
  if (baseGitSha !== undefined && typeof baseGitSha !== "string") return baseGitSha;

  const current = await readOracleArtifact({
    repositoryRoot: input.repositoryRoot,
    changeId,
    oracleId
  });
  if (!current.ok) return current;

  if (current.artifactDocument.revision !== input.expectedRevision) {
    return failure("conflict", [
      oracleDiagnostic({
        code: "revision_conflict",
        message: `stale artifact revision: expected ${input.expectedRevision}, current ${current.artifactDocument.revision}`,
        path: artifactPath
      })
    ]);
  }

  return writeOracleArtifact({
    repositoryRoot: input.repositoryRoot,
    changeId,
    oracle,
    artifactPath,
    expectedRevision: input.expectedRevision,
    currentRevision: current.artifactDocument.revision,
    ...(baseGitSha === undefined ? {} : { baseGitSha }),
    supersedes: current.reference,
    status: "updated"
  });
}

export async function readOracleArtifact(input: ReadOracleArtifactInput): Promise<OracleArtifactResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;

  const oracleId = parseOracleId(input.oracleId, INVALID_ORACLE_PATH);
  if (typeof oracleId !== "string") return oracleId;

  const artifactPath = oraclePath(changeId, oracleId);
  const read = await readJsonArtifact({
    repositoryRoot: input.repositoryRoot,
    artifactPath,
    schema: oracleArtifactDocumentSchema
  });

  if (!read.ok) {
    const status = read.diagnostics.some((diagnostic) => diagnostic.code === "not_found") ? "not_found" : "invalid";
    return failure(status, read.diagnostics);
  }

  return {
    ok: true,
    status: "read",
    document: read.value.oracle,
    artifactDocument: read.value,
    artifactPath,
    reference: read.reference,
    revision: artifactRevisionForContent({
      role: "oracle",
      path: artifactPath,
      content: read.bytes,
      revision: read.value.revision,
      mediaType: "application/json"
    }),
    diagnostics: []
  };
}

export async function deriveOracleManifest(input: DeriveOracleManifestInput): Promise<OracleManifestResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;

  const oracleDirectory = path.join(input.repositoryRoot, PROJECT_ARTIFACT_PATHS.changes, changeId, "oracle");
  let entries;
  try {
    entries = await readdir(oracleDirectory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        ok: true,
        status: "derived",
        manifest: manifestFor(changeId, []),
        diagnostics: []
      };
    }
    throw error;
  }

  const oracleRevisions: ArtifactRevision[] = [];
  for (const fileName of entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name)
    .sort(compareStrings)) {
    const oracleArtifactPath = `${PROJECT_ARTIFACT_PATHS.changes}/${changeId}/oracle/${fileName}` as ArtifactPath;
    const oracleId = parseOracleId(fileName.slice(0, -".yaml".length), oracleArtifactPath);
    if (typeof oracleId !== "string") return oracleId;

    const oracle = await readOracleArtifact({
      repositoryRoot: input.repositoryRoot,
      changeId,
      oracleId
    });
    if (!oracle.ok) return oracle;
    oracleRevisions.push(oracle.revision);
  }

  return {
    ok: true,
    status: "derived",
    manifest: manifestFor(changeId, oracleRevisions),
    diagnostics: []
  };
}
