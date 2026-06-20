import { readFile, stat } from "node:fs/promises";

import {
  LEGION_PROTOCOL_VERSION,
  actorSchema,
  changeIdSchema,
  decisionIdSchema,
  decisionSchema,
  gitShaSchema,
  projectIdSchema,
  requirementIdSchema,
  utcTimestampSchema,
  type Actor,
  type ArtifactPath,
  type ArtifactReference,
  type ArtifactRevision,
  type Change,
  type ChangeId,
  type ContentHash,
  type Decision,
  type DecisionAlternative,
  type DecisionId,
  type GitSha,
  type ProjectId,
  type Requirement,
  type RequirementId,
  type RiskProfile,
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
  readJsonArtifact,
  stableProtocolJson
} from "../revisions.js";
import {
  listCurrentSpecs,
  parseCurrentSpecMarkdown,
  readCurrentSpec,
  type CurrentSpecSuccess
} from "../specs/service.js";
import {
  CHANGE_BUNDLE_SCHEMA_VERSION,
  changeBundleSchema,
  changeDecisionLogSchema,
  changeDeltaSpecSchema,
  changeDesignDocumentSchema,
  type ChangeBundle,
  type ChangeDecisionLog,
  type ChangeDeltaSpec,
  type ChangeDesignDocument,
  type DeltaOperation
} from "./schema.js";

export interface ChangeBaseSpecInput {
  readonly requirementId: RequirementId | string;
  readonly expectedRevision: number;
}

export interface ChangeDeltaSpecInput {
  readonly operation: DeltaOperation;
  readonly requirementId: RequirementId | string;
  readonly proposedRequirement?: Requirement;
  readonly sections?: ChangeDeltaSpec["sections"];
  readonly rationale: string;
  readonly dependencies?: readonly ArtifactReference[];
}

export interface ChangeDesignInput {
  readonly title: string;
  readonly body: string;
  readonly dependencies?: readonly ArtifactReference[];
}

export interface ChangeDecisionInput {
  readonly id: DecisionId | string;
  readonly status: Decision["status"];
  readonly title: string;
  readonly context: string;
  readonly alternatives: readonly DecisionAlternative[];
  readonly rationale: string;
  readonly supersedes: readonly DecisionId[];
  readonly approver?: Actor;
  readonly decidedAt?: UtcTimestamp | string;
  readonly supersededBy?: DecisionId | string;
  readonly createdAt?: UtcTimestamp | string;
}

export interface CreateChangeBundleInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
  readonly projectId: ProjectId | string;
  readonly title: string;
  readonly summary: string;
  readonly owners: readonly Actor[];
  readonly baseGitSha: GitSha;
  readonly risk: RiskProfile;
  readonly createdAt?: UtcTimestamp | string;
  readonly currentSpecs: readonly ChangeBaseSpecInput[];
  readonly deltaSpecs: readonly ChangeDeltaSpecInput[];
  readonly design: ChangeDesignInput;
  readonly decisions?: readonly ChangeDecisionInput[];
}

export interface LoadChangeBundleInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
}

export interface ValidateChangeBundleInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
}

export interface ChangeBundleSuccess {
  readonly ok: true;
  readonly status: "created" | "read" | "validated";
  readonly bundle: ChangeBundle;
  readonly deltaSpecs: readonly ChangeDeltaSpec[];
  readonly design: ChangeDesignDocument;
  readonly decisions: readonly Decision[];
  readonly artifactPath: ArtifactPath;
  readonly reference: ArtifactReference;
  readonly revision: ArtifactRevision;
  readonly diagnostics: readonly [];
}

export interface ChangeBundleFailure {
  readonly ok: false;
  readonly status: "invalid" | "not_found" | "conflict";
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

export interface ChangeBundleDiff {
  readonly added: readonly RequirementId[];
  readonly modified: readonly RequirementId[];
  readonly removed: readonly RequirementId[];
}

export type ChangeBundleResult = ChangeBundleSuccess | ChangeBundleFailure;
export type ValidateChangeBundleResult = { readonly ok: true; readonly diagnostics: readonly [] } | ChangeBundleFailure;

interface ParsedMarkdownArtifact<T> {
  readonly document: T;
  readonly content: string;
  readonly reference: ArtifactReference;
}

interface BaseRequirement {
  readonly spec: CurrentSpecSuccess;
  readonly requirement: Requirement;
  readonly requirementHash: ContentHash;
}

const INVALID_CHANGE_BUNDLE_PATH = `${PROJECT_ARTIFACT_PATHS.changes}/invalid-change/change.yaml` as ArtifactPath;

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function failure(status: ChangeBundleFailure["status"], diagnostics: readonly ArtifactDiagnostic[]): ChangeBundleFailure {
  return { ok: false, status, diagnostics };
}

function changeDiagnostic(input: {
  readonly code: string;
  readonly message: string;
  readonly path?: ArtifactPath;
}): ArtifactDiagnostic {
  return diagnosticForPath({
    code: input.code,
    message: input.message,
    path: input.path ?? INVALID_CHANGE_BUNDLE_PATH
  });
}

function parseChangeId(input: ChangeId | string): ChangeId | ChangeBundleFailure {
  const parsed = changeIdSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        changeDiagnostic({
          code: "invalid_change_id",
          message: issue.message
        })
      )
    );
  }
  return parsed.data;
}

function parseRequirementId(input: RequirementId | string, path: ArtifactPath): RequirementId | ChangeBundleFailure {
  const parsed = requirementIdSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        changeDiagnostic({
          code: "invalid_requirement_id",
          message: issue.message,
          path
        })
      )
    );
  }
  return parsed.data;
}

function parseTimestamp(input: {
  readonly value: UtcTimestamp | string | undefined;
  readonly path: ArtifactPath;
  readonly code: string;
}): UtcTimestamp | ChangeBundleFailure {
  const parsed = utcTimestampSchema.safeParse(input.value ?? new Date().toISOString());
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        changeDiagnostic({
          code: input.code,
          message: issue.message,
          path: input.path
        })
      )
    );
  }
  return parsed.data;
}

function parseBaseGitSha(input: GitSha | string, path: ArtifactPath): GitSha | ChangeBundleFailure {
  const parsed = gitShaSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        changeDiagnostic({
          code: "invalid_base_git_sha",
          message: issue.message,
          path
        })
      )
    );
  }
  return parsed.data;
}

function parseOwners(input: readonly Actor[], path: ArtifactPath): readonly Actor[] | ChangeBundleFailure {
  if (input.length === 0) {
    return failure("invalid", [
      changeDiagnostic({
        code: "invalid_owners",
        message: "At least one owner is required for a change bundle.",
        path
      })
    ]);
  }

  const owners: Actor[] = [];
  const diagnostics: ArtifactDiagnostic[] = [];

  for (const owner of input) {
    const parsed = actorSchema.safeParse(owner);
    if (!parsed.success) {
      diagnostics.push(
        ...parsed.error.issues.map((issue) =>
          changeDiagnostic({
            code: "invalid_owner",
            message: `${issue.message}${issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
            path
          })
        )
      );
      continue;
    }
    owners.push(parsed.data);
  }

  if (diagnostics.length > 0) return failure("invalid", diagnostics);
  return owners;
}

function changePaths(changeId: ChangeId): ChangeBundle["paths"] {
  const proposal = artifactPathForRole({ role: "proposal", changeId });
  return {
    root: `${PROJECT_ARTIFACT_PATHS.changes}/${changeId}` as ArtifactPath,
    proposal,
    deltaSpecRoot: `${PROJECT_ARTIFACT_PATHS.changes}/${changeId}/delta-specs` as ArtifactPath,
    design: artifactPathForRole({ role: "design", changeId }),
    decisions: artifactPathForRole({ role: "decision-log", changeId })
  };
}

function frontmatterMarkdown(frontmatter: unknown, title: string, body: readonly string[]): string {
  return [
    "---",
    stableProtocolJson(frontmatter).trimEnd(),
    "---",
    "",
    `# ${title}`,
    "",
    ...body,
    ""
  ].join("\n");
}

function renderDeltaSpecMarkdown(delta: ChangeDeltaSpec): string {
  return frontmatterMarkdown(delta, `${delta.operation}: ${delta.requirementId}`, [
    "## Rationale",
    "",
    delta.rationale,
    "",
    "## Proposed Requirement",
    "",
    delta.proposedRequirement === undefined ? "Requirement is removed." : stableProtocolJson(delta.proposedRequirement).trimEnd()
  ]);
}

function renderDesignMarkdown(design: ChangeDesignDocument): string {
  return frontmatterMarkdown(design, design.title, [design.body]);
}

function renderDecisionLogMarkdown(log: ChangeDecisionLog): string {
  const lines = log.decisions.flatMap((decision) => [
    `## ${decision.title}`,
    "",
    `- ID: ${decision.id}`,
    `- Status: ${decision.status}`,
    `- Rationale: ${decision.rationale}`,
    ""
  ]);
  return frontmatterMarkdown(log, "Decisions", lines);
}

function parseMarkdownFrontmatter<T>(input: {
  readonly artifactPath: ArtifactPath;
  readonly content: string;
  readonly schema: {
    safeParse(value: unknown): { readonly success: true; readonly data: T } | {
      readonly success: false;
      readonly error: {
        readonly issues: readonly {
          readonly path: readonly PropertyKey[];
          readonly message: string;
        }[];
      };
    };
  };
}): { readonly ok: true; readonly document: T } | ChangeBundleFailure {
  const normalized = input.content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return failure("invalid", [
      changeDiagnostic({
        code: "missing_frontmatter",
        message: "Change artifact must start with JSON frontmatter.",
        path: input.artifactPath
      })
    ]);
  }

  const closeIndex = normalized.indexOf("\n---\n", 4);
  if (closeIndex < 0) {
    return failure("invalid", [
      changeDiagnostic({
        code: "unterminated_frontmatter",
        message: "Change artifact frontmatter must close with --- on its own line.",
        path: input.artifactPath
      })
    ]);
  }

  let parsedFrontmatter: unknown;
  try {
    parsedFrontmatter = JSON.parse(normalized.slice(4, closeIndex).trim());
  } catch (error) {
    return failure("invalid", [
      changeDiagnostic({
        code: "invalid_frontmatter_json",
        message: error instanceof Error ? error.message : "Change artifact frontmatter is not valid JSON.",
        path: input.artifactPath
      })
    ]);
  }

  const parsed = input.schema.safeParse(parsedFrontmatter);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        changeDiagnostic({
          code: "invalid_schema",
          message: `${issue.message}${issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
          path: input.artifactPath
        })
      )
    );
  }

  return { ok: true, document: parsed.data };
}

async function readMarkdownArtifact<T>(input: {
  readonly repositoryRoot: string;
  readonly artifactPath: ArtifactPath;
  readonly mediaType: string;
  readonly schema: Parameters<typeof parseMarkdownFrontmatter<T>>[0]["schema"];
}): Promise<ParsedMarkdownArtifact<T> | ChangeBundleFailure> {
  let resolved;
  try {
    resolved = await resolveProjectArtifactPath({
      repositoryRoot: input.repositoryRoot,
      artifactPath: input.artifactPath
    });
  } catch (error) {
    return failure("invalid", [
      changeDiagnostic({
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
        changeDiagnostic({
          code: "not_found",
          message: "Change artifact does not exist.",
          path: resolved.repositoryPath
        })
      ]);
    }
    throw error;
  }

  const parsed = parseMarkdownFrontmatter({
    artifactPath: resolved.repositoryPath,
    content,
    schema: input.schema
  });
  if (!parsed.ok) return parsed;

  return {
    document: parsed.document,
    content,
    reference: artifactReferenceForContent({
      path: resolved.repositoryPath,
      content,
      mediaType: input.mediaType
    })
  };
}

async function readCurrentSpecByArtifactPath(input: {
  readonly repositoryRoot: string;
  readonly artifactPath: ArtifactPath;
}): Promise<{
  readonly ok: true;
  readonly document: CurrentSpecSuccess["document"];
  readonly artifactPath: ArtifactPath;
  readonly reference: ArtifactReference;
} | ChangeBundleFailure> {
  let resolved;
  try {
    resolved = await resolveProjectArtifactPath({
      repositoryRoot: input.repositoryRoot,
      artifactPath: input.artifactPath
    });
  } catch (error) {
    return failure("invalid", [
      changeDiagnostic({
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
        changeDiagnostic({
          code: "not_found",
          message: "Current spec artifact does not exist.",
          path: resolved.repositoryPath
        })
      ]);
    }
    throw error;
  }

  const parsed = parseCurrentSpecMarkdown({
    artifactPath: resolved.repositoryPath,
    content
  });
  if (!parsed.ok) return failure(parsed.status, parsed.diagnostics);

  return {
    ok: true,
    document: parsed.document,
    artifactPath: resolved.repositoryPath,
    reference: artifactReferenceForContent({
      path: resolved.repositoryPath,
      content,
      mediaType: "text/markdown"
    })
  };
}

async function currentRequirementExists(input: {
  readonly repositoryRoot: string;
  readonly requirementId: RequirementId;
}): Promise<boolean | ChangeBundleFailure> {
  const currentSpecs = await listCurrentSpecs({ repositoryRoot: input.repositoryRoot });
  if (!currentSpecs.ok) return failure(currentSpecs.status, currentSpecs.diagnostics);

  return currentSpecs.index.entries.some((entry) =>
    entry.requirements.some((requirement) => requirement.id === input.requirementId)
  );
}

function bundleIdentityDiagnostics(input: {
  readonly bundle: ChangeBundle;
  readonly requestedChangeId: ChangeId;
  readonly expectedPaths: ChangeBundle["paths"];
}): readonly ArtifactDiagnostic[] {
  const diagnostics: ArtifactDiagnostic[] = [];
  const expected = input.expectedPaths;
  const actual = input.bundle.paths;

  if (input.bundle.change.id !== input.requestedChangeId) {
    diagnostics.push(
      changeDiagnostic({
        code: "change_bundle_identity_mismatch",
        message: `Loaded change bundle declares ${input.bundle.change.id}, but ${input.requestedChangeId} was requested.`,
        path: expected.proposal
      })
    );
  }

  const pathChecks: readonly (keyof ChangeBundle["paths"])[] = ["root", "proposal", "deltaSpecRoot", "design", "decisions"];
  for (const key of pathChecks) {
    if (actual[key] !== expected[key]) {
      diagnostics.push(
        changeDiagnostic({
          code: "change_bundle_path_mismatch",
          message: `Loaded change bundle path ${String(key)} must be ${expected[key]}, not ${actual[key]}.`,
          path: expected.proposal
        })
      );
    }
  }

  return diagnostics;
}

function deltaEntryDiagnostics(input: {
  readonly entry: ChangeBundle["deltas"][number];
  readonly delta: ChangeDeltaSpec;
  readonly changeId: ChangeId;
}): readonly ArtifactDiagnostic[] {
  const diagnostics: ArtifactDiagnostic[] = [];
  if (input.delta.changeId !== input.changeId) {
    diagnostics.push(
      changeDiagnostic({
        code: "delta_frontmatter_mismatch",
        message: `Delta spec ${input.entry.path} declares change ${input.delta.changeId}, not ${input.changeId}.`,
        path: input.entry.path
      })
    );
  }
  if (input.delta.requirementId !== input.entry.requirementId) {
    diagnostics.push(
      changeDiagnostic({
        code: "delta_frontmatter_mismatch",
        message: `Delta spec ${input.entry.path} declares requirement ${input.delta.requirementId}, not ${input.entry.requirementId}.`,
        path: input.entry.path
      })
    );
  }
  if (input.delta.operation !== input.entry.operation) {
    diagnostics.push(
      changeDiagnostic({
        code: "delta_frontmatter_mismatch",
        message: `Delta spec ${input.entry.path} declares operation ${input.delta.operation}, not ${input.entry.operation}.`,
        path: input.entry.path
      })
    );
  }
  if (!referencesEqual(input.delta.baseCurrentSpec, input.entry.baseCurrentSpec)) {
    diagnostics.push(
      changeDiagnostic({
        code: "delta_frontmatter_mismatch",
        message: `Delta spec ${input.entry.path} base current spec does not match the bundle entry.`,
        path: input.entry.path
      })
    );
  }
  if (input.delta.baseCurrentSpecRevision !== input.entry.baseCurrentSpecRevision) {
    diagnostics.push(
      changeDiagnostic({
        code: "delta_frontmatter_mismatch",
        message: `Delta spec ${input.entry.path} base current spec revision does not match the bundle entry.`,
        path: input.entry.path
      })
    );
  }
  if (input.delta.baseRequirementHash !== input.entry.baseRequirementHash) {
    diagnostics.push(
      changeDiagnostic({
        code: "delta_frontmatter_mismatch",
        message: `Delta spec ${input.entry.path} base requirement hash does not match the bundle entry.`,
        path: input.entry.path
      })
    );
  }

  return diagnostics;
}

function referencesEqual(left: ArtifactReference | undefined, right: ArtifactReference | undefined): boolean {
  return left?.path === right?.path && left?.sha256 === right?.sha256 && left?.mediaType === right?.mediaType;
}

function findRevision(input: {
  readonly bundle: ChangeBundle;
  readonly role: ArtifactRevision["role"];
  readonly path: ArtifactPath;
}): ArtifactRevision | undefined {
  return input.bundle.artifactRevisions.find((revision) =>
    revision.role === input.role && revision.artifact.path === input.path
  );
}

function conflictDiagnostics(deltas: readonly { readonly requirementId: RequirementId; readonly operation: DeltaOperation }[], path: ArtifactPath): readonly ArtifactDiagnostic[] {
  const byRequirement = new Map<RequirementId, DeltaOperation>();
  const diagnostics: ArtifactDiagnostic[] = [];

  for (const delta of deltas) {
    const prior = byRequirement.get(delta.requirementId);
    if (prior !== undefined) {
      diagnostics.push(
        changeDiagnostic({
          code: "conflicting_delta_operations",
          message: `Requirement ${delta.requirementId} has multiple delta operations: ${prior} and ${delta.operation}.`,
          path
        })
      );
    }
    byRequirement.set(delta.requirementId, delta.operation);
  }

  return diagnostics;
}

async function currentSpecMap(input: {
  readonly repositoryRoot: string;
  readonly currentSpecs: readonly ChangeBaseSpecInput[];
  readonly proposalPath: ArtifactPath;
}): Promise<{
  readonly ok: true;
  readonly specs: readonly CurrentSpecSuccess[];
  readonly requirements: ReadonlyMap<RequirementId, BaseRequirement>;
} | ChangeBundleFailure> {
  const specs: CurrentSpecSuccess[] = [];
  const requirements = new Map<RequirementId, BaseRequirement>();

  for (const requested of input.currentSpecs) {
    const requirementId = parseRequirementId(requested.requirementId, input.proposalPath);
    if (typeof requirementId !== "string") return requirementId;

    const spec = await readCurrentSpec({
      repositoryRoot: input.repositoryRoot,
      requirementId
    });
    if (!spec.ok) {
      return failure(spec.status === "not_found" ? "not_found" : "invalid", spec.diagnostics);
    }
    if (spec.document.revision !== requested.expectedRevision) {
      return failure("invalid", [
        changeDiagnostic({
          code: "stale_change_base",
          message: `Expected current spec ${requirementId} revision ${requested.expectedRevision}, but current revision is ${spec.document.revision}.`,
          path: spec.artifactPath
        })
      ]);
    }

    specs.push(spec);
    for (const requirement of spec.document.requirements) {
      requirements.set(requirement.id, {
        spec,
        requirement,
        requirementHash: hashContent(stableProtocolJson(requirement))
      });
    }
  }

  return { ok: true, specs, requirements };
}

function normalizeDeltaSpecs(input: {
  readonly changeId: ChangeId;
  readonly proposalPath: ArtifactPath;
  readonly deltas: readonly ChangeDeltaSpecInput[];
  readonly baseRequirements: ReadonlyMap<RequirementId, BaseRequirement>;
}): {
  readonly ok: true;
  readonly deltas: readonly ChangeDeltaSpec[];
} | ChangeBundleFailure {
  const diagnostics: ArtifactDiagnostic[] = [];
  const normalizedHeaders: { requirementId: RequirementId; operation: DeltaOperation }[] = [];
  const deltas: ChangeDeltaSpec[] = [];

  for (const delta of input.deltas) {
    const requirementId = parseRequirementId(delta.requirementId, input.proposalPath);
    if (typeof requirementId !== "string") return requirementId;
    normalizedHeaders.push({ requirementId, operation: delta.operation });
  }

  diagnostics.push(...conflictDiagnostics(normalizedHeaders, input.proposalPath));
  if (diagnostics.length > 0) return failure("invalid", diagnostics);

  for (const [index, delta] of input.deltas.entries()) {
    const requirementId = normalizedHeaders[index]?.requirementId;
    if (requirementId === undefined) continue;
    const base = input.baseRequirements.get(requirementId);

    if ((delta.operation === "modify" || delta.operation === "remove") && base === undefined) {
      diagnostics.push(
        changeDiagnostic({
          code: "missing_delta_base",
          message: `Delta ${delta.operation} for ${requirementId} has no matching current spec base.`,
          path: input.proposalPath
        })
      );
      continue;
    }

    if (delta.operation === "add" && base !== undefined) {
      diagnostics.push(
        changeDiagnostic({
          code: "add_delta_targets_existing_requirement",
          message: `Delta add for ${requirementId} targets an existing current requirement.`,
          path: input.proposalPath
        })
      );
      continue;
    }

    const parsed = changeDeltaSpecSchema.safeParse({
      schemaVersion: CHANGE_BUNDLE_SCHEMA_VERSION,
      kind: "delta-spec",
      changeId: input.changeId,
      requirementId,
      operation: delta.operation,
      ...(base === undefined ? {} : {
        baseCurrentSpec: base.spec.reference,
        baseCurrentSpecRevision: base.spec.document.revision,
        baseRequirementHash: base.requirementHash
      }),
      ...(delta.proposedRequirement === undefined ? {} : { proposedRequirement: delta.proposedRequirement }),
      ...(delta.sections === undefined ? {} : { sections: delta.sections }),
      rationale: delta.rationale,
      dependencies: [
        ...(base === undefined ? [] : [base.spec.reference]),
        ...(delta.dependencies ?? [])
      ]
    });

    if (!parsed.success) {
      diagnostics.push(
        ...parsed.error.issues.map((issue) =>
          changeDiagnostic({
            code: "invalid_delta_spec",
            message: `${issue.message}${issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
            path: input.proposalPath
          })
        )
      );
      continue;
    }

    deltas.push(parsed.data);
  }

  if (diagnostics.length > 0) return failure("invalid", diagnostics);
  return { ok: true, deltas };
}

function buildDecisionLog(input: {
  readonly changeId: ChangeId;
  readonly projectId: ProjectId;
  readonly createdAt: UtcTimestamp;
  readonly decisionLogPath: ArtifactPath;
  readonly affectedArtifacts: readonly ArtifactReference[];
  readonly decisions: readonly ChangeDecisionInput[];
}): ChangeDecisionLog | ChangeBundleFailure {
  const diagnostics: ArtifactDiagnostic[] = [];
  const decisions: Decision[] = [];

  for (const decision of input.decisions) {
    const id = decisionIdSchema.safeParse(decision.id);
    if (!id.success) {
      diagnostics.push(
        changeDiagnostic({
          code: "invalid_decision_id",
          message: id.error.issues[0]?.message ?? "Invalid decision ID.",
          path: input.decisionLogPath
        })
      );
      continue;
    }

    const createdAt = parseTimestamp({
      value: decision.createdAt ?? input.createdAt,
      path: input.decisionLogPath,
      code: "invalid_decision_created_at"
    });
    if (typeof createdAt !== "string") {
      diagnostics.push(...createdAt.diagnostics);
      continue;
    }

    const decidedAt = decision.decidedAt === undefined ? undefined : parseTimestamp({
      value: decision.decidedAt,
      path: input.decisionLogPath,
      code: "invalid_decision_decided_at"
    });
    if (decidedAt !== undefined && typeof decidedAt !== "string") {
      diagnostics.push(...decidedAt.diagnostics);
      continue;
    }

    const parsed = decisionSchema.safeParse({
      schemaVersion: LEGION_PROTOCOL_VERSION,
      createdAt,
      kind: "decision",
      id: id.data,
      projectId: input.projectId,
      title: decision.title,
      context: decision.context,
      alternatives: decision.alternatives,
      rationale: decision.rationale,
      supersedes: decision.supersedes,
      affectedArtifacts: input.affectedArtifacts,
      traceRefs: [
        {
          path: input.decisionLogPath,
          anchor: id.data,
          relation: "records",
          entity: { kind: "decision", id: id.data }
        }
      ],
      status: decision.status,
      ...(decision.approver === undefined ? {} : { approver: decision.approver }),
      ...(decidedAt === undefined ? {} : { decidedAt }),
      ...(decision.supersededBy === undefined ? {} : { supersededBy: decision.supersededBy })
    });

    if (!parsed.success) {
      diagnostics.push(
        ...parsed.error.issues.map((issue) =>
          changeDiagnostic({
            code: "invalid_decision",
            message: `${issue.message}${issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
            path: input.decisionLogPath
          })
        )
      );
      continue;
    }

    decisions.push(parsed.data);
  }

  if (diagnostics.length > 0) return failure("invalid", diagnostics);
  return changeDecisionLogSchema.parse({
    schemaVersion: CHANGE_BUNDLE_SCHEMA_VERSION,
    kind: "decision-log",
    changeId: input.changeId,
    decisions
  });
}

async function writeNewArtifact(input: {
  readonly repositoryRoot: string;
  readonly artifactPath: ArtifactPath;
  readonly role: ArtifactRevision["role"];
  readonly content: string;
  readonly mediaType: string;
  readonly baseGitSha?: GitSha;
}): Promise<{
  readonly ok: true;
  readonly reference: ArtifactReference;
  readonly revision: ArtifactRevision;
} | ChangeBundleFailure> {
  try {
    const write = await writeRevisionedArtifact({
      repositoryRoot: input.repositoryRoot,
      artifactPath: input.artifactPath,
      role: input.role,
      content: input.content,
      expectedRevision: 0,
      currentRevision: 0,
      mediaType: input.mediaType,
      ...(input.baseGitSha === undefined ? {} : { baseGitSha: input.baseGitSha })
    });
    return { ok: true, reference: write.reference, revision: write.revision };
  } catch (error) {
    if (error instanceof ArtifactRevisionConflictError) {
      return failure("conflict", [
        changeDiagnostic({
          code: "revision_conflict",
          message: error.message,
          path: input.artifactPath
        })
      ]);
    }
    throw error;
  }
}

async function preflightNewArtifactPaths(input: {
  readonly repositoryRoot: string;
  readonly artifactPaths: readonly ArtifactPath[];
}): Promise<{ readonly ok: true } | ChangeBundleFailure> {
  const diagnostics: ArtifactDiagnostic[] = [];

  for (const artifactPath of input.artifactPaths) {
    let resolved;
    try {
      resolved = await resolveProjectArtifactPath({
        repositoryRoot: input.repositoryRoot,
        artifactPath
      });
    } catch (error) {
      return failure("invalid", [
        changeDiagnostic({
          code: "invalid_path",
          message: error instanceof Error ? error.message : String(error),
          path: artifactPath
        })
      ]);
    }

    try {
      await stat(resolved.absolutePath);
      diagnostics.push(
        changeDiagnostic({
          code: "artifact_already_exists",
          message: `Change artifact already exists: ${resolved.repositoryPath}.`,
          path: resolved.repositoryPath
        })
      );
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
  }

  if (diagnostics.length > 0) return failure("conflict", diagnostics);
  return { ok: true };
}

function success(input: {
  readonly status: ChangeBundleSuccess["status"];
  readonly bundle: ChangeBundle;
  readonly deltaSpecs: readonly ChangeDeltaSpec[];
  readonly design: ChangeDesignDocument;
  readonly decisions: readonly Decision[];
  readonly artifactPath: ArtifactPath;
  readonly reference: ArtifactReference;
  readonly revision: ArtifactRevision;
}): ChangeBundleSuccess {
  return {
    ok: true,
    status: input.status,
    bundle: input.bundle,
    deltaSpecs: input.deltaSpecs,
    design: input.design,
    decisions: input.decisions,
    artifactPath: input.artifactPath,
    reference: input.reference,
    revision: input.revision,
    diagnostics: []
  };
}

export async function createChangeBundle(input: CreateChangeBundleInput): Promise<ChangeBundleResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;

  const projectId = projectIdSchema.safeParse(input.projectId);
  const paths = changePaths(changeId);
  if (input.deltaSpecs.length === 0) {
    return failure("invalid", [
      changeDiagnostic({
        code: "invalid_delta_specs",
        message: "At least one delta spec is required to create a change bundle.",
        path: paths.proposal
      })
    ]);
  }
  const baseGitSha = parseBaseGitSha(input.baseGitSha, paths.proposal);
  if (typeof baseGitSha !== "string") return baseGitSha;
  if (!projectId.success) {
    return failure("invalid", [
      changeDiagnostic({
        code: "invalid_project_id",
        message: projectId.error.issues[0]?.message ?? "Invalid project ID.",
        path: paths.proposal
      })
    ]);
  }

  const owners = parseOwners(input.owners, paths.proposal);
  if ("diagnostics" in owners) return owners;
  const createdAt = parseTimestamp({
    value: input.createdAt,
    path: paths.proposal,
    code: "invalid_created_at"
  });
  if (typeof createdAt !== "string") return createdAt;
  const current = await currentSpecMap({
    repositoryRoot: input.repositoryRoot,
    currentSpecs: input.currentSpecs,
    proposalPath: paths.proposal
  });
  if (!current.ok) return current;

  const normalizedDeltas = normalizeDeltaSpecs({
    changeId,
    proposalPath: paths.proposal,
    deltas: input.deltaSpecs,
    baseRequirements: current.requirements
  });
  if (!normalizedDeltas.ok) return normalizedDeltas;

  const deltaArtifacts = normalizedDeltas.deltas.map((delta) => {
    const artifactPath = artifactPathForRole({
      role: "delta-spec",
      changeId,
      requirementId: delta.requirementId
    });
    const content = renderDeltaSpecMarkdown(delta);
    const revision = artifactRevisionForContent({
      role: "delta-spec",
      path: artifactPath,
      content,
      revision: 1,
      mediaType: "text/markdown",
      baseGitSha
    });
    return { delta, artifactPath, content, reference: revision.artifact, revision };
  });
  const deltaArtifactsByRequirement = [...deltaArtifacts].sort((left, right) =>
    compareStrings(left.delta.requirementId, right.delta.requirementId)
  );

  const design = changeDesignDocumentSchema.safeParse({
    schemaVersion: CHANGE_BUNDLE_SCHEMA_VERSION,
    kind: "change-design",
    changeId,
    title: input.design.title,
    body: input.design.body,
    dependencies: [
      ...current.specs.map((spec) => spec.reference),
      ...(input.design.dependencies ?? [])
    ]
  });
  if (!design.success) {
    return failure(
      "invalid",
      design.error.issues.map((issue) =>
        changeDiagnostic({
          code: "invalid_design",
          message: `${issue.message}${issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
          path: paths.design
        })
      )
    );
  }
  const designDocument = design.data;
  const designContent = renderDesignMarkdown(designDocument);
  const designRevision = artifactRevisionForContent({
    role: "design",
    path: paths.design,
    content: designContent,
    revision: 1,
    mediaType: "text/markdown",
    baseGitSha
  });

  const decisionLog = buildDecisionLog({
    changeId,
    projectId: projectId.data,
    createdAt,
    decisionLogPath: paths.decisions,
    affectedArtifacts: [designRevision.artifact, ...deltaArtifacts.map((artifact) => artifact.reference)],
    decisions: input.decisions ?? []
  });
  if ("diagnostics" in decisionLog) return decisionLog;
  const decisionContent = renderDecisionLogMarkdown(decisionLog);
  const decisionRevision = artifactRevisionForContent({
    role: "decision-log",
    path: paths.decisions,
    content: decisionContent,
    revision: 1,
    mediaType: "text/markdown",
    baseGitSha
  });

  const preflight = await preflightNewArtifactPaths({
    repositoryRoot: input.repositoryRoot,
    artifactPaths: [
      ...deltaArtifactsByRequirement.map((artifact) => artifact.artifactPath),
      paths.design,
      paths.decisions,
      paths.proposal
    ]
  });
  if (!preflight.ok) return preflight;

  const currentSpecsByPath = [...current.specs].sort((left, right) =>
    compareStrings(left.artifactPath, right.artifactPath)
  );
  const currentRequirementIds = [...current.requirements.keys()].sort(compareStrings);
  const deltaRequirementIds = normalizedDeltas.deltas.map((delta) => delta.requirementId).sort(compareStrings);
  const artifactRevisions = [
    ...deltaArtifactsByRequirement.map((artifact) => artifact.revision),
    designRevision,
    decisionRevision
  ];
  const change = {
    schemaVersion: LEGION_PROTOCOL_VERSION,
    createdAt,
    kind: "change",
    id: changeId,
    projectId: projectId.data,
    title: input.title,
    summary: input.summary,
    status: "draft",
    currentTruth: {
      specRefs: currentSpecsByPath.map((spec) => spec.reference),
      baseSpecHash: hashContent(stableProtocolJson(currentSpecsByPath.map((spec) => ({
        path: spec.artifactPath,
        revision: spec.document.revision,
        reference: spec.reference
      })))),
      baseGitSha,
      requirementIds: currentRequirementIds
    },
    proposedTruth: {
      deltaSpecRefs: deltaArtifactsByRequirement.map((artifact) => artifact.reference),
      targetSpecHash: hashContent(stableProtocolJson(deltaArtifactsByRequirement.map((artifact) => ({
        operation: artifact.delta.operation,
        requirementId: artifact.delta.requirementId,
        reference: artifact.reference
      })))),
      requirementIds: deltaRequirementIds
    },
    artifactRevisions,
    risk: input.risk,
    acceptance: { status: "not_ready" },
    decisionRefs: decisionLog.decisions.map((decision) => decision.id),
    oracleRefs: []
  } satisfies Change;
  const parsedChange = changeBundleSchema.shape.change.safeParse(change);
  if (!parsedChange.success) {
    return failure(
      "invalid",
      parsedChange.error.issues.map((issue) =>
        changeDiagnostic({
          code: "invalid_change",
          message: `${issue.message}${issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
          path: paths.proposal
        })
      )
    );
  }

  const bundle = changeBundleSchema.safeParse({
    schemaVersion: CHANGE_BUNDLE_SCHEMA_VERSION,
    kind: "change-bundle",
    revision: 1,
    owners,
    baseGitSha,
    paths,
    change: parsedChange.data,
    deltas: deltaArtifactsByRequirement.map((artifact) => ({
      operation: artifact.delta.operation,
      requirementId: artifact.delta.requirementId,
      path: artifact.artifactPath,
      ...(artifact.delta.baseCurrentSpec === undefined ? {} : { baseCurrentSpec: artifact.delta.baseCurrentSpec }),
      ...(artifact.delta.baseCurrentSpecRevision === undefined ? {} : { baseCurrentSpecRevision: artifact.delta.baseCurrentSpecRevision }),
      ...(artifact.delta.baseRequirementHash === undefined ? {} : { baseRequirementHash: artifact.delta.baseRequirementHash }),
      delta: artifact.reference
    })),
    artifactRevisions
  });
  if (!bundle.success) {
    return failure(
      "invalid",
      bundle.error.issues.map((issue) =>
        changeDiagnostic({
          code: "invalid_change_bundle",
          message: `${issue.message}${issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
          path: paths.proposal
        })
      )
    );
  }
  const bundleDocument = bundle.data;
  const proposalContent = stableProtocolJson(bundleDocument);

  for (const artifact of deltaArtifactsByRequirement) {
    const written = await writeNewArtifact({
      repositoryRoot: input.repositoryRoot,
      artifactPath: artifact.artifactPath,
      role: "delta-spec",
      content: artifact.content,
      mediaType: "text/markdown",
      baseGitSha
    });
    if (!written.ok) return written;
  }

  const writtenDesign = await writeNewArtifact({
    repositoryRoot: input.repositoryRoot,
    artifactPath: paths.design,
    role: "design",
    content: designContent,
    mediaType: "text/markdown",
    baseGitSha
  });
  if (!writtenDesign.ok) return writtenDesign;

  const writtenDecisions = await writeNewArtifact({
    repositoryRoot: input.repositoryRoot,
    artifactPath: paths.decisions,
    role: "decision-log",
    content: decisionContent,
    mediaType: "text/markdown",
    baseGitSha
  });
  if (!writtenDecisions.ok) return writtenDecisions;

  const writtenProposal = await writeNewArtifact({
    repositoryRoot: input.repositoryRoot,
    artifactPath: paths.proposal,
    role: "proposal",
    content: proposalContent,
    mediaType: "application/json",
    baseGitSha
  });
  if (!writtenProposal.ok) return writtenProposal;

  return success({
    status: "created",
    bundle: bundleDocument,
    deltaSpecs: normalizedDeltas.deltas,
    design: designDocument,
    decisions: decisionLog.decisions,
    artifactPath: paths.proposal,
    reference: writtenProposal.reference,
    revision: writtenProposal.revision
  });
}

export async function loadChangeBundle(input: LoadChangeBundleInput): Promise<ChangeBundleResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;
  const paths = changePaths(changeId);

  const proposal = await readJsonArtifact({
    repositoryRoot: input.repositoryRoot,
    artifactPath: paths.proposal,
    schema: changeBundleSchema
  });
  if (!proposal.ok) {
    const notFound = proposal.diagnostics.some((diagnostic) => diagnostic.code === "not_found");
    return failure(notFound ? "not_found" : "invalid", proposal.diagnostics);
  }

  const bundle = proposal.value;
  const diagnostics: ArtifactDiagnostic[] = [];
  diagnostics.push(...bundleIdentityDiagnostics({
    bundle,
    requestedChangeId: changeId,
    expectedPaths: paths
  }));
  const deltaSpecs: ChangeDeltaSpec[] = [];

  for (const entry of bundle.deltas) {
    const parsed = await readMarkdownArtifact({
      repositoryRoot: input.repositoryRoot,
      artifactPath: entry.path,
      mediaType: "text/markdown",
      schema: changeDeltaSpecSchema
    });
    if ("diagnostics" in parsed) return parsed;
    if (!referencesEqual(parsed.reference, entry.delta)) {
      diagnostics.push(
        changeDiagnostic({
          code: "delta_artifact_mismatch",
          message: `Delta spec ${entry.path} bytes do not match the change bundle reference.`,
          path: entry.path
        })
      );
    }
    diagnostics.push(...deltaEntryDiagnostics({
      entry,
      delta: parsed.document,
      changeId
    }));
    deltaSpecs.push(parsed.document);
  }

  const design = await readMarkdownArtifact({
    repositoryRoot: input.repositoryRoot,
    artifactPath: bundle.paths.design,
    mediaType: "text/markdown",
    schema: changeDesignDocumentSchema
  });
  if ("diagnostics" in design) return design;
  const designRevision = findRevision({ bundle, role: "design", path: bundle.paths.design });
  if (!referencesEqual(design.reference, designRevision?.artifact)) {
    diagnostics.push(
      changeDiagnostic({
        code: "design_artifact_mismatch",
        message: "Design bytes do not match the change bundle artifact revision.",
        path: bundle.paths.design
      })
    );
  }

  const decisions = await readMarkdownArtifact({
    repositoryRoot: input.repositoryRoot,
    artifactPath: bundle.paths.decisions,
    mediaType: "text/markdown",
    schema: changeDecisionLogSchema
  });
  if ("diagnostics" in decisions) return decisions;
  const decisionRevision = findRevision({ bundle, role: "decision-log", path: bundle.paths.decisions });
  if (!referencesEqual(decisions.reference, decisionRevision?.artifact)) {
    diagnostics.push(
      changeDiagnostic({
        code: "decision_artifact_mismatch",
        message: "Decision log bytes do not match the change bundle artifact revision.",
        path: bundle.paths.decisions
      })
    );
  }

  if (diagnostics.length > 0) return failure("invalid", diagnostics);

  return success({
    status: "read",
    bundle,
    deltaSpecs,
    design: design.document,
    decisions: decisions.document.decisions,
    artifactPath: paths.proposal,
    reference: proposal.reference,
    revision: artifactRevisionForContent({
      role: "proposal",
      path: paths.proposal,
      content: proposal.bytes,
      revision: bundle.revision,
      mediaType: "application/json",
      baseGitSha: bundle.baseGitSha
    })
  });
}

export async function validateChangeBundle(input: ValidateChangeBundleInput): Promise<ValidateChangeBundleResult> {
  const loaded = await loadChangeBundle(input);
  if (!loaded.ok) return loaded;

  const diagnostics: ArtifactDiagnostic[] = [];
  diagnostics.push(...conflictDiagnostics(loaded.bundle.deltas, loaded.bundle.paths.proposal));

  for (const delta of loaded.bundle.deltas) {
    if (delta.operation === "add") {
      const exists = await currentRequirementExists({
        repositoryRoot: input.repositoryRoot,
        requirementId: delta.requirementId
      });
      if (typeof exists !== "boolean") {
        diagnostics.push(...exists.diagnostics);
        continue;
      }
      if (exists) {
        diagnostics.push(
          changeDiagnostic({
            code: "add_delta_targets_existing_requirement",
            message: `Current truth already contains requirement ${delta.requirementId}.`,
            path: delta.path
          })
        );
      }
      continue;
    }
    if (delta.baseCurrentSpec === undefined) {
      diagnostics.push(
        changeDiagnostic({
          code: "stale_change_base",
          message: `Current spec base for ${delta.requirementId} is missing from the change bundle.`,
          path: delta.path
        })
      );
      continue;
    }

    const current = await readCurrentSpecByArtifactPath({
      repositoryRoot: input.repositoryRoot,
      artifactPath: delta.baseCurrentSpec.path
    });
    if (!current.ok) {
      diagnostics.push(
        changeDiagnostic({
          code: "stale_change_base",
          message: `Current spec for ${delta.requirementId} is no longer readable.`,
          path: delta.path
        })
      );
      continue;
    }

    const requirement = current.document.requirements.find((entry) => entry.id === delta.requirementId);
    const currentRequirementHash = requirement === undefined ? undefined : hashContent(stableProtocolJson(requirement));
    if (
      !referencesEqual(current.reference, delta.baseCurrentSpec) ||
      current.document.revision !== delta.baseCurrentSpecRevision ||
      currentRequirementHash !== delta.baseRequirementHash
    ) {
      diagnostics.push(
        changeDiagnostic({
          code: "stale_change_base",
          message: `Current spec base for ${delta.requirementId} changed since this bundle was created.`,
          path: delta.path
        })
      );
    }
  }

  if (diagnostics.length > 0) return failure("invalid", diagnostics);
  return { ok: true, diagnostics: [] };
}

export function diffChangeBundle(bundle: ChangeBundle): ChangeBundleDiff {
  const added = bundle.deltas
    .filter((delta) => delta.operation === "add")
    .map((delta) => delta.requirementId)
    .sort();
  const modified = bundle.deltas
    .filter((delta) => delta.operation === "modify")
    .map((delta) => delta.requirementId)
    .sort();
  const removed = bundle.deltas
    .filter((delta) => delta.operation === "remove")
    .map((delta) => delta.requirementId)
    .sort();

  return { added, modified, removed };
}
