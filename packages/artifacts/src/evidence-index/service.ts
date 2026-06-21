import {
  artifactRevisionSchema,
  changeIdSchema,
  gitShaSchema,
  type ArtifactPath,
  type ArtifactReference,
  type ArtifactRevision,
  type ChangeId,
  type EvidenceBundle,
  type GitSha
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
import {
  compareArtifactRevisions,
  deriveChangeArtifactManifest,
  expectedChangeArtifactManifestHash
} from "../taskgraphs/service.js";
import {
  EVIDENCE_INDEX_SCHEMA_VERSION,
  evidenceIndexDocumentSchema,
  evidenceIndexEntrySchema,
  type EvidenceIndexDocument,
  type EvidenceIndexEntry
} from "./schema.js";

export interface WriteEvidenceIndexInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
  readonly entries: readonly EvidenceIndexEntry[];
  readonly artifactInputs: readonly ArtifactRevision[];
  readonly expectedRevision?: number;
  readonly baseGitSha?: GitSha | string;
}

export interface ReadEvidenceIndexInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
}

export interface EvidenceIndexSuccess {
  readonly ok: true;
  readonly status: "created" | "updated" | "read";
  readonly document: EvidenceIndexDocument;
  readonly artifactPath: ArtifactPath;
  readonly reference: ArtifactReference;
  readonly revision: ArtifactRevision;
  readonly diagnostics: readonly [];
}

export interface EvidenceIndexFailure {
  readonly ok: false;
  readonly status: "invalid" | "not_found" | "conflict";
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

export type EvidenceIndexResult = EvidenceIndexSuccess | EvidenceIndexFailure;

const INVALID_EVIDENCE_INDEX_PATH = ".legion/project/changes/invalid-change/evidence-index.json" as ArtifactPath;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareReferences(left: ArtifactReference, right: ArtifactReference): number {
  return compareStrings(left.path, right.path) || compareStrings(left.sha256, right.sha256);
}

function failure(status: EvidenceIndexFailure["status"], diagnostics: readonly ArtifactDiagnostic[]): EvidenceIndexFailure {
  return { ok: false, status, diagnostics };
}

function evidenceDiagnostic(input: {
  readonly code: string;
  readonly message: string;
  readonly path?: ArtifactPath;
}): ArtifactDiagnostic {
  return diagnosticForPath({
    code: input.code,
    message: input.message,
    path: input.path ?? INVALID_EVIDENCE_INDEX_PATH
  });
}

function schemaDiagnostics(input: {
  readonly code: string;
  readonly path: ArtifactPath;
  readonly issues?: readonly { readonly path?: readonly PropertyKey[]; readonly message: string }[];
}): readonly ArtifactDiagnostic[] {
  if (input.issues === undefined || input.issues.length === 0) {
    return [evidenceDiagnostic({ code: input.code, message: "Evidence index failed schema validation.", path: input.path })];
  }

  return input.issues.map((issue) =>
    evidenceDiagnostic({
      code: input.code,
      message: `${issue.message}${issue.path && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
      path: input.path
    })
  );
}

function parseChangeId(input: ChangeId | string): ChangeId | EvidenceIndexFailure {
  const parsed = changeIdSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        evidenceDiagnostic({
          code: "invalid_change_id",
          message: issue.message
        })
      )
    );
  }
  return parsed.data;
}

function parseBaseGitSha(input: GitSha | string | undefined, path: ArtifactPath): GitSha | undefined | EvidenceIndexFailure {
  if (input === undefined) return undefined;
  const parsed = gitShaSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        evidenceDiagnostic({
          code: "invalid_base_git_sha",
          message: issue.message,
          path
        })
      )
    );
  }
  return parsed.data;
}

function assertExpectedRevision(value: number, path: ArtifactPath): EvidenceIndexFailure | undefined {
  if (!Number.isInteger(value) || value < 0) {
    return failure("invalid", [
      evidenceDiagnostic({
        code: "invalid_expected_revision",
        message: "Expected revision must be a non-negative integer.",
        path
      })
    ]);
  }
  return undefined;
}

function evidenceIndexPath(changeId: ChangeId): ArtifactPath {
  return artifactPathForRole({ role: "evidence-index", changeId });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function artifactInputDiagnostics(input: {
  readonly artifactInputs: readonly unknown[];
  readonly artifactPath: ArtifactPath;
}): readonly ArtifactDiagnostic[] {
  if (input.artifactInputs.length === 0) {
    return [
      evidenceDiagnostic({
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
        evidenceDiagnostic({
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

function rawAcceptanceDiagnostics(input: {
  readonly entry: unknown;
  readonly artifactPath: ArtifactPath;
}): readonly ArtifactDiagnostic[] {
  if (!isRecord(input.entry) || !isRecord(input.entry["acceptance"])) return [];

  const acceptance = input.entry["acceptance"];
  if (acceptance["status"] === "accepted") {
    if (acceptance["reviewId"] === undefined) {
      return [
        evidenceDiagnostic({
          code: "missing_review_id",
          message: "Accepted evidence requires a reviewId.",
          path: input.artifactPath
        })
      ];
    }
    if (acceptance["acceptedAt"] === undefined) {
      return [
        evidenceDiagnostic({
          code: "missing_accepted_at",
          message: "Accepted evidence requires acceptedAt.",
          path: input.artifactPath
        })
      ];
    }
  }

  if (
    acceptance["status"] === "rejected" &&
    (typeof acceptance["reason"] !== "string" || acceptance["reason"].length === 0)
  ) {
    return [
      evidenceDiagnostic({
        code: "missing_rejection_reason",
        message: "Rejected evidence requires a reason.",
        path: input.artifactPath
      })
    ];
  }

  return [];
}

function manifestHashDiagnostics(input: {
  readonly document: EvidenceIndexDocument;
  readonly artifactPath: ArtifactPath;
}): readonly ArtifactDiagnostic[] {
  const expectedHash = expectedChangeArtifactManifestHash(input.document.artifactManifest);
  if (input.document.artifactManifest.manifestHash === expectedHash) return [];
  return [
    evidenceDiagnostic({
      code: "manifest_hash_mismatch",
      message: `Artifact manifest hash ${input.document.artifactManifest.manifestHash} does not match expected ${expectedHash}.`,
      path: input.artifactPath
    })
  ];
}

function validateEntries(input: {
  readonly entries: readonly EvidenceIndexEntry[];
  readonly changeId: ChangeId;
  readonly artifactPath: ArtifactPath;
}): readonly ArtifactDiagnostic[] {
  const diagnostics: ArtifactDiagnostic[] = [];

  for (const [entryIndex, entry] of input.entries.entries()) {
    if (entry.evidence.changeId !== input.changeId) {
      diagnostics.push(
        evidenceDiagnostic({
          code: "evidence_change_mismatch",
          message: `Evidence bundle ${entry.evidence.id} belongs to ${entry.evidence.changeId}, not ${input.changeId}.`,
          path: input.artifactPath
        })
      );
    }

    if (entry.evidence.status === "collected" && entry.evidence.runId === undefined) {
      diagnostics.push(
        evidenceDiagnostic({
          code: "missing_evidence_run",
          message: `Collected evidence bundle ${entry.evidence.id} requires a runId.`,
          path: input.artifactPath
        })
      );
    }

    if (entry.acceptance.status === "accepted" && entry.acceptance.reviewId === undefined) {
      diagnostics.push(
        evidenceDiagnostic({
          code: "missing_review_id",
          message: `Accepted evidence bundle ${entry.evidence.id} requires a reviewId.`,
          path: input.artifactPath
        })
      );
    }

    if (entry.acceptance.status === "accepted" && entry.acceptance.acceptedAt === undefined) {
      diagnostics.push(
        evidenceDiagnostic({
          code: "missing_accepted_at",
          message: `Accepted evidence bundle ${entry.evidence.id} requires acceptedAt.`,
          path: input.artifactPath
        })
      );
    }

    if (entry.acceptance.status === "rejected" && entry.acceptance.reason.length === 0) {
      diagnostics.push(
        evidenceDiagnostic({
          code: "missing_rejection_reason",
          message: `Rejected evidence bundle ${entry.evidence.id} requires a reason.`,
          path: input.artifactPath
        })
      );
    }

    for (const [itemIndex, item] of entry.evidence.items.entries()) {
      if (item.artifact === undefined && item.command === undefined) {
        diagnostics.push(
          evidenceDiagnostic({
            code: "missing_evidence_hash",
            message: `Evidence item ${entryIndex}.${itemIndex} must include an artifact reference or command output hash.`,
            path: input.artifactPath
          })
        );
      }
    }
  }

  return diagnostics;
}

function normalizeEntries(input: {
  readonly entries: readonly EvidenceIndexEntry[];
  readonly changeId: ChangeId;
  readonly artifactPath: ArtifactPath;
}): readonly EvidenceIndexEntry[] | EvidenceIndexFailure {
  const entries: EvidenceIndexEntry[] = [];
  for (const entry of input.entries) {
    const acceptanceDiagnostics = rawAcceptanceDiagnostics({
      entry,
      artifactPath: input.artifactPath
    });
    if (acceptanceDiagnostics.length > 0) return failure("invalid", acceptanceDiagnostics);

    const parsed = evidenceIndexEntrySchema.safeParse(entry);
    if (!parsed.success) {
      return failure("invalid", schemaDiagnostics({ code: "invalid_evidence_index", path: input.artifactPath, issues: parsed.error.issues }));
    }
    entries.push(parsed.data);
  }

  const diagnostics = validateEntries({
    entries,
    changeId: input.changeId,
    artifactPath: input.artifactPath
  });
  if (diagnostics.length > 0) return failure("invalid", diagnostics);

  return entries.sort((left, right) => compareStrings(left.evidence.id, right.evidence.id));
}

function evidenceReferences(entries: readonly EvidenceIndexEntry[]): readonly ArtifactReference[] {
  const referencesByKey = new Map<string, ArtifactReference>();
  for (const entry of entries) {
    for (const item of entry.evidence.items) {
      if (item.artifact === undefined) continue;
      referencesByKey.set(`${item.artifact.path}\0${item.artifact.sha256}`, item.artifact);
    }
  }
  return [...referencesByKey.values()].sort(compareReferences);
}

function normalizeEvidenceIndex(input: {
  readonly changeId: ChangeId;
  readonly revision: number;
  readonly entries: readonly EvidenceIndexEntry[];
  readonly artifactInputs: readonly ArtifactRevision[];
  readonly artifactPath: ArtifactPath;
}): EvidenceIndexDocument | EvidenceIndexFailure {
  const artifactInputIssues = artifactInputDiagnostics({
    artifactInputs: input.artifactInputs,
    artifactPath: input.artifactPath
  });
  if (artifactInputIssues.length > 0) return failure("invalid", artifactInputIssues);

  const entries = normalizeEntries({
    entries: input.entries,
    changeId: input.changeId,
    artifactPath: input.artifactPath
  });
  if ("diagnostics" in entries) return entries;

  const artifactInputs = [...input.artifactInputs].sort(compareArtifactRevisions);
  const documentInput = {
    schemaVersion: EVIDENCE_INDEX_SCHEMA_VERSION,
    kind: "evidence-index" as const,
    changeId: input.changeId,
    revision: input.revision,
    entries,
    artifactManifest: deriveChangeArtifactManifest({
      changeId: input.changeId,
      inputs: artifactInputs,
      evidenceRefs: evidenceReferences(entries)
    })
  };

  const parsed = evidenceIndexDocumentSchema.safeParse(documentInput);
  if (!parsed.success) {
    return failure("invalid", schemaDiagnostics({ code: "invalid_evidence_index", path: input.artifactPath, issues: parsed.error.issues }));
  }
  return parsed.data;
}

export async function writeEvidenceIndex(input: WriteEvidenceIndexInput): Promise<EvidenceIndexResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;

  const artifactPath = evidenceIndexPath(changeId);
  const expectedRevision = input.expectedRevision ?? 0;
  const revisionError = assertExpectedRevision(expectedRevision, artifactPath);
  if (revisionError !== undefined) return revisionError;

  const baseGitSha = parseBaseGitSha(input.baseGitSha, artifactPath);
  if (baseGitSha !== undefined && typeof baseGitSha !== "string") return baseGitSha;

  let supersedes: ArtifactReference | undefined;
  if (expectedRevision > 0) {
    const current = await readEvidenceIndex({
      repositoryRoot: input.repositoryRoot,
      changeId
    });
    if (!current.ok) return current;
    if (current.document.revision !== expectedRevision) {
      return failure("conflict", [
        evidenceDiagnostic({
          code: "revision_conflict",
          message: `stale artifact revision: expected ${expectedRevision}, current ${current.document.revision}`,
          path: artifactPath
        })
      ]);
    }
    supersedes = current.reference;
  }

  const document = normalizeEvidenceIndex({
    changeId,
    revision: expectedRevision + 1,
    entries: input.entries,
    artifactInputs: input.artifactInputs,
    artifactPath
  });
  if ("diagnostics" in document) return document;

  const content = stableProtocolJson(document);
  try {
    const write = await writeRevisionedArtifact({
      repositoryRoot: input.repositoryRoot,
      artifactPath,
      role: "evidence-index",
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
        evidenceDiagnostic({
          code: "revision_conflict",
          message: error.message,
          path: artifactPath
        })
      ]);
    }
    throw error;
  }
}

export async function readEvidenceIndex(input: ReadEvidenceIndexInput): Promise<EvidenceIndexResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;

  const artifactPath = evidenceIndexPath(changeId);
  const read = await readJsonArtifact({
    repositoryRoot: input.repositoryRoot,
    artifactPath,
    schema: evidenceIndexDocumentSchema
  });

  if (!read.ok) {
    const status = read.diagnostics.some((diagnostic) => diagnostic.code === "not_found") ? "not_found" : "invalid";
    return failure(status, read.diagnostics);
  }

  if (read.value.changeId !== changeId) {
    return failure("invalid", [
      evidenceDiagnostic({
        code: "evidence_index_change_mismatch",
        message: `Evidence index change ID ${read.value.changeId} does not match requested change ${changeId}.`,
        path: artifactPath
      })
    ]);
  }

  const manifestDiagnostics = manifestHashDiagnostics({
    document: read.value,
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
      role: "evidence-index",
      path: artifactPath,
      content: read.bytes,
      revision: read.value.revision,
      mediaType: "application/json"
    }),
    diagnostics: []
  };
}
