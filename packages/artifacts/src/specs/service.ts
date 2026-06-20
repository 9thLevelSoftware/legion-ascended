import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  requirementIdSchema,
  utcTimestampSchema,
  type ArtifactPath,
  type ArtifactReference,
  type ArtifactRevision,
  type Requirement,
  type RequirementId,
  type UtcTimestamp
} from "@legion/protocol";

import {
  ArtifactRevisionConflictError,
  writeRevisionedArtifact
} from "../atomic-write.js";
import {
  PROJECT_ARTIFACT_PATHS,
  artifactPathForRole,
  diagnosticForPath,
  resolveProjectArtifactPath,
  type ArtifactDiagnostic
} from "../paths.js";
import {
  artifactReferenceForContent,
  artifactRevisionForContent,
  hashContent,
  stableProtocolJson
} from "../revisions.js";
import {
  CURRENT_SPEC_SCHEMA_VERSION,
  currentSpecDocumentSchema,
  currentSpecIndexSchema,
  type CurrentSpecCapability,
  type CurrentSpecDocument,
  type CurrentSpecIndex,
  type CurrentSpecIndexEntry,
  type CurrentSpecSections
} from "./schema.js";

export interface CreateCurrentSpecInput {
  readonly repositoryRoot: string;
  readonly document: CurrentSpecDocumentDraft;
}

export interface ReadCurrentSpecInput {
  readonly repositoryRoot: string;
  readonly requirementId: RequirementId | string;
}

export interface ListCurrentSpecsInput {
  readonly repositoryRoot: string;
}

export interface UpdateCurrentSpecInput {
  readonly repositoryRoot: string;
  readonly expectedRevision: number;
  readonly document: CurrentSpecDocumentDraft;
}

export interface RenameCurrentSpecInput {
  readonly repositoryRoot: string;
  readonly requirementId: RequirementId | string;
  readonly expectedRevision: number;
  readonly capability: {
    readonly id?: string;
    readonly title: string;
  };
}

export interface DeprecateCurrentSpecInput {
  readonly repositoryRoot: string;
  readonly requirementId: RequirementId | string;
  readonly expectedRevision: number;
  readonly deprecatedAt: UtcTimestamp | string;
  readonly reason: string;
}

export interface DiffCurrentSpecIndexesInput {
  readonly before: CurrentSpecIndex;
  readonly after: CurrentSpecIndex;
}

export type CurrentSpecDocumentDraft = Omit<CurrentSpecDocument, "schemaVersion" | "kind" | "revision"> & {
  readonly schemaVersion?: CurrentSpecDocument["schemaVersion"];
  readonly kind?: CurrentSpecDocument["kind"];
  readonly revision?: number;
};

export interface CurrentSpecSuccess {
  readonly ok: true;
  readonly status: "created" | "read" | "updated" | "renamed" | "deprecated";
  readonly document: CurrentSpecDocument;
  readonly artifactPath: ArtifactPath;
  readonly reference: ArtifactReference;
  readonly revision: ArtifactRevision;
  readonly diagnostics: readonly [];
}

export interface CurrentSpecListSuccess {
  readonly ok: true;
  readonly documents: readonly CurrentSpecDocument[];
  readonly index: CurrentSpecIndex;
  readonly indexHash: ReturnType<typeof hashContent>;
  readonly diagnostics: readonly [];
}

export interface CurrentSpecFailure {
  readonly ok: false;
  readonly status: "invalid" | "not_found" | "conflict";
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

export type CurrentSpecResult = CurrentSpecSuccess | CurrentSpecFailure;
export type CurrentSpecListResult = CurrentSpecListSuccess | CurrentSpecFailure;
export type ValidateCurrentSpecsResult = CurrentSpecListSuccess | CurrentSpecFailure;

export interface CurrentSpecDiff {
  readonly added: readonly RequirementId[];
  readonly modified: readonly RequirementId[];
  readonly removed: readonly RequirementId[];
  readonly moved: readonly {
    readonly id: RequirementId;
    readonly from: ArtifactPath;
    readonly to: ArtifactPath;
  }[];
}

const SECTION_HEADINGS = {
  purpose: "Purpose",
  behaviors: "Behaviors",
  constraints: "Constraints",
  scenarios: "Scenarios",
  interfaces: "Interfaces",
  compatibility: "Compatibility",
  failureModes: "Failure Modes",
  traceIds: "Trace IDs"
} as const;

const REQUIRED_SECTION_KEYS = Object.keys(SECTION_HEADINGS) as (keyof typeof SECTION_HEADINGS)[];
const PLACEHOLDER_PATTERN = /\b(?:todo|tbd|fixme)\b|<[^>\n]+>/i;

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function failure(status: CurrentSpecFailure["status"], diagnostics: readonly ArtifactDiagnostic[]): CurrentSpecFailure {
  return { ok: false, status, diagnostics };
}

function specDiagnostic(input: {
  readonly code: string;
  readonly message: string;
  readonly path: ArtifactPath;
  readonly line?: number;
}): ArtifactDiagnostic {
  return diagnosticForPath({
    code: input.code,
    message: input.message,
    path: input.path,
    ...(input.line === undefined ? {} : { line: input.line })
  });
}

function normalizeRequirementId(input: RequirementId | string): RequirementId {
  return requirementIdSchema.parse(input);
}

function specPathForRequirement(requirementId: RequirementId | string): ArtifactPath {
  return artifactPathForRole({ role: "current-spec", requirementId });
}

function normalizeDocument(input: CurrentSpecDocumentDraft, revision: number): CurrentSpecDocument | {
  readonly diagnostics: readonly ArtifactDiagnostic[];
} {
  const path = specPathForRequirement(input.primaryRequirementId);
  const parsed = currentSpecDocumentSchema.safeParse({
    ...input,
    schemaVersion: input.schemaVersion ?? CURRENT_SPEC_SCHEMA_VERSION,
    kind: input.kind ?? "current-spec",
    revision
  });

  if (!parsed.success) {
    return {
      diagnostics: parsed.error.issues.map((issue) =>
        specDiagnostic({
          code: "invalid_schema",
          message: `${issue.message}${issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
          path
        })
      )
    };
  }

  return parsed.data;
}

function frontmatterForDocument(document: CurrentSpecDocument): Omit<CurrentSpecDocument, "sections"> {
  return {
    schemaVersion: document.schemaVersion,
    kind: document.kind,
    revision: document.revision,
    primaryRequirementId: document.primaryRequirementId,
    capability: document.capability,
    requirements: document.requirements
  };
}

export function renderCurrentSpecMarkdown(document: CurrentSpecDocument): string {
  const frontmatter = stableProtocolJson(frontmatterForDocument(document)).trimEnd();
  return [
    "---",
    frontmatter,
    "---",
    "",
    `# ${document.capability.title}`,
    "",
    "## Purpose",
    "",
    document.sections.purpose,
    "",
    "## Behaviors",
    "",
    document.sections.behaviors,
    "",
    "## Constraints",
    "",
    document.sections.constraints,
    "",
    "## Scenarios",
    "",
    document.sections.scenarios,
    "",
    "## Interfaces",
    "",
    document.sections.interfaces,
    "",
    "## Compatibility",
    "",
    document.sections.compatibility,
    "",
    "## Failure Modes",
    "",
    document.sections.failureModes,
    "",
    "## Trace IDs",
    "",
    ...document.sections.traceIds.map((id) => `- ${id}`),
    ""
  ].join("\n");
}

function parseSections(body: string, artifactPath: ArtifactPath): CurrentSpecSections | {
  readonly diagnostics: readonly ArtifactDiagnostic[];
} {
  const matches = [...body.matchAll(/^## ([^\n#]+)\s*$/gm)];
  const byHeading = new Map<string, string>();
  const diagnostics: ArtifactDiagnostic[] = [];

  for (const [index, match] of matches.entries()) {
    const heading = match[1]?.trim();
    if (!heading || match.index === undefined) continue;
    const contentStart = match.index + match[0].length;
    const next = matches[index + 1];
    const contentEnd = next?.index ?? body.length;
    byHeading.set(heading, body.slice(contentStart, contentEnd).trim());
  }

  const sections: Partial<Record<keyof CurrentSpecSections, string | RequirementId[]>> = {};
  for (const key of REQUIRED_SECTION_KEYS) {
    const heading = SECTION_HEADINGS[key];
    const value = byHeading.get(heading);
    if (value === undefined || value.length === 0) {
      diagnostics.push(
        specDiagnostic({
          code: "missing_section",
          message: `Current spec is missing required section: ${heading}.`,
          path: artifactPath
        })
      );
      continue;
    }

    if (key === "traceIds") {
      const ids = [...value.matchAll(/\breq_[a-z0-9][a-z0-9-]{1,62}[a-z0-9]\b/g)].map((match) =>
        normalizeRequirementId(match[0])
      );
      sections.traceIds = ids;
      continue;
    }

    sections[key] = value;
  }

  if (diagnostics.length > 0) return { diagnostics };
  const parsed = currentSpecDocumentSchema.shape.sections.safeParse(sections);
  if (!parsed.success) {
    return {
      diagnostics: parsed.error.issues.map((issue) =>
        specDiagnostic({
          code: "invalid_section",
          message: `${issue.message}${issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
          path: artifactPath
        })
      )
    };
  }

  return parsed.data;
}

export function parseCurrentSpecMarkdown(input: {
  readonly artifactPath: ArtifactPath;
  readonly content: string;
}): { readonly ok: true; readonly document: CurrentSpecDocument } | CurrentSpecFailure {
  const normalized = input.content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return failure("invalid", [
      specDiagnostic({
        code: "missing_frontmatter",
        message: "Current spec must start with JSON frontmatter.",
        path: input.artifactPath
      })
    ]);
  }

  const closeIndex = normalized.indexOf("\n---\n", 4);
  if (closeIndex < 0) {
    return failure("invalid", [
      specDiagnostic({
        code: "unterminated_frontmatter",
        message: "Current spec frontmatter must close with --- on its own line.",
        path: input.artifactPath
      })
    ]);
  }

  const rawFrontmatter = normalized.slice(4, closeIndex).trim();
  const rawBody = normalized.slice(closeIndex + "\n---\n".length);
  let frontmatter: unknown;
  try {
    frontmatter = JSON.parse(rawFrontmatter);
  } catch (error) {
    return failure("invalid", [
      specDiagnostic({
        code: "invalid_frontmatter_json",
        message: error instanceof Error ? error.message : "Current spec frontmatter is not valid JSON.",
        path: input.artifactPath
      })
    ]);
  }

  const sections = parseSections(rawBody, input.artifactPath);
  if ("diagnostics" in sections) return failure("invalid", sections.diagnostics);

  const parsed = currentSpecDocumentSchema.safeParse({
    ...(typeof frontmatter === "object" && frontmatter !== null ? frontmatter : {}),
    sections
  });
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        specDiagnostic({
          code: "invalid_schema",
          message: `${issue.message}${issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
          path: input.artifactPath
        })
      )
    );
  }

  const diagnostics = validateDocumentSemantics(parsed.data, input.artifactPath);
  if (diagnostics.length > 0) return failure("invalid", diagnostics);

  return { ok: true, document: parsed.data };
}

function validateDocumentSemantics(document: CurrentSpecDocument, artifactPath: ArtifactPath): readonly ArtifactDiagnostic[] {
  const diagnostics: ArtifactDiagnostic[] = [];
  const expectedPath = specPathForRequirement(document.primaryRequirementId);
  if (artifactPath !== expectedPath) {
    diagnostics.push(
      specDiagnostic({
        code: "spec_path_mismatch",
        message: `Current spec for ${document.primaryRequirementId} must be stored at ${expectedPath}.`,
        path: artifactPath
      })
    );
  }

  const requirementIds = new Set(document.requirements.map((requirement) => requirement.id));
  for (const requirement of document.requirements) {
    const definesSelf = requirement.traceRefs.some((traceRef) =>
      traceRef.path === artifactPath &&
      traceRef.anchor === requirement.id &&
      traceRef.relation === "defines" &&
      traceRef.entity?.kind === "requirement" &&
      traceRef.entity.id === requirement.id
    );
    if (!definesSelf) {
      diagnostics.push(
        specDiagnostic({
          code: "missing_stable_anchor",
          message: `Requirement ${requirement.id} must define a stable trace reference to ${artifactPath}#${requirement.id}.`,
          path: artifactPath
        })
      );
    }
  }

  for (const value of Object.values(document.sections)) {
    if (Array.isArray(value)) continue;
    if (PLACEHOLDER_PATTERN.test(value)) {
      diagnostics.push(
        specDiagnostic({
          code: "unresolved_placeholder",
          message: "Current spec sections must not contain TODO/TBD/FIXME or angle-bracket placeholders.",
          path: artifactPath
        })
      );
      break;
    }
  }

  const traceIdSet = new Set(document.sections.traceIds);
  for (const requirementId of document.sections.traceIds) {
    if (!requirementIds.has(requirementId)) {
      diagnostics.push(
        specDiagnostic({
          code: "orphan_trace_id",
          message: `Trace IDs section references ${requirementId}, but no requirement with that ID exists in the spec.`,
          path: artifactPath
        })
      );
    }
  }
  for (const requirementId of requirementIds) {
    if (!traceIdSet.has(requirementId)) {
      diagnostics.push(
        specDiagnostic({
          code: "missing_trace_id",
          message: `Trace IDs section must include requirement ${requirementId}.`,
          path: artifactPath
        })
      );
    }
  }

  if (document.capability.status === "active") {
    for (const requirement of document.requirements) {
      if (requirement.status !== "accepted") {
        diagnostics.push(
          specDiagnostic({
            code: "contradictory_status",
            message: `Active current specs may only contain accepted requirements; ${requirement.id} is ${requirement.status}.`,
            path: artifactPath
          })
        );
      }
    }
  } else {
    for (const requirement of document.requirements) {
      if (requirement.status === "accepted" || requirement.status === "draft" || requirement.status === "proposed") {
        diagnostics.push(
          specDiagnostic({
            code: "contradictory_status",
            message: `Deprecated current specs cannot contain active requirement ${requirement.id} with status ${requirement.status}.`,
            path: artifactPath
          })
        );
      }
    }
  }

  return diagnostics;
}

async function readSpecByPath(input: {
  readonly repositoryRoot: string;
  readonly artifactPath: ArtifactPath;
}): Promise<CurrentSpecSuccess | CurrentSpecFailure> {
  let resolved;
  try {
    resolved = await resolveProjectArtifactPath({
      repositoryRoot: input.repositoryRoot,
      artifactPath: input.artifactPath
    });
  } catch (error) {
    return failure("invalid", [
      specDiagnostic({
        code: "invalid_path",
        message: error instanceof Error ? error.message : String(error),
        path: input.artifactPath
      })
    ]);
  }

  let content: string;
  try {
    content = await readFile(resolved.absolutePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return failure("not_found", [
        specDiagnostic({
          code: "not_found",
          message: "Current spec artifact does not exist.",
          path: resolved.repositoryPath
        })
      ]);
    }
    throw error;
  }

  const parsed = parseCurrentSpecMarkdown({ artifactPath: resolved.repositoryPath, content });
  if (!parsed.ok) return parsed;

  const reference = artifactReferenceForContent({
    path: resolved.repositoryPath,
    content,
    mediaType: "text/markdown"
  });
  const revision = artifactRevisionForContent({
    role: "current-spec",
    path: resolved.repositoryPath,
    content,
    revision: parsed.document.revision,
    mediaType: "text/markdown"
  });

  return {
    ok: true,
    status: "read",
    document: parsed.document,
    artifactPath: resolved.repositoryPath,
    reference,
    revision,
    diagnostics: []
  };
}

function indexEntryForSpec(spec: CurrentSpecSuccess): CurrentSpecIndexEntry {
  return currentSpecIndexSchema.shape.entries.element.parse({
    path: spec.artifactPath,
    revision: spec.document.revision,
    capability: spec.document.capability,
    primaryRequirementId: spec.document.primaryRequirementId,
    requirements: spec.document.requirements
      .map((requirement) => ({
        id: requirement.id,
        contentHash: hashContent(stableProtocolJson(requirement))
      }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    artifact: spec.reference
  });
}

function duplicateRequirementDiagnostics(entries: readonly CurrentSpecIndexEntry[]): readonly ArtifactDiagnostic[] {
  const seen = new Map<RequirementId, ArtifactPath>();
  const diagnostics: ArtifactDiagnostic[] = [];

  for (const entry of entries) {
    for (const requirement of entry.requirements) {
      const priorPath = seen.get(requirement.id);
      if (priorPath !== undefined && priorPath !== entry.path) {
        diagnostics.push(
          specDiagnostic({
            code: "duplicate_requirement_id",
            message: `Requirement ${requirement.id} appears in both ${priorPath} and ${entry.path}.`,
            path: entry.path
          })
        );
        continue;
      }
      seen.set(requirement.id, entry.path);
    }
  }

  return diagnostics;
}

async function readAllSpecs(repositoryRoot: string): Promise<CurrentSpecSuccess[] | CurrentSpecFailure> {
  const specsRoot = path.join(repositoryRoot, ...PROJECT_ARTIFACT_PATHS.currentSpecs.split("/"));
  let entries;
  try {
    entries = await readdir(specsRoot, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }

  const specs: CurrentSpecSuccess[] = [];
  const markdownFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();

  for (const fileName of markdownFiles) {
    const artifactPath = `${PROJECT_ARTIFACT_PATHS.currentSpecs}/${fileName}` as ArtifactPath;
    const spec = await readSpecByPath({ repositoryRoot, artifactPath });
    if (!spec.ok) return spec;
    specs.push(spec);
  }
  return specs;
}

function buildIndex(specs: readonly CurrentSpecSuccess[]): CurrentSpecIndex {
  return currentSpecIndexSchema.parse({
    schemaVersion: CURRENT_SPEC_SCHEMA_VERSION,
    kind: "current-spec-index",
    entries: specs.map(indexEntryForSpec).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  });
}

async function validateAgainstExistingSpecs(input: {
  readonly repositoryRoot: string;
  readonly candidate: CurrentSpecSuccess;
  readonly excludePath?: ArtifactPath;
}): Promise<readonly ArtifactDiagnostic[]> {
  const existing = await readAllSpecs(input.repositoryRoot);
  if (!Array.isArray(existing)) return existing.diagnostics;
  const comparable = existing.filter((spec) => spec.artifactPath !== input.excludePath);
  return duplicateRequirementDiagnostics([...comparable.map(indexEntryForSpec), indexEntryForSpec(input.candidate)]);
}

function candidateSuccess(input: {
  readonly document: CurrentSpecDocument;
  readonly artifactPath: ArtifactPath;
  readonly content: string;
  readonly status: CurrentSpecSuccess["status"];
}): CurrentSpecSuccess {
  return {
    ok: true,
    status: input.status,
    document: input.document,
    artifactPath: input.artifactPath,
    reference: artifactReferenceForContent({
      path: input.artifactPath,
      content: input.content,
      mediaType: "text/markdown"
    }),
    revision: artifactRevisionForContent({
      role: "current-spec",
      path: input.artifactPath,
      content: input.content,
      revision: input.document.revision,
      mediaType: "text/markdown"
    }),
    diagnostics: []
  };
}

async function writeCurrentSpec(input: {
  readonly repositoryRoot: string;
  readonly document: CurrentSpecDocument;
  readonly artifactPath: ArtifactPath;
  readonly currentRevision: number;
  readonly expectedRevision: number;
  readonly supersedes?: ArtifactReference;
  readonly status: CurrentSpecSuccess["status"];
}): Promise<CurrentSpecResult> {
  const content = renderCurrentSpecMarkdown(input.document);
  try {
    const write = await writeRevisionedArtifact({
      repositoryRoot: input.repositoryRoot,
      artifactPath: input.artifactPath,
      role: "current-spec",
      content,
      expectedRevision: input.expectedRevision,
      currentRevision: input.currentRevision,
      ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
      mediaType: "text/markdown"
    });

    return {
      ok: true,
      status: input.status,
      document: input.document,
      artifactPath: write.artifactPath,
      reference: write.reference,
      revision: write.revision,
      diagnostics: []
    };
  } catch (error) {
    if (error instanceof ArtifactRevisionConflictError) {
      return failure("conflict", [
        specDiagnostic({
          code: "revision_conflict",
          message: error.message,
          path: input.artifactPath
        })
      ]);
    }
    throw error;
  }
}

export async function createCurrentSpec(input: CreateCurrentSpecInput): Promise<CurrentSpecResult> {
  const normalized = normalizeDocument(input.document, 1);
  if ("diagnostics" in normalized) return failure("invalid", normalized.diagnostics);

  const artifactPath = specPathForRequirement(normalized.primaryRequirementId);
  const diagnostics = validateDocumentSemantics(normalized, artifactPath);
  if (diagnostics.length > 0) return failure("invalid", diagnostics);

  const candidateContent = renderCurrentSpecMarkdown(normalized);
  const candidate = candidateSuccess({
    document: normalized,
    artifactPath,
    content: candidateContent,
    status: "created"
  });
  const duplicateDiagnostics = await validateAgainstExistingSpecs({ repositoryRoot: input.repositoryRoot, candidate });
  if (duplicateDiagnostics.length > 0) return failure("invalid", duplicateDiagnostics);

  return writeCurrentSpec({
    repositoryRoot: input.repositoryRoot,
    document: normalized,
    artifactPath,
    currentRevision: 0,
    expectedRevision: 0,
    status: "created"
  });
}

export async function readCurrentSpec(input: ReadCurrentSpecInput): Promise<CurrentSpecResult> {
  return readSpecByPath({
    repositoryRoot: input.repositoryRoot,
    artifactPath: specPathForRequirement(input.requirementId)
  });
}

export async function listCurrentSpecs(input: ListCurrentSpecsInput): Promise<CurrentSpecListResult> {
  const specs = await readAllSpecs(input.repositoryRoot);
  if (!Array.isArray(specs)) return specs;

  const index = buildIndex(specs);
  const duplicateDiagnostics = duplicateRequirementDiagnostics(index.entries);
  if (duplicateDiagnostics.length > 0) return failure("invalid", duplicateDiagnostics);

  return {
    ok: true,
    documents: specs.map((spec) => spec.document),
    index,
    indexHash: hashContent(stableProtocolJson(index)),
    diagnostics: []
  };
}

export async function validateCurrentSpecs(input: ListCurrentSpecsInput): Promise<ValidateCurrentSpecsResult> {
  return listCurrentSpecs(input);
}

export async function updateCurrentSpec(input: UpdateCurrentSpecInput): Promise<CurrentSpecResult> {
  const expectedPath = specPathForRequirement(input.document.primaryRequirementId);
  const current = await readSpecByPath({
    repositoryRoot: input.repositoryRoot,
    artifactPath: expectedPath
  });
  if (!current.ok) return current;

  if (input.expectedRevision !== current.document.revision) {
    return failure("invalid", [
      specDiagnostic({
        code: "stale_spec_revision",
        message: `Expected current spec revision ${input.expectedRevision}, but current revision is ${current.document.revision}.`,
        path: current.artifactPath
      })
    ]);
  }

  const normalized = normalizeDocument(input.document, current.document.revision + 1);
  if ("diagnostics" in normalized) return failure("invalid", normalized.diagnostics);

  if (normalized.primaryRequirementId !== current.document.primaryRequirementId) {
    return failure("invalid", [
      specDiagnostic({
        code: "primary_requirement_changed",
        message: "Current spec updates cannot change the primary requirement ID; create a new spec and archive the old one instead.",
        path: current.artifactPath
      })
    ]);
  }

  const diagnostics = validateDocumentSemantics(normalized, current.artifactPath);
  if (diagnostics.length > 0) return failure("invalid", diagnostics);

  const candidate = candidateSuccess({
    document: normalized,
    artifactPath: current.artifactPath,
    content: renderCurrentSpecMarkdown(normalized),
    status: "updated"
  });
  const duplicateDiagnostics = await validateAgainstExistingSpecs({
    repositoryRoot: input.repositoryRoot,
    candidate,
    excludePath: current.artifactPath
  });
  if (duplicateDiagnostics.length > 0) return failure("invalid", duplicateDiagnostics);

  return writeCurrentSpec({
    repositoryRoot: input.repositoryRoot,
    document: normalized,
    artifactPath: current.artifactPath,
    currentRevision: current.document.revision,
    expectedRevision: input.expectedRevision,
    supersedes: current.reference,
    status: "updated"
  });
}

export async function renameCurrentSpec(input: RenameCurrentSpecInput): Promise<CurrentSpecResult> {
  const current = await readCurrentSpec(input);
  if (!current.ok) return current;

  if (input.capability.id !== undefined && input.capability.id !== current.document.capability.id) {
    return failure("invalid", [
      specDiagnostic({
        code: "capability_id_change_blocked",
        message: "Renaming a capability ID is not supported. Create a new spec and archive the old one instead.",
        path: current.artifactPath
      })
    ]);
  }

  const updatedCapability: CurrentSpecCapability = {
    ...current.document.capability,
    title: input.capability.title
  };
  const result = await updateCurrentSpec({
    repositoryRoot: input.repositoryRoot,
    expectedRevision: input.expectedRevision,
    document: {
      ...current.document,
      capability: updatedCapability
    }
  });
  return result.ok ? { ...result, status: "renamed" } : result;
}

export async function deprecateCurrentSpec(input: DeprecateCurrentSpecInput): Promise<CurrentSpecResult> {
  const current = await readCurrentSpec(input);
  if (!current.ok) return current;

  const archivedRequirements = current.document.requirements.map((requirement) => ({
    ...requirement,
    status: "archived" as const
  }));
  const result = await updateCurrentSpec({
    repositoryRoot: input.repositoryRoot,
    expectedRevision: input.expectedRevision,
    document: {
      ...current.document,
      capability: {
        ...current.document.capability,
        status: "deprecated",
        deprecatedAt: utcTimestampSchema.parse(input.deprecatedAt),
        deprecationReason: input.reason
      },
      requirements: archivedRequirements
    }
  });
  return result.ok ? { ...result, status: "deprecated" } : result;
}

function requirementLocations(index: CurrentSpecIndex): Map<RequirementId, {
  readonly path: ArtifactPath;
  readonly contentHash: ReturnType<typeof hashContent>;
}> {
  const map = new Map<RequirementId, {
    readonly path: ArtifactPath;
    readonly contentHash: ReturnType<typeof hashContent>;
  }>();

  for (const entry of index.entries) {
    for (const requirement of entry.requirements) {
      map.set(requirement.id, {
        path: entry.path,
        contentHash: requirement.contentHash
      });
    }
  }

  return map;
}

export function diffCurrentSpecIndexes(input: DiffCurrentSpecIndexesInput): CurrentSpecDiff {
  const before = requirementLocations(input.before);
  const after = requirementLocations(input.after);
  const added: RequirementId[] = [];
  const modified: RequirementId[] = [];
  const removed: RequirementId[] = [];
  const moved: {
    readonly id: RequirementId;
    readonly from: ArtifactPath;
    readonly to: ArtifactPath;
  }[] = [];

  for (const [id, afterLocation] of [...after.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    const beforeLocation = before.get(id);
    if (beforeLocation === undefined) {
      added.push(id);
      continue;
    }
    if (beforeLocation.path !== afterLocation.path) {
      moved.push({ id, from: beforeLocation.path, to: afterLocation.path });
    }
    if (beforeLocation.contentHash !== afterLocation.contentHash) {
      modified.push(id);
    }
  }

  for (const id of [...before.keys()].sort()) {
    if (!after.has(id)) removed.push(id);
  }

  return { added, modified, removed, moved };
}
