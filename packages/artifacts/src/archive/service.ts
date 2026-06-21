import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import {
  changeIdSchema,
  utcTimestampSchema,
  type ArtifactPath,
  type ArtifactReference,
  type ArtifactRevision,
  type ChangeId,
  type ContentHash,
  type Requirement,
  type RequirementId,
  type UtcTimestamp
} from "@legion/protocol";

import {
  ArtifactRevisionConflictError,
  writeRevisionedArtifact,
  type BeforeArtifactCommitContext
} from "../atomic-write.js";
import { loadChangeBundle, validateChangeBundle, type ChangeBundleSuccess } from "../changes/service.js";
import { readEvidenceIndex, type EvidenceIndexSuccess } from "../evidence-index/service.js";
import { deriveOracleManifest, type OracleManifestSuccess } from "../oracles/service.js";
import { artifactPathForRole, diagnosticForPath, resolveProjectArtifactPath, type ArtifactDiagnostic } from "../paths.js";
import {
  artifactReferenceForContent,
  artifactRevisionForContent,
  hashContent,
  readJsonArtifact,
  stableProtocolJson
} from "../revisions.js";
import {
  CURRENT_SPEC_SCHEMA_VERSION,
  currentSpecIndexSchema,
  type CurrentSpecDocument,
  type CurrentSpecIndex
} from "../specs/schema.js";
import {
  createCurrentSpec,
  diffCurrentSpecIndexes,
  listCurrentSpecs,
  parseCurrentSpecMarkdown,
  renderCurrentSpecMarkdown,
  updateCurrentSpec,
  type CurrentSpecListSuccess
} from "../specs/service.js";
import { readTaskGraph, type TaskGraphSuccess } from "../taskgraphs/service.js";
import { validateChangeTraceability } from "../traceability/service.js";
import {
  ARCHIVE_SCHEMA_VERSION,
  archiveRecordSchema,
  archivePreviewSchema,
  type ArchiveCurrentSpecWrite,
  type ArchivePreview,
  type ArchiveRecord,
  type RetainedArchiveArtifacts
} from "./schema.js";

export interface PlanAcceptedChangeArchiveInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
  readonly outputBranch?: string;
}

export interface ArchiveAcceptedChangeInput extends PlanAcceptedChangeArchiveInput {
  readonly archivedAt: UtcTimestamp | string;
  readonly archivedBy: string;
  readonly beforeArchiveCommit?: (context: BeforeArtifactCommitContext) => Promise<void> | void;
}

export interface ReadArchiveRecordInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
}

export interface ArchivePlanSuccess {
  readonly ok: true;
  readonly status: "planned";
  readonly preview: ArchivePreview;
  readonly diagnostics: readonly [];
}

export interface ArchiveApplySuccess {
  readonly ok: true;
  readonly status: "archived" | "already_archived";
  readonly record: ArchiveRecord;
  readonly artifactPath: ArtifactPath;
  readonly reference: ArtifactReference;
  readonly revision: ArtifactRevision;
  readonly diagnostics: readonly [];
}

export interface ArchiveReadSuccess {
  readonly ok: true;
  readonly status: "read";
  readonly record: ArchiveRecord;
  readonly artifactPath: ArtifactPath;
  readonly reference: ArtifactReference;
  readonly revision: ArtifactRevision;
  readonly diagnostics: readonly [];
}

export interface ArchiveFailure {
  readonly ok: false;
  readonly status: "invalid" | "not_found" | "conflict";
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

export type ArchivePlanResult = ArchivePlanSuccess | ArchiveFailure;
export type ArchiveApplyResult = ArchiveApplySuccess | ArchiveFailure;
export type ArchiveReadResult = ArchiveReadSuccess | ArchiveFailure;

interface PlannedCurrentSpecWrite {
  readonly operation: "create" | "update";
  readonly path: ArtifactPath;
  readonly expectedRevision: number;
  readonly document: CurrentSpecDocument;
  readonly before?: ArtifactReference;
  readonly after: ArtifactReference;
}

interface PlannedCurrentSpecDelete {
  readonly operation: "delete";
  readonly path: ArtifactPath;
  readonly expectedRevision: number;
  readonly before: ArtifactReference;
}

type PlannedCurrentSpec = PlannedCurrentSpecWrite | PlannedCurrentSpecDelete;

interface InternalArchivePlan extends ArchivePlanSuccess {
  readonly change: ChangeBundleSuccess;
  readonly currentSpecs: CurrentSpecListSuccess;
  readonly taskGraph: TaskGraphSuccess;
  readonly evidenceIndex: EvidenceIndexSuccess;
  readonly oracleManifest: OracleManifestSuccess;
  readonly plannedSpecs: readonly PlannedCurrentSpec[];
}

interface FileBackup {
  readonly path: ArtifactPath;
  readonly absolutePath: string;
  readonly existed: boolean;
  readonly bytes?: Uint8Array;
}

type RollbackGuard =
  | { readonly kind: "content"; readonly sha256: ContentHash }
  | { readonly kind: "missing" };

const execFileAsync = promisify(execFile);
const INVALID_ARCHIVE_PATH = ".legion/project/changes/invalid-change/archive.json" as ArtifactPath;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function failure(status: ArchiveFailure["status"], diagnostics: readonly ArtifactDiagnostic[]): ArchiveFailure {
  return { ok: false, status, diagnostics };
}

function archiveDiagnostic(input: {
  readonly code: string;
  readonly message: string;
  readonly path?: ArtifactPath;
}): ArtifactDiagnostic {
  return diagnosticForPath({
    code: input.code,
    message: input.message,
    path: input.path ?? INVALID_ARCHIVE_PATH
  });
}

function parseChangeId(input: ChangeId | string): ChangeId | ArchiveFailure {
  const parsed = changeIdSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        archiveDiagnostic({
          code: "invalid_change_id",
          message: issue.message
        })
      )
    );
  }
  return parsed.data;
}

function parseArchivedAt(input: UtcTimestamp | string, path: ArtifactPath): UtcTimestamp | ArchiveFailure {
  const parsed = utcTimestampSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        archiveDiagnostic({
          code: "invalid_archived_at",
          message: issue.message,
          path
        })
      )
    );
  }
  return parsed.data;
}

function archivePath(changeId: ChangeId): ArtifactPath {
  return artifactPathForRole({ role: "archive", changeId });
}

function archiveHashInput(record: ArchiveRecord): Omit<ArchiveRecord, "archiveHash"> {
  const { archiveHash: _archiveHash, ...input } = record;
  return input;
}

function expectedArchiveHash(input: Omit<ArchiveRecord, "archiveHash">): ContentHash {
  return hashContent(stableProtocolJson(input));
}

function archiveRecordWithHash(input: Omit<ArchiveRecord, "archiveHash">): ArchiveRecord | ArchiveFailure {
  const parsed = archiveRecordSchema.safeParse({
    ...input,
    archiveHash: expectedArchiveHash(input)
  });
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        archiveDiagnostic({
          code: "invalid_archive_record",
          message: `${issue.message}${issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
          path: archivePath(input.changeId)
        })
      )
    );
  }
  return parsed.data;
}

function archiveHashDiagnostics(record: ArchiveRecord, path: ArtifactPath): readonly ArtifactDiagnostic[] {
  const expected = expectedArchiveHash(archiveHashInput(record));
  if (record.archiveHash === expected) return [];
  return [
    archiveDiagnostic({
      code: "archive_hash_mismatch",
      message: `Archive hash ${record.archiveHash} does not match expected ${expected}.`,
      path
    })
  ];
}

async function assertWorktreeTarget(input: PlanAcceptedChangeArchiveInput, path: ArtifactPath): Promise<ArchiveFailure | undefined> {
  if (input.outputBranch !== undefined && input.outputBranch.length > 0) return undefined;

  try {
    const result = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: input.repositoryRoot,
      encoding: "utf8"
    });
    if (result.stdout.trim().length === 0) return undefined;
    return failure("conflict", [
      archiveDiagnostic({
        code: "dirty_worktree",
        message: "Archive requires a clean worktree or an explicit outputBranch.",
        path
      })
    ]);
  } catch (error) {
    return failure("invalid", [
      archiveDiagnostic({
        code: "worktree_status_unavailable",
        message: error instanceof Error ? error.message : String(error),
        path
      })
    ]);
  }
}

function asArchiveFailure(status: ArchiveFailure["status"], diagnostics: readonly ArtifactDiagnostic[]): ArchiveFailure {
  return failure(status, diagnostics);
}

function findRevision(input: {
  readonly change: ChangeBundleSuccess;
  readonly role: ArtifactRevision["role"];
  readonly path: ArtifactPath;
}): ArtifactRevision | ArchiveFailure {
  const revision = input.change.bundle.artifactRevisions.find((entry) =>
    entry.role === input.role && entry.artifact.path === input.path
  );
  if (revision !== undefined) return revision;
  return failure("invalid", [
    archiveDiagnostic({
      code: "missing_change_artifact_revision",
      message: `Change bundle is missing ${input.role} revision for ${input.path}.`,
      path: input.change.artifactPath
    })
  ]);
}

function documentByPath(currentSpecs: CurrentSpecListSuccess): Map<ArtifactPath, CurrentSpecDocument> {
  const byPrimaryRequirement = new Map(currentSpecs.documents.map((document) => [document.primaryRequirementId, document]));
  const byPath = new Map<ArtifactPath, CurrentSpecDocument>();
  for (const entry of currentSpecs.index.entries) {
    const document = byPrimaryRequirement.get(entry.primaryRequirementId);
    if (document !== undefined) byPath.set(entry.path, document);
  }
  return byPath;
}

function entryForRequirement(currentSpecs: CurrentSpecListSuccess): Map<RequirementId, CurrentSpecIndex["entries"][number]> {
  const byRequirement = new Map<RequirementId, CurrentSpecIndex["entries"][number]>();
  for (const entry of currentSpecs.index.entries) {
    for (const requirement of entry.requirements) {
      byRequirement.set(requirement.id, entry);
    }
  }
  return byRequirement;
}

function capabilityIdForRequirement(requirementId: RequirementId): string {
  return requirementId.replace(/^req_/, "");
}

function currentSpecPathForRequirement(requirementId: RequirementId): ArtifactPath {
  return artifactPathForRole({ role: "current-spec", requirementId });
}

function cloneDocument(document: CurrentSpecDocument): CurrentSpecDocument {
  return structuredClone(document);
}

function isPlannedSpecWrite(spec: PlannedCurrentSpec): spec is PlannedCurrentSpecWrite {
  return spec.operation !== "delete";
}

function retargetRequirementTraceRefs(requirement: Requirement, artifactPath: ArtifactPath): Requirement {
  return {
    ...requirement,
    traceRefs: requirement.traceRefs.map((traceRef) => {
      const definesSelf = traceRef.relation === "defines" &&
        traceRef.entity?.kind === "requirement" &&
        traceRef.entity.id === requirement.id;
      return definesSelf ? { ...traceRef, path: artifactPath, anchor: requirement.id } : traceRef;
    })
  };
}

function applyProposedSections(input: {
  readonly document: CurrentSpecDocument;
  readonly sections: NonNullable<import("../changes/schema.js").ChangeDeltaSpec["sections"]>;
}): CurrentSpecDocument {
  return {
    ...input.document,
    sections: input.sections
  };
}

function updateRequirement(input: {
  readonly document: CurrentSpecDocument;
  readonly requirementId: RequirementId;
  readonly requirement: Requirement;
}): CurrentSpecDocument {
  return {
    ...input.document,
    requirements: input.document.requirements.map((requirement) =>
      requirement.id === input.requirementId ? input.requirement : requirement
    )
  };
}

function archiveRemovedRequirement(input: {
  readonly path: ArtifactPath;
  readonly document: CurrentSpecDocument;
  readonly requirementId: RequirementId;
  readonly acceptedAt: UtcTimestamp;
}): {
  readonly path: ArtifactPath;
  readonly document: CurrentSpecDocument;
  readonly deletePath?: ArtifactPath;
} {
  const remaining = input.document.requirements.filter((requirement) => requirement.id !== input.requirementId);
  if (remaining.length > 0) {
    const firstRemaining = remaining[0];
    if (firstRemaining === undefined) throw new Error("remaining requirement set cannot be empty");
    const primaryRequirementId = input.document.primaryRequirementId === input.requirementId
      ? firstRemaining.id
      : input.document.primaryRequirementId;
    const path = currentSpecPathForRequirement(primaryRequirementId);
    const moved = path !== input.path;
    const requirements = moved ? remaining.map((requirement) => retargetRequirementTraceRefs(requirement, path)) : remaining;
    return {
      path,
      ...(moved ? { deletePath: input.path } : {}),
      document: {
        ...input.document,
        primaryRequirementId,
        capability: moved
          ? {
              ...input.document.capability,
              id: capabilityIdForRequirement(primaryRequirementId),
              title: `${capabilityIdForRequirement(primaryRequirementId)} capability`
            }
          : input.document.capability,
        requirements,
        sections: {
          ...input.document.sections,
          traceIds: input.document.sections.traceIds.filter((requirementId) => requirementId !== input.requirementId)
        }
      }
    };
  }

  return {
    path: input.path,
    document: {
      ...input.document,
      capability: {
        ...input.document.capability,
        status: "deprecated",
        deprecatedAt: input.acceptedAt,
        deprecationReason: `Requirement ${input.requirementId} was removed by accepted archive.`
      },
      requirements: input.document.requirements.map((requirement) =>
        requirement.id === input.requirementId ? { ...requirement, status: "archived" as const } : requirement
      )
    }
  };
}

function plannedIndexEntry(input: {
  readonly path: ArtifactPath;
  readonly document: CurrentSpecDocument;
}): CurrentSpecIndex["entries"][number] {
  const content = renderCurrentSpecMarkdown(input.document);
  return currentSpecIndexSchema.shape.entries.element.parse({
    path: input.path,
    revision: input.document.revision,
    capability: input.document.capability,
    primaryRequirementId: input.document.primaryRequirementId,
    requirements: input.document.requirements
      .map((requirement) => ({
        id: requirement.id,
        contentHash: hashContent(stableProtocolJson(requirement))
      }))
      .sort((left, right) => compareStrings(left.id, right.id)),
    artifact: artifactReferenceForContent({
      path: input.path,
      content,
      mediaType: "text/markdown"
    })
  });
}

function plannedIndex(entries: readonly {
  readonly path: ArtifactPath;
  readonly document: CurrentSpecDocument;
}[]): CurrentSpecIndex | ArchiveFailure {
  const parsed = currentSpecIndexSchema.safeParse({
    schemaVersion: CURRENT_SPEC_SCHEMA_VERSION,
    kind: "current-spec-index",
    entries: entries
      .map(plannedIndexEntry)
      .sort((left, right) => compareStrings(left.path, right.path))
  });
  if (parsed.success) return parsed.data;
  return failure(
    "invalid",
    parsed.error.issues.map((issue) =>
      archiveDiagnostic({
        code: "invalid_current_spec_index",
        message: `${issue.message}${issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`
      })
    )
  );
}

function validatePlannedDocument(path: ArtifactPath, document: CurrentSpecDocument): ArchiveFailure | undefined {
  const parsed = parseCurrentSpecMarkdown({
    artifactPath: path,
    content: renderCurrentSpecMarkdown(document)
  });
  if (parsed.ok) return undefined;
  return failure(parsed.status === "conflict" ? "conflict" : "invalid", parsed.diagnostics);
}

function buildPlannedSpecs(input: {
  readonly change: ChangeBundleSuccess;
  readonly currentSpecs: CurrentSpecListSuccess;
}): readonly PlannedCurrentSpec[] | ArchiveFailure {
  const docsByPath = documentByPath(input.currentSpecs);
  const entriesByRequirement = entryForRequirement(input.currentSpecs);
  const deltaPaths = new Map(input.change.bundle.deltas.map((delta) => [delta.requirementId, delta.path]));
  const plannedDocs = new Map<ArtifactPath, CurrentSpecDocument>(
    [...docsByPath.entries()].map(([path, document]) => [path, cloneDocument(document)])
  );
  const touchedPaths = new Set<ArtifactPath>();
  const deletedPaths = new Set<ArtifactPath>();
  const acceptedAt = input.change.bundle.change.acceptance?.status === "accepted"
    ? input.change.bundle.change.acceptance.acceptedAt
    : undefined;

  if (acceptedAt === undefined) {
    return failure("invalid", [
      archiveDiagnostic({
        code: "change_not_accepted",
        message: "Change must carry accepted acceptance state before archive.",
        path: input.change.artifactPath
      })
    ]);
  }

  for (const delta of input.change.deltaSpecs) {
    if (delta.operation === "add") {
      if (delta.proposedRequirement === undefined || delta.sections === undefined) {
        return failure("invalid", [
          archiveDiagnostic({
            code: "ambiguous_delta",
            message: `Add delta ${delta.requirementId} is missing proposed current-spec content.`,
            path: input.change.bundle.paths.proposal
          })
        ]);
      }
      const path = currentSpecPathForRequirement(delta.requirementId);
      if (plannedDocs.has(path)) {
        return failure("conflict", [
          archiveDiagnostic({
            code: "current_spec_already_exists",
            message: `Archive add target already exists: ${path}.`,
            path
          })
        ]);
      }
      plannedDocs.set(path, {
        schemaVersion: CURRENT_SPEC_SCHEMA_VERSION,
        kind: "current-spec",
        revision: 1,
        primaryRequirementId: delta.requirementId,
        capability: {
          id: capabilityIdForRequirement(delta.requirementId),
          title: `${capabilityIdForRequirement(delta.requirementId)} capability`,
          status: "active"
        },
        requirements: [delta.proposedRequirement],
        sections: delta.sections
      });
      touchedPaths.add(path);
      continue;
    }

    const basePath = delta.baseCurrentSpec?.path ?? entriesByRequirement.get(delta.requirementId)?.path;
    if (basePath === undefined) {
      return failure("invalid", [
        archiveDiagnostic({
          code: "stale_change_base",
          message: `Current spec base for ${delta.requirementId} is missing from the archive plan.`,
          path: deltaPaths.get(delta.requirementId) ?? input.change.artifactPath
        })
      ]);
    }
    const currentDocument = plannedDocs.get(basePath);
    if (currentDocument === undefined) {
      return failure("invalid", [
        archiveDiagnostic({
          code: "stale_change_base",
          message: `Current spec base ${basePath} for ${delta.requirementId} is not loaded.`,
          path: deltaPaths.get(delta.requirementId) ?? input.change.artifactPath
        })
      ]);
    }

    let nextDocument = currentDocument;
    let targetPath = basePath;
    if (delta.operation === "modify") {
      if (delta.proposedRequirement === undefined || delta.sections === undefined) {
        return failure("invalid", [
          archiveDiagnostic({
            code: "ambiguous_delta",
            message: `Modify delta ${delta.requirementId} is missing proposed current-spec content.`,
            path: deltaPaths.get(delta.requirementId) ?? input.change.artifactPath
          })
        ]);
      }
      nextDocument = updateRequirement({
        document: applyProposedSections({ document: nextDocument, sections: delta.sections }),
        requirementId: delta.requirementId,
        requirement: delta.proposedRequirement
      });
    } else {
      const removal = archiveRemovedRequirement({
        path: basePath,
        document: nextDocument,
        requirementId: delta.requirementId,
        acceptedAt
      });
      nextDocument = removal.document;
      targetPath = removal.path;
      if (removal.deletePath !== undefined) {
        plannedDocs.delete(removal.deletePath);
        deletedPaths.add(removal.deletePath);
      }
    }
    const baseEntry = input.currentSpecs.index.entries.find((entry) => entry.path === basePath);
    const currentRevision = baseEntry?.revision ?? currentDocument.revision;
    plannedDocs.set(targetPath, {
      ...nextDocument,
      revision: targetPath === basePath ? currentRevision + 1 : 1
    });
    touchedPaths.add(targetPath);
  }

  const plannedSpecs: PlannedCurrentSpec[] = [];
  for (const deletePath of [...deletedPaths].sort(compareStrings)) {
    const beforeEntry = input.currentSpecs.index.entries.find((entry) => entry.path === deletePath);
    if (beforeEntry === undefined) {
      return failure("invalid", [
        archiveDiagnostic({
          code: "stale_change_base",
          message: `Deleted current spec base ${deletePath} is not present in the current spec index.`,
          path: deletePath
        })
      ]);
    }
    plannedSpecs.push({
      operation: "delete",
      path: deletePath,
      expectedRevision: beforeEntry.revision,
      before: beforeEntry.artifact
    });
  }

  for (const specPath of [...touchedPaths].sort(compareStrings)) {
    const document = plannedDocs.get(specPath);
    if (document === undefined) continue;
    const validation = validatePlannedDocument(specPath, document);
    if (validation !== undefined) return validation;
    const beforeEntry = input.currentSpecs.index.entries.find((entry) => entry.path === specPath);
    const after = artifactReferenceForContent({
      path: specPath,
      content: renderCurrentSpecMarkdown(document),
      mediaType: "text/markdown"
    });
    plannedSpecs.push({
      operation: beforeEntry === undefined ? "create" : "update",
      path: specPath,
      expectedRevision: beforeEntry?.revision ?? 0,
      document,
      ...(beforeEntry?.artifact === undefined ? {} : { before: beforeEntry.artifact }),
      after
    });
  }

  return plannedSpecs;
}

function retainedArtifacts(input: {
  readonly change: ChangeBundleSuccess;
  readonly oracleManifest: OracleManifestSuccess;
  readonly taskGraph: TaskGraphSuccess;
  readonly evidenceIndex: EvidenceIndexSuccess;
}): RetainedArchiveArtifacts | ArchiveFailure {
  const design = findRevision({
    change: input.change,
    role: "design",
    path: input.change.bundle.paths.design
  });
  if ("diagnostics" in design) return design;
  const decisions = findRevision({
    change: input.change,
    role: "decision-log",
    path: input.change.bundle.paths.decisions
  });
  if ("diagnostics" in decisions) return decisions;

  return {
    proposal: input.change.reference,
    deltas: input.change.bundle.deltas.map((delta) => delta.delta).sort((left, right) => compareStrings(left.path, right.path)),
    design: design.artifact,
    decisions: decisions.artifact,
    oracles: input.oracleManifest.manifest.oracles.map((revision) => revision.artifact),
    taskgraph: input.taskGraph.reference,
    evidenceIndex: input.evidenceIndex.reference
  };
}

function previewFromPlan(input: {
  readonly changeId: ChangeId;
  readonly currentSpecs: CurrentSpecListSuccess;
  readonly plannedSpecs: readonly PlannedCurrentSpec[];
}): ArchivePreview | ArchiveFailure {
  const unchangedEntries = input.currentSpecs.index.entries.filter((entry) =>
    !input.plannedSpecs.some((spec) => spec.path === entry.path)
  );
  const writeSpecs = input.plannedSpecs.filter(isPlannedSpecWrite);
  const afterEntries = [
    ...unchangedEntries.map((entry) => ({
      path: entry.path,
      document: input.currentSpecs.documents.find((document) => document.primaryRequirementId === entry.primaryRequirementId)
    })),
    ...writeSpecs.map((spec) => ({ path: spec.path, document: spec.document }))
  ];
  const completeEntries = afterEntries.filter((entry): entry is { readonly path: ArtifactPath; readonly document: CurrentSpecDocument } =>
    entry.document !== undefined
  );
  const afterIndex = plannedIndex(completeEntries);
  if ("diagnostics" in afterIndex) return afterIndex;

  const currentSpecWrites: ArchiveCurrentSpecWrite[] = input.plannedSpecs.map((spec) => {
    if (spec.operation === "delete") {
      return {
        operation: "delete",
        path: spec.path,
        expectedRevision: spec.expectedRevision,
        before: spec.before
      };
    }
    const write = {
      operation: spec.operation,
      path: spec.path,
      expectedRevision: spec.expectedRevision,
      nextRevision: spec.document.revision,
      ...(spec.before === undefined ? {} : { before: spec.before }),
      after: spec.after
    };
    return write;
  });

  const preview = archivePreviewSchema.safeParse({
    changeId: input.changeId,
    beforeSpecHash: input.currentSpecs.indexHash,
    afterSpecHash: hashContent(stableProtocolJson(afterIndex)),
    diff: diffCurrentSpecIndexes({
      before: input.currentSpecs.index,
      after: afterIndex
    }),
    currentSpecWrites
  });
  if (preview.success) return preview.data;
  return failure(
    "invalid",
    preview.error.issues.map((issue) =>
      archiveDiagnostic({
        code: "invalid_archive_preview",
        message: `${issue.message}${issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
        path: archivePath(input.changeId)
      })
    )
  );
}

async function buildArchivePlan(input: PlanAcceptedChangeArchiveInput): Promise<InternalArchivePlan | ArchiveFailure> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;
  const path = archivePath(changeId);
  const worktree = await assertWorktreeTarget(input, path);
  if (worktree !== undefined) return worktree;

  const change = await loadChangeBundle({ repositoryRoot: input.repositoryRoot, changeId });
  if (!change.ok) return asArchiveFailure(change.status === "not_found" ? "not_found" : change.status, change.diagnostics);
  if (change.bundle.change.status !== "accepted" || change.bundle.change.acceptance?.status !== "accepted") {
    return failure("invalid", [
      archiveDiagnostic({
        code: "change_not_accepted",
        message: "Only accepted changes can be archived into current truth.",
        path: change.artifactPath
      })
    ]);
  }

  const changeValidation = await validateChangeBundle({ repositoryRoot: input.repositoryRoot, changeId });
  if (!changeValidation.ok) return asArchiveFailure(changeValidation.status, changeValidation.diagnostics);

  const traceability = await validateChangeTraceability({ repositoryRoot: input.repositoryRoot, changeId });
  if (!traceability.ok) return asArchiveFailure(traceability.status === "not_found" ? "not_found" : "invalid", traceability.diagnostics);

  const currentSpecs = await listCurrentSpecs({ repositoryRoot: input.repositoryRoot });
  if (!currentSpecs.ok) return asArchiveFailure(currentSpecs.status, currentSpecs.diagnostics);

  const plannedSpecs = buildPlannedSpecs({ change, currentSpecs });
  if ("diagnostics" in plannedSpecs) return plannedSpecs;

  const taskGraph = await readTaskGraph({ repositoryRoot: input.repositoryRoot, changeId });
  if (!taskGraph.ok) return asArchiveFailure(taskGraph.status === "not_found" ? "not_found" : taskGraph.status, taskGraph.diagnostics);
  const evidenceIndex = await readEvidenceIndex({ repositoryRoot: input.repositoryRoot, changeId });
  if (!evidenceIndex.ok) return asArchiveFailure(evidenceIndex.status === "not_found" ? "not_found" : evidenceIndex.status, evidenceIndex.diagnostics);
  const oracleManifest = await deriveOracleManifest({ repositoryRoot: input.repositoryRoot, changeId });
  if (!oracleManifest.ok) return asArchiveFailure(oracleManifest.status === "not_found" ? "not_found" : oracleManifest.status, oracleManifest.diagnostics);

  const preview = previewFromPlan({ changeId, currentSpecs, plannedSpecs });
  if ("diagnostics" in preview) return preview;

  return {
    ok: true,
    status: "planned",
    preview,
    change,
    currentSpecs,
    taskGraph,
    evidenceIndex,
    oracleManifest,
    plannedSpecs,
    diagnostics: []
  };
}

export async function planAcceptedChangeArchive(input: PlanAcceptedChangeArchiveInput): Promise<ArchivePlanResult> {
  const plan = await buildArchivePlan(input);
  if (!plan.ok) return plan;
  return {
    ok: true,
    status: "planned",
    preview: plan.preview,
    diagnostics: []
  };
}

async function backupFiles(input: {
  readonly repositoryRoot: string;
  readonly plannedSpecs: readonly PlannedCurrentSpec[];
  readonly archivePath: ArtifactPath;
}): Promise<readonly FileBackup[] | ArchiveFailure> {
  const backups: FileBackup[] = [];
  for (const artifactPath of [...input.plannedSpecs.map((spec) => spec.path), input.archivePath]) {
    let resolved;
    try {
      resolved = await resolveProjectArtifactPath({
        repositoryRoot: input.repositoryRoot,
        artifactPath
      });
    } catch (error) {
      return failure("invalid", [
        archiveDiagnostic({
          code: "invalid_path",
          message: error instanceof Error ? error.message : String(error),
          path: artifactPath
        })
      ]);
    }

    try {
      const bytes = await readFile(resolved.absolutePath);
      backups.push({ path: artifactPath, absolutePath: resolved.absolutePath, existed: true, bytes });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        backups.push({ path: artifactPath, absolutePath: resolved.absolutePath, existed: false });
        continue;
      }
      throw error;
    }
  }
  return backups;
}

async function rollbackGuardMatches(backup: FileBackup, guard: RollbackGuard): Promise<boolean> {
  try {
    const bytes = await readFile(backup.absolutePath);
    return guard.kind === "content" ? hashContent(bytes) === guard.sha256 : false;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return guard.kind === "missing";
    }
    throw error;
  }
}

async function rollbackFiles(backups: readonly FileBackup[], guards: ReadonlyMap<ArtifactPath, RollbackGuard>): Promise<void> {
  for (const backup of [...backups].reverse()) {
    const guard = guards.get(backup.path);
    if (guard !== undefined && !(await rollbackGuardMatches(backup, guard))) continue;
    if (backup.existed) {
      if (backup.bytes !== undefined) await writeFile(backup.absolutePath, backup.bytes);
      continue;
    }
    await rm(backup.absolutePath, { force: true });
  }
}

function rollbackGuardsForPlannedSpecs(plannedSpecs: readonly PlannedCurrentSpec[]): ReadonlyMap<ArtifactPath, RollbackGuard> {
  const guards = new Map<ArtifactPath, RollbackGuard>();
  for (const spec of plannedSpecs) {
    guards.set(spec.path, spec.operation === "delete" ? { kind: "missing" } : { kind: "content", sha256: spec.after.sha256 });
  }
  return guards;
}

async function deletePlannedSpec(input: {
  readonly repositoryRoot: string;
  readonly spec: PlannedCurrentSpecDelete;
}): Promise<ArchiveFailure | undefined> {
  const resolved = await resolveProjectArtifactPath({
    repositoryRoot: input.repositoryRoot,
    artifactPath: input.spec.path
  });
  let bytes: Uint8Array;
  try {
    bytes = await readFile(resolved.absolutePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return failure("invalid", [
        archiveDiagnostic({
          code: "stale_spec_revision",
          message: `Expected current spec ${input.spec.path} to exist before archive removal.`,
          path: input.spec.path
        })
      ]);
    }
    throw error;
  }

  if (hashContent(bytes) !== input.spec.before.sha256) {
    return failure("invalid", [
      archiveDiagnostic({
        code: "stale_spec_revision",
        message: `Current spec ${input.spec.path} no longer matches the archived base content.`,
        path: input.spec.path
      })
    ]);
  }

  const parsed = parseCurrentSpecMarkdown({
    artifactPath: input.spec.path,
    content: Buffer.from(bytes).toString("utf8")
  });
  if (!parsed.ok) return asArchiveFailure(parsed.status === "conflict" ? "conflict" : "invalid", parsed.diagnostics);
  if (parsed.document.revision !== input.spec.expectedRevision) {
    return failure("invalid", [
      archiveDiagnostic({
        code: "stale_spec_revision",
        message: `Expected current spec revision ${input.spec.expectedRevision}, but current revision is ${parsed.document.revision}.`,
        path: input.spec.path
      })
    ]);
  }

  await rm(resolved.absolutePath, { force: false });
  return undefined;
}

async function writePlannedSpecs(input: {
  readonly repositoryRoot: string;
  readonly plannedSpecs: readonly PlannedCurrentSpec[];
}): Promise<readonly ArtifactRevision[] | ArchiveFailure> {
  const revisions: ArtifactRevision[] = [];
  for (const spec of input.plannedSpecs) {
    if (spec.operation === "delete") {
      const deleted = await deletePlannedSpec({
        repositoryRoot: input.repositoryRoot,
        spec
      });
      if (deleted !== undefined) return deleted;
      continue;
    }
    const written = spec.operation === "create"
      ? await createCurrentSpec({
          repositoryRoot: input.repositoryRoot,
          document: spec.document
        })
      : await updateCurrentSpec({
          repositoryRoot: input.repositoryRoot,
          expectedRevision: spec.expectedRevision,
          document: spec.document
        });
    if (!written.ok) return asArchiveFailure(written.status, written.diagnostics);
    revisions.push(written.revision);
  }
  return revisions;
}

async function writeArchiveRecord(input: {
  readonly repositoryRoot: string;
  readonly record: ArchiveRecord;
  readonly beforeArchiveCommit?: (context: BeforeArtifactCommitContext) => Promise<void> | void;
}): Promise<ArchiveApplySuccess | ArchiveFailure> {
  const artifactPath = archivePath(input.record.changeId);
  const content = stableProtocolJson(input.record);
  try {
    const write = await writeRevisionedArtifact({
      repositoryRoot: input.repositoryRoot,
      artifactPath,
      role: "archive",
      content,
      expectedRevision: 0,
      currentRevision: 0,
      mediaType: "application/json",
      ...(input.beforeArchiveCommit === undefined ? {} : { beforeCommit: input.beforeArchiveCommit })
    });
    return {
      ok: true,
      status: "archived",
      record: input.record,
      artifactPath: write.artifactPath,
      reference: write.reference,
      revision: write.revision,
      diagnostics: []
    };
  } catch (error) {
    if (error instanceof ArtifactRevisionConflictError || error instanceof Error) {
      return failure("conflict", [
        archiveDiagnostic({
          code: "archive_write_failed",
          message: error.message,
          path: artifactPath
        })
      ]);
    }
    throw error;
  }
}

export async function readArchiveRecord(input: ReadArchiveRecordInput): Promise<ArchiveReadResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;
  const path = archivePath(changeId);

  const read = await readJsonArtifact({
    repositoryRoot: input.repositoryRoot,
    artifactPath: path,
    schema: archiveRecordSchema
  });
  if (!read.ok) {
    const status = read.diagnostics.some((diagnostic) => diagnostic.code === "not_found") ? "not_found" : "invalid";
    return failure(status, read.diagnostics);
  }

  if (read.value.changeId !== changeId) {
    return failure("invalid", [
      archiveDiagnostic({
        code: "archive_change_mismatch",
        message: `Archive record change ID ${read.value.changeId} does not match requested change ${changeId}.`,
        path
      })
    ]);
  }

  const hashDiagnostics = archiveHashDiagnostics(read.value, path);
  if (hashDiagnostics.length > 0) return failure("invalid", hashDiagnostics);

  return {
    ok: true,
    status: "read",
    record: read.value,
    artifactPath: path,
    reference: read.reference,
    revision: artifactRevisionForContent({
      role: "archive",
      path,
      content: read.bytes,
      revision: read.value.revision,
      mediaType: "application/json"
    }),
    diagnostics: []
  };
}

export async function archiveAcceptedChange(input: ArchiveAcceptedChangeInput): Promise<ArchiveApplyResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;

  const existing = await readArchiveRecord({
    repositoryRoot: input.repositoryRoot,
    changeId
  });
  if (existing.ok) {
    const current = await listCurrentSpecs({ repositoryRoot: input.repositoryRoot });
    if (!current.ok) return asArchiveFailure(current.status, current.diagnostics);
    if (current.indexHash !== existing.record.preview.afterSpecHash) {
      return failure("conflict", [
        archiveDiagnostic({
          code: "archive_current_truth_mismatch",
          message: `Current truth hash ${current.indexHash} does not match archived target hash ${existing.record.preview.afterSpecHash}.`,
          path: existing.artifactPath
        })
      ]);
    }
    return {
      ok: true,
      status: "already_archived",
      record: existing.record,
      artifactPath: existing.artifactPath,
      reference: existing.reference,
      revision: existing.revision,
      diagnostics: []
    };
  }
  if (existing.status !== "not_found") return existing;

  const archivedAt = parseArchivedAt(input.archivedAt, archivePath(changeId));
  if (typeof archivedAt !== "string") return archivedAt;
  if (input.archivedBy.length === 0) {
    return failure("invalid", [
      archiveDiagnostic({
        code: "invalid_archived_by",
        message: "Archive requires a non-empty archivedBy actor ID.",
        path: archivePath(changeId)
      })
    ]);
  }

  const plan = await buildArchivePlan(input);
  if (!plan.ok) return plan;

  const backups = await backupFiles({
    repositoryRoot: input.repositoryRoot,
    plannedSpecs: plan.plannedSpecs,
    archivePath: archivePath(changeId)
  });
  if ("diagnostics" in backups) return backups;
  const rollbackGuards = rollbackGuardsForPlannedSpecs(plan.plannedSpecs);

  try {
    const currentSpecRevisions = await writePlannedSpecs({
      repositoryRoot: input.repositoryRoot,
      plannedSpecs: plan.plannedSpecs
    });
    if ("diagnostics" in currentSpecRevisions) {
      await rollbackFiles(backups, rollbackGuards);
      return currentSpecRevisions;
    }

    const currentAfterWrites = await listCurrentSpecs({ repositoryRoot: input.repositoryRoot });
    if (!currentAfterWrites.ok) {
      await rollbackFiles(backups, rollbackGuards);
      return asArchiveFailure(currentAfterWrites.status, currentAfterWrites.diagnostics);
    }
    if (currentAfterWrites.indexHash !== plan.preview.afterSpecHash) {
      await rollbackFiles(backups, rollbackGuards);
      return failure("conflict", [
        archiveDiagnostic({
          code: "archive_current_truth_mismatch",
          message: `Applied current truth hash ${currentAfterWrites.indexHash} does not match planned hash ${plan.preview.afterSpecHash}.`,
          path: archivePath(changeId)
        })
      ]);
    }

    const retained = retainedArtifacts({
      change: plan.change,
      oracleManifest: plan.oracleManifest,
      taskGraph: plan.taskGraph,
      evidenceIndex: plan.evidenceIndex
    });
    if ("diagnostics" in retained) {
      await rollbackFiles(backups, rollbackGuards);
      return retained;
    }

    const record = archiveRecordWithHash({
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      kind: "change-archive",
      revision: 1,
      changeId,
      archivedAt,
      archivedBy: input.archivedBy,
      preview: plan.preview,
      retainedArtifacts: retained,
      currentSpecRevisions: [...currentSpecRevisions].sort((left, right) => compareStrings(left.artifact.path, right.artifact.path))
    });
    if ("diagnostics" in record) {
      await rollbackFiles(backups, rollbackGuards);
      return record;
    }

    const write = await writeArchiveRecord({
      repositoryRoot: input.repositoryRoot,
      record,
      ...(input.beforeArchiveCommit === undefined ? {} : { beforeArchiveCommit: input.beforeArchiveCommit })
    });
    if (!write.ok) {
      await rollbackFiles(backups, rollbackGuards);
      return write;
    }

    return write;
  } catch (error) {
    await rollbackFiles(backups, rollbackGuards);
    return failure("conflict", [
      archiveDiagnostic({
        code: "archive_write_failed",
        message: error instanceof Error ? error.message : String(error),
        path: archivePath(changeId)
      })
    ]);
  }
}
