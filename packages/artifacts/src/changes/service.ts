import { readFile, stat } from "node:fs/promises";

import {
  LEGION_PROTOCOL_VERSION,
  acceptanceStateSchema,
  actorSchema,
  changeIdSchema,
  decisionIdSchema,
  decisionSchema,
  gitShaSchema,
  projectIdSchema,
  requirementIdSchema,
  utcTimestampSchema,
  type AcceptanceState,
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
import { readEvidenceIndex, writeEvidenceIndex } from "../evidence-index/service.js";
import { readTaskGraph, writeTaskGraph } from "../taskgraphs/service.js";
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

export interface UpdateChangeAcceptanceInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
  readonly acceptance: AcceptanceState;
  /**
   * The bundle revision the caller read.
   *
   * Always at least 1. `createChangeBundle` writes `revision: 1` and
   * `changeBundleSchema.revision` is `positive()`, so `0` names no state a
   * change bundle can be in — which is why this deliberately does *not* copy the
   * `expectedRevision ?? 0` default that `writeEvidenceIndex` and
   * `writeTaskGraph` use. There, `0` means "create"; here creation is a
   * different function whose preflight refuses an existing file.
   */
  readonly expectedRevision: number;
  /**
   * Recorded on the written `ArtifactRevision` only.
   *
   * It never overwrites `bundle.baseGitSha` or `change.currentTruth.baseGitSha`:
   * those record the commit the change was *based on*, which an acceptance
   * decision taken weeks later does not move.
   */
  readonly baseGitSha?: GitSha | string;
  /**
   * Stamped on `change.updatedAt`. Injected rather than read from the clock so
   * that one `legion review --accept` writes one instant across the reviews, the
   * evidence entries, the approvals and this.
   */
  readonly updatedAt?: UtcTimestamp | string;
}

/** One recorded artifact-input list that was re-pointed at the rewritten proposal. */
export interface ChangeInputRepoint {
  readonly artifactPath: ArtifactPath;
  readonly from: number;
  readonly to: number;
  /** Which recorded input paths were substituted. */
  readonly inputs: readonly ArtifactPath[];
}

export interface UpdateChangeAcceptanceSuccess {
  readonly ok: true;
  readonly status: "updated" | "unchanged";
  readonly bundle: ChangeBundle;
  readonly acceptance: AcceptanceState;
  readonly artifactPath: ArtifactPath;
  readonly reference: ArtifactReference;
  readonly revision: ArtifactRevision;
  readonly repointed: readonly ChangeInputRepoint[];
  readonly diagnostics: readonly [];
}

/**
 * A failed acceptance write, and whether the acceptance nonetheless reached disk.
 *
 * `written` is present on exactly one failure path: the proposal was rewritten
 * and the re-point of the artifact inputs that pin it was not. Every other
 * failure — an unreadable bundle, a revision conflict, an acceptance the schema
 * refuses — happens before any byte is written, and leaves the field absent.
 * The distinction exists because it decides what the CLI tells the operator and
 * which command it sends them to, and a caller cannot infer it from the
 * diagnostic codes.
 */
export interface UpdateChangeAcceptanceFailure extends ChangeBundleFailure {
  readonly written?: {
    readonly artifactPath: ArtifactPath;
    readonly acceptance: AcceptanceState;
    readonly revision: ArtifactRevision;
  };
}

export type UpdateChangeAcceptanceResult = UpdateChangeAcceptanceSuccess | UpdateChangeAcceptanceFailure;

export interface RepointChangeProposalInputsInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
  /**
   * The proposal revision the recorded inputs are expected to still name.
   *
   * Exactly, hash included. This is the strict path, and it is strict on purpose:
   * naming the one revision a call superseded is what keeps an out-of-band edit
   * visible. It is also why it cannot repair its own torn write, which is what
   * `repairChangeProposalPins` is for. See `namesExactly` and `namesSuperseded`.
   */
  readonly previous: ArtifactRevision;
  /** The proposal revision on disk now. */
  readonly current: ArtifactRevision;
  readonly baseGitSha?: GitSha | string;
}

/** Input to the standalone repair `legion dev change repoint <changeId>` runs. */
export interface RepairChangeProposalPinsInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
  readonly baseGitSha?: GitSha | string;
}

export type RepointChangeProposalInputsResult =
  | { readonly ok: true; readonly repointed: readonly ChangeInputRepoint[]; readonly diagnostics: readonly [] }
  | ChangeBundleFailure;

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

function changeArtifactIdentityDiagnostics(input: {
  readonly artifactPath: ArtifactPath;
  readonly actualChangeId: ChangeId;
  readonly expectedChangeId: ChangeId;
  readonly code: string;
  readonly label: string;
}): readonly ArtifactDiagnostic[] {
  if (input.actualChangeId === input.expectedChangeId) return [];
  return [
    changeDiagnostic({
      code: input.code,
      message: `${input.label} declares change ${input.actualChangeId}, not ${input.expectedChangeId}.`,
      path: input.artifactPath
    })
  ];
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

async function normalizeDeltaSpecs(input: {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId;
  readonly proposalPath: ArtifactPath;
  readonly deltas: readonly ChangeDeltaSpecInput[];
  readonly baseRequirements: ReadonlyMap<RequirementId, BaseRequirement>;
}): Promise<{
  readonly ok: true;
  readonly deltas: readonly ChangeDeltaSpec[];
} | ChangeBundleFailure> {
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

    if (delta.operation === "add") {
      const exists = await currentRequirementExists({
        repositoryRoot: input.repositoryRoot,
        requirementId
      });
      if (typeof exists !== "boolean") return exists;
      if (exists) {
        diagnostics.push(
          changeDiagnostic({
            code: "add_delta_targets_existing_requirement",
            message: `Delta add for ${requirementId} targets an existing current requirement.`,
            path: input.proposalPath
          })
        );
        continue;
      }
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

  const normalizedDeltas = await normalizeDeltaSpecs({
    repositoryRoot: input.repositoryRoot,
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
  diagnostics.push(...changeArtifactIdentityDiagnostics({
    artifactPath: bundle.paths.design,
    actualChangeId: design.document.changeId,
    expectedChangeId: changeId,
    code: "design_change_id_mismatch",
    label: "Design artifact"
  }));
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
  diagnostics.push(...changeArtifactIdentityDiagnostics({
    artifactPath: bundle.paths.decisions,
    actualChangeId: decisions.document.changeId,
    expectedChangeId: changeId,
    code: "decision_log_change_id_mismatch",
    label: "Decision log artifact"
  }));
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

/**
 * Does one recorded artifact input still name exactly this revision?
 *
 * Path, content hash **and** revision number, all three. This is the whole
 * safety argument for the re-point below, so it is spelled out rather than
 * shortened to a path comparison: a recorded input naming `change.yaml` with any
 * other `{sha256, revision}` is drift that existed *before* this call — a
 * hand-edited bundle, a graph planned against something else — and moving it
 * would launder an out-of-band edit into freshness. `validateArtifactInputFreshness`
 * is the only thing in the tree that can detect a hand-written or back-dated
 * `change.acceptance`, because the proposal is not in `bundle.artifactRevisions`
 * and `loadChangeBundle` never re-checks its own bytes. Substituting on path
 * alone would delete that detector on the one field a gate now reads.
 */
function namesRevision(recorded: ArtifactRevision, expected: ArtifactRevision): boolean {
  return (
    recorded.artifact.path === expected.artifact.path &&
    recorded.artifact.sha256 === expected.artifact.sha256 &&
    recorded.revision === expected.revision
  );
}

/**
 * Which recorded inputs a re-point is allowed to move, and why there are two
 * answers rather than one.
 *
 * A `ProposalPinSelector` names a recorded `artifactInputs` entry that must be
 * re-pointed at the proposal on disk. Both selectors below re-point onto the
 * same target; they differ only in what they are willing to recognize as
 * *stale*, and that difference is a safety property rather than a convenience.
 *
 * `validateArtifactInputFreshness` is the only detector in the tree for a
 * hand-written or back-dated `change.acceptance`: the proposal is not in
 * `bundle.artifactRevisions` and `loadChangeBundle` never re-checks its own
 * bytes, so these two pins are all that stand behind the field a ship gate now
 * reads. A selector that matched on path alone would delete that detector.
 */
type ProposalPinSelector = (entry: ArtifactRevision) => boolean;

/**
 * The exact selector: only the one revision *this* write superseded.
 *
 * Used by `updateChangeAcceptance` after its proposal write. It is the strictest
 * thing that can work, and it is what keeps a hand edit visible: an edit made out
 * of band leaves a pin whose `{sha256}` disagrees with the bytes the write
 * superseded, that pin is left exactly as it is, and `legion ship` keeps
 * reporting the drift.
 */
function namesExactly(previous: ArtifactRevision): ProposalPinSelector {
  return (entry) => namesRevision(entry, previous);
}

/**
 * The superseded selector: any pin naming a **strictly older** revision of the
 * proposal than the one on disk.
 *
 * Used only by `repairChangeProposalPins`, and it exists because the exact
 * selector cannot repair its own torn write. The proposal write and the two
 * re-point writes are three separate atomic renames with no transaction around
 * them, so any I/O failure, process death or concurrent writer between them
 * leaves `change.yaml` at revision N+1 with the pins still naming revision N —
 * and `previous` is only ever the revision that call superseded, so no later
 * call's exact selector could ever match them again. Reproduced end to end: with
 * `taskgraph.json` unwritable, one `legion review --accept` left the change
 * permanently unshippable, `legion plan` refused with `artifact_already_exists`,
 * `legion build` did not rewrite `taskgraph.artifactInputs`, `legion validate`
 * reported valid, and every retry walked the bundle one revision further while
 * repairing nothing.
 *
 * **A hand edit does not bump `bundle.revision`.** That is the whole reason this
 * is safe to widen: an out-of-band edit leaves a pin naming the live revision
 * *number* with a disagreeing hash, which this refuses to move. Only a strictly
 * older revision — the signature of a write that landed and a re-point that did
 * not — is followed. A pin naming a *newer* revision is refused too: nothing in
 * this repository produces one, and walking a pin backwards would be inventing
 * history rather than restoring currency.
 *
 * The residual: hand-edit, then accept, then run the repair verb explicitly. The
 * accept's own repair pass refuses (the revisions are equal at that moment) and
 * ship reports the drift, so the operator is told. If they then run a command
 * named `repoint`, the pin is re-pointed. That is an explicit operator act on a
 * verb that says what it does, not a silent laundering inside another command.
 */
function namesSuperseded(current: ArtifactRevision): ProposalPinSelector {
  return (entry) => entry.artifact.path === current.artifact.path && entry.revision < current.revision;
}

function substituteSelected(
  inputs: readonly ArtifactRevision[],
  select: ProposalPinSelector,
  current: ArtifactRevision
): { readonly inputs: readonly ArtifactRevision[]; readonly substituted: boolean } {
  let substituted = false;
  const next = inputs.map((entry) => {
    if (!select(entry)) return entry;
    substituted = true;
    return current;
  });
  return { inputs: next, substituted };
}

/**
 * The diagnostic every failure inside a re-point produces, and the one command
 * that repairs the state it describes.
 *
 * Every arm below routes here rather than to `legion validate` or to a hand
 * edit. Measured: on a torn accept, `legion validate` returns exit 0 and
 * `{"status":"valid","diagnostics":[]}` — the traceability freshness check that
 * sees the tear runs in `legion ship`, not there — so routing an operator to it
 * confirms that nothing is wrong on a repository that cannot ship.
 */
function repointFailure(input: {
  readonly message: string;
  readonly path: ArtifactPath;
  readonly status?: "invalid" | "conflict";
}): ChangeBundleFailure {
  return failure(input.status ?? "invalid", [
    changeDiagnostic({
      code: "change_inputs_not_repointed",
      message: `${input.message} Rerun \`legion dev change repoint <changeId>\` to re-point the recorded inputs at the proposal on disk; until then legion ship reports change_traceability_broken for this change.`,
      path: input.path
    })
  ]);
}

/**
 * Run one artifact write, turning **every** failure into a re-point diagnostic.
 *
 * `writeTaskGraph` and `writeEvidenceIndex` catch only
 * `ArtifactRevisionConflictError` and rethrow everything else, and nothing here
 * used to catch what they rethrew. So the designed `change_inputs_not_repointed`
 * diagnostic fired for exactly one failure class and never for the reachable one:
 * with `taskgraph.json` unwritable, `legion review --accept --approver` exited 1
 * with a raw `{"code":"unhandled_error","message":"EPERM: operation not
 * permitted, rename '….tmp' -> '…/taskgraph.json'"}` — no nextAction, no path to
 * a repair, and no statement anywhere that `change.yaml` had already recorded the
 * sign-off. An operator reading that has every reason to believe the accept did
 * nothing.
 */
async function guardedRepointWrite<T extends { readonly ok: boolean }>(
  operation: () => Promise<T>,
  onFailure: (detail: string, status: "invalid" | "conflict") => ChangeBundleFailure
): Promise<T | ChangeBundleFailure> {
  let written: T;
  try {
    written = await operation();
  } catch (error) {
    return onFailure(error instanceof Error ? error.message : String(error), "invalid");
  }
  if (written.ok) return written;
  const result = written as unknown as { readonly status?: string; readonly diagnostics?: readonly ArtifactDiagnostic[] };
  return onFailure(result.diagnostics?.[0]?.message ?? "the write failed", result.status === "conflict" ? "conflict" : "invalid");
}

/**
 * Re-point the artifact-input lists that pinned the proposal we just rewrote.
 *
 * **Why this exists at all.** `legion plan` records the change proposal in the
 * taskgraph's `artifactInputs` (`taskgraph-input.ts`), and `legion build` copies
 * that list into the evidence index's `artifactManifest.inputs`. Both record the
 * proposal's `{sha256, revision}`. Writing an acceptance into `change.yaml`
 * changes both, so `validateArtifactInputFreshness` reports two
 * `stale_revision_reference` diagnostics — and `legion ship` flattens those to
 * `change_traceability_broken` *before any gate is evaluated*, so the very gate
 * the acceptance was written for would never be reached to explain itself.
 * Measured, not theorised: without this the whole-change acceptance gate could
 * never be satisfied end to end.
 *
 * **Why re-pointing is honest, and not a fresher-looking lie.** `artifactInputs`
 * feeds two things: this freshness check and the traceability graph's artifact
 * nodes. The check compares recorded values against *live* artifacts and calls
 * any divergence stale, which is a **currency** assertion — "this document is
 * current with respect to these artifacts" — rather than a **provenance** one.
 * `legion build` already treats it that way: it re-derives the evidence index's
 * taskgraph entry from the live taskgraph at build time, long after the graph
 * was planned. Re-pointing a pin this call itself invalidated is the same
 * maintenance. The next reader will ask; the answer is here rather than left to
 * be re-derived.
 *
 * **What keeps it from being a laundering mechanism** is the selector, and the
 * two selectors carry that whole argument: `namesExactly` for a write that knows
 * the revision it superseded, `namesSuperseded` for the repair that does not.
 * Anything neither selects is left exactly as it is, so `legion ship` keeps
 * reporting it.
 *
 * Ordering is forced. The taskgraph write bumps `taskgraph.json`'s revision, and
 * the evidence index pins that too, so the evidence index must be written second
 * and must substitute both entries. It terminates there: `expectedArtifactInputs`
 * also adds the evidence index's own revision, but the scan walks only the
 * taskgraph's and the evidence index's input lists and neither list contains
 * `evidence-index.json`, so there is no third round.
 *
 * Exported because it is the repair for a torn write, and `repairChangeProposalPins`
 * below is the entry point `legion dev change repoint` calls. That export is not
 * decoration: a process death, an I/O failure or a concurrent writer between the
 * proposal rename and the taskgraph rename used to leave a state with no route
 * out at all, not through any verb and not by hand.
 */
export async function repointChangeProposalInputs(
  input: RepointChangeProposalInputsInput
): Promise<RepointChangeProposalInputsResult> {
  return repointProposalPins({ ...input, select: namesExactly(input.previous) });
}

async function repointProposalPins(
  input: RepointChangeProposalInputsInput & { readonly select: ProposalPinSelector }
): Promise<RepointChangeProposalInputsResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;

  const repointed: ChangeInputRepoint[] = [];
  const baseGitSha = input.baseGitSha;
  const current = input.current;
  const select = input.select;

  const taskGraph = await readTaskGraph({ repositoryRoot: input.repositoryRoot, changeId });
  if (!taskGraph.ok) {
    // A bundle can legitimately exist before a plan, so "there is no taskgraph"
    // is not a failure to re-point — there is nothing pinning the proposal.
    if (taskGraph.status === "not_found") return { ok: true, repointed: [], diagnostics: [] };
    return repointFailure({
      message:
        "This change's task graph could not be read, so the input that pins the change proposal could not be re-pointed at it.",
      path: artifactPathForRole({ role: "taskgraph", changeId })
    });
  }

  const graphInputs = substituteSelected(taskGraph.document.artifactInputs, select, current);
  let taskGraphRevision: ArtifactRevision | undefined;
  if (graphInputs.substituted) {
    const written = await guardedRepointWrite(
      () =>
        writeTaskGraph({
          repositoryRoot: input.repositoryRoot,
          changeId,
          tasks: taskGraph.document.tasks,
          artifactInputs: graphInputs.inputs,
          expectedRevision: taskGraph.document.revision,
          ...(baseGitSha === undefined ? {} : { baseGitSha })
        }),
      (detail, status) =>
        repointFailure({
          message: `This change's task graph could not be re-pointed at the change proposal on disk: ${detail}.`,
          path: taskGraph.artifactPath,
          status
        })
    );
    if (!written.ok) return written as ChangeBundleFailure;
    const graphWrite = written as Extract<Awaited<ReturnType<typeof writeTaskGraph>>, { readonly ok: true }>;
    repointed.push({
      artifactPath: graphWrite.artifactPath,
      from: taskGraph.document.revision,
      to: graphWrite.document.revision,
      inputs: [current.artifact.path]
    });
    taskGraphRevision = graphWrite.revision;
  }

  const evidenceIndex = await readEvidenceIndex({ repositoryRoot: input.repositoryRoot, changeId });
  if (!evidenceIndex.ok) {
    if (evidenceIndex.status === "not_found") {
      return verifyProposalPins({ repositoryRoot: input.repositoryRoot, changeId, current, select, repointed });
    }
    return repointFailure({
      message:
        "This change's evidence index could not be read, so the input that pins the change proposal could not be re-pointed at it.",
      path: artifactPathForRole({ role: "evidence-index", changeId })
    });
  }

  const substitutedPaths: ArtifactPath[] = [];
  const proposalInputs = substituteSelected(evidenceIndex.document.artifactManifest.inputs, select, current);
  if (proposalInputs.substituted) substitutedPaths.push(current.artifact.path);
  let evidenceInputs = proposalInputs.inputs;
  if (taskGraphRevision !== undefined) {
    // The taskgraph pin keeps the **narrow** exact-revision rule, deliberately.
    // Only the bump this call just made is followed, because an evidence index
    // pinning an older taskgraph for any other reason is a genuine replan whose
    // staleness `legion ship` should keep reporting and `legion build` re-derives
    // from the live graph. Widening this one the way the proposal pin was widened
    // would mask that, and unlike the proposal pin it has a command that repairs
    // it.
    const graphPin = substituteSelected(evidenceInputs, namesExactly(taskGraph.revision), taskGraphRevision);
    if (graphPin.substituted) substitutedPaths.push(taskGraphRevision.artifact.path);
    evidenceInputs = graphPin.inputs;
  }
  if (substitutedPaths.length === 0) {
    return verifyProposalPins({ repositoryRoot: input.repositoryRoot, changeId, current, select, repointed });
  }

  const written = await guardedRepointWrite(
    () =>
      writeEvidenceIndex({
        repositoryRoot: input.repositoryRoot,
        changeId,
        entries: evidenceIndex.document.entries,
        artifactInputs: evidenceInputs,
        expectedRevision: evidenceIndex.document.revision,
        ...(baseGitSha === undefined ? {} : { baseGitSha })
      }),
    (detail, status) =>
      repointFailure({
        message: `This change's evidence index could not be re-pointed at the change proposal on disk: ${detail}.`,
        path: evidenceIndex.artifactPath,
        status
      })
  );
  if (!written.ok) return written as ChangeBundleFailure;
  const indexWrite = written as Extract<Awaited<ReturnType<typeof writeEvidenceIndex>>, { readonly ok: true }>;
  repointed.push({
    artifactPath: indexWrite.artifactPath,
    from: evidenceIndex.document.revision,
    to: indexWrite.document.revision,
    inputs: substitutedPaths
  });

  return verifyProposalPins({ repositoryRoot: input.repositoryRoot, changeId, current, select, repointed });
}

/**
 * Re-read both pinned artifacts and confirm the selector matches nothing now.
 *
 * **Why a success path re-reads what it just wrote.** The proposal write and the
 * two re-point writes take three separate per-file locks, one at a time, so a
 * concurrent artifact writer in another process can land between them. Observed
 * in 1 of 3 runs of `legion review --accept --approver` against a concurrent
 * `legion build`: the accept exited 0 reporting `accepted` while the evidence
 * index was left pinning a superseded proposal, and `legion ship` then failed
 * with two `change_traceability_broken` that nothing in the accept's output had
 * hinted at. A cross-file transaction is not available here —
 * `withArtifactWriteLock` is per target path, and holding three at once
 * introduces a lock-ordering problem across every writer in the tree — so this
 * cannot *prevent* the race. It makes the race **reported** rather than silent,
 * which is the difference between an operator who runs the repair and one who
 * does not know there is anything to repair.
 *
 * The check is the caller's own selector re-applied, never a rule of its own.
 * With a rule of its own it would fail the exact path on a state that path is
 * required to leave alone: a hand-edited bundle leaves a pin the exact selector
 * correctly declines to move, and a verifier asking "does any pin name an older
 * revision" would then turn that correct decline into an error and take the
 * accept down with it. What is being verified is "the work this call set out to
 * do is done", which is exactly `select` matching nothing.
 *
 * Two reads, on a path that has already done far more I/O, and only ever on the
 * way to reporting success.
 */
async function verifyProposalPins(input: {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId;
  readonly current: ArtifactRevision;
  readonly select: ProposalPinSelector;
  readonly repointed: readonly ChangeInputRepoint[];
}): Promise<RepointChangeProposalInputsResult> {
  const stale: string[] = [];

  const taskGraph = await readTaskGraph({ repositoryRoot: input.repositoryRoot, changeId: input.changeId });
  if (taskGraph.ok) {
    for (const entry of taskGraph.document.artifactInputs) {
      if (input.select(entry)) stale.push(`${taskGraph.artifactPath} still names revision ${entry.revision}`);
    }
  } else if (taskGraph.status !== "not_found") {
    stale.push(`${artifactPathForRole({ role: "taskgraph", changeId: input.changeId })} could not be re-read`);
  }

  const evidenceIndex = await readEvidenceIndex({ repositoryRoot: input.repositoryRoot, changeId: input.changeId });
  if (evidenceIndex.ok) {
    for (const entry of evidenceIndex.document.artifactManifest.inputs) {
      if (input.select(entry)) stale.push(`${evidenceIndex.artifactPath} still names revision ${entry.revision}`);
    }
  } else if (evidenceIndex.status !== "not_found") {
    stale.push(`${artifactPathForRole({ role: "evidence-index", changeId: input.changeId })} could not be re-read`);
  }

  if (stale.length > 0) {
    return repointFailure({
      message: `The change proposal is at revision ${input.current.revision} on disk, but ${stale.join(
        " and "
      )} — another writer changed these artifacts while the re-point was running.`,
      path: input.current.artifact.path,
      status: "conflict"
    });
  }

  return { ok: true, repointed: input.repointed, diagnostics: [] };
}

/**
 * Re-point this change's recorded inputs at the change proposal on disk.
 *
 * The standalone repair `legion dev change repoint <changeId>` runs, and the
 * only caller of `namesSuperseded`. It exists because the three-rename sequence
 * in `updateChangeAcceptance` had no route out of a partial landing: the sign-off
 * committed to `change.yaml` with the pins still naming the revision before it, a
 * state `legion plan` refuses (`artifact_already_exists`), `legion build` cannot
 * reach, `legion validate` calls valid, and `legion ship` correctly refuses to
 * ship — with no verb and no hand edit that could repair it.
 *
 * Also run by `updateChangeAcceptance` *before* its own write, so an accept
 * retried over a torn state repairs it rather than tearing further, and by
 * `legion review --accept` before it derives the traceability verdict, so a
 * defect this repair is about to fix is not first recorded as a `blocked`
 * acceptance.
 *
 * Idempotent by construction: when every pin already names the live proposal,
 * nothing is substituted and nothing is written, so running it on a healthy
 * change is a pair of reads and a report of no repairs.
 */
export async function repairChangeProposalPins(
  input: RepairChangeProposalPinsInput
): Promise<RepointChangeProposalInputsResult> {
  const loaded = await loadChangeBundle({ repositoryRoot: input.repositoryRoot, changeId: input.changeId });
  if (!loaded.ok) return loaded;
  return repointProposalPins({
    repositoryRoot: input.repositoryRoot,
    changeId: loaded.bundle.change.id,
    previous: loaded.revision,
    current: loaded.revision,
    select: namesSuperseded(loaded.revision),
    ...(input.baseGitSha === undefined ? {} : { baseGitSha: input.baseGitSha })
  });
}

/**
 * Record a whole-change acceptance decision on an existing change bundle.
 *
 * The change service's first write-after-create path. `createChangeBundle`
 * writes `acceptance: {status: "not_ready"}` and, until this, nothing in the
 * workflow ever moved it — so `whole_change_acceptance_evidence` had no
 * producer and `archive`'s `acceptance.status === "accepted"` precondition was
 * unreachable.
 *
 * The optimistic-revision discipline is `writeEvidenceIndex`'s, with one
 * deliberate divergence: **the re-read is `loadChangeBundle`, not a bare
 * `readJsonArtifact`.** That means an acceptance write inherits
 * `delta_artifact_mismatch`, `design_artifact_mismatch`,
 * `decision_artifact_mismatch` and the frontmatter cross-checks — so signing off
 * on a bundle whose own parts no longer match what it records is refused rather
 * than recorded. It is a real behaviour change for `legion review --accept`: a
 * hand-edited `design.md` now blocks acceptance where before it only blocked
 * ship. That is the right refusal and it is stated here because it is a new
 * failure mode for an existing command.
 *
 * `mediaType` is passed explicitly on every write and read of this artifact. The
 * proposal's path is `change.yaml` and its bytes are JSON; `mediaTypeForArtifactPath`
 * would guess `application/yaml`, `referencesEqual` compares `mediaType`, and a
 * reference minted with the wrong one matches nothing in the freshness map.
 *
 * `supersedes` is not optional here even though the schema allows it:
 * `assertSupersededContent` re-hashes the file on disk and refuses unless it
 * still matches the bytes this call read, which is the only thing that closes
 * the window between the re-read and the rename.
 *
 * **The idempotence check compares the whole acceptance object, never
 * `status` alone.** Short-circuiting on `status === "accepted"` would leave a
 * stale `acceptedAt` in place after a rebuild: the writer would report success
 * having written nothing, the gate would keep reporting the sign-off as older
 * than the evidence it claims to cover, and no flag anywhere would make it
 * write. That is the fail-open recorded at `ship-gates.ts`'s `isLiveDeltaSpecGrant`
 * wearing a new costume, and the whole series exists to close it.
 */
export async function updateChangeAcceptance(
  input: UpdateChangeAcceptanceInput
): Promise<UpdateChangeAcceptanceResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;
  const paths = changePaths(changeId);

  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    return failure("invalid", [
      changeDiagnostic({
        code: "invalid_expected_revision",
        message: "Expected revision must be a positive integer; a change bundle is created at revision 1.",
        path: paths.proposal
      })
    ]);
  }

  const parsedAcceptance = acceptanceStateSchema.safeParse(input.acceptance);
  if (!parsedAcceptance.success) {
    return failure(
      "invalid",
      parsedAcceptance.error.issues.map((issue) =>
        changeDiagnostic({
          code: "invalid_acceptance",
          message: `${issue.message}${issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
          path: paths.proposal
        })
      )
    );
  }
  const acceptance = parsedAcceptance.data;

  let baseGitSha: GitSha | undefined;
  if (input.baseGitSha !== undefined) {
    const parsed = parseBaseGitSha(input.baseGitSha, paths.proposal);
    if (typeof parsed !== "string") return parsed;
    baseGitSha = parsed;
  }

  const updatedAt = parseTimestamp({
    value: input.updatedAt,
    path: paths.proposal,
    code: "invalid_updated_at"
  });
  if (typeof updatedAt !== "string") return updatedAt;

  const loaded = await loadChangeBundle({ repositoryRoot: input.repositoryRoot, changeId });
  if (!loaded.ok) return loaded;

  if (loaded.bundle.revision !== input.expectedRevision) {
    return failure("conflict", [
      changeDiagnostic({
        code: "revision_conflict",
        message: `stale artifact revision: expected ${input.expectedRevision}, current ${loaded.bundle.revision}`,
        path: paths.proposal
      })
    ]);
  }

  // **Repair before writing, and before deciding there is nothing to write.**
  // A previous call that tore between the proposal rename and the re-point left
  // the pins naming a superseded proposal, and every later exact-match re-point
  // is powerless against them — so without this, retrying an accept walked the
  // bundle one revision further on every round while repairing nothing, each
  // round recording a fresh verdict on a change that stayed unshippable.
  //
  // It sits above the idempotence check on purpose: a retry that computes the
  // identical acceptance is exactly the shape a retry after a tear takes, and
  // returning `unchanged` without repairing would report success on the state
  // being complained about. It also sits above the proposal write, so its own
  // failure leaves nothing about the acceptance on disk — `written` stays absent
  // and the caller says so.
  const repaired = await repairChangeProposalPins({
    repositoryRoot: input.repositoryRoot,
    changeId,
    ...(baseGitSha === undefined ? {} : { baseGitSha })
  });
  if (!repaired.ok) return repaired;

  if (stableProtocolJson(loaded.bundle.change.acceptance) === stableProtocolJson(acceptance)) {
    return {
      ok: true,
      status: "unchanged",
      bundle: loaded.bundle,
      acceptance: loaded.bundle.change.acceptance,
      artifactPath: loaded.artifactPath,
      reference: loaded.reference,
      revision: loaded.revision,
      repointed: repaired.repointed,
      diagnostics: []
    };
  }

  // Spread rather than a field list, at both levels. `artifactRevisions` is
  // stored twice — on the bundle and on `bundle.change` — and nothing anywhere
  // compares the two, so a rewrite that reconstructs one and not the other
  // produces a document that parses cleanly and disagrees with itself. Spreading
  // closes that by construction instead of by remembering, and it also carries
  // through `currentTruth.baseSpecHash` and `proposedTruth.targetSpecHash`,
  // which are hashes of create-time inputs that cannot be recomputed here and
  // would be wrong if they were.
  const nextBundle = changeBundleSchema.safeParse({
    ...loaded.bundle,
    revision: input.expectedRevision + 1,
    change: {
      ...loaded.bundle.change,
      updatedAt,
      acceptance
    }
  });
  if (!nextBundle.success) {
    return failure(
      "invalid",
      nextBundle.error.issues.map((issue) =>
        changeDiagnostic({
          code: "invalid_change_bundle",
          message: `${issue.message}${issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
          path: paths.proposal
        })
      )
    );
  }

  let write;
  try {
    write = await writeRevisionedArtifact({
      repositoryRoot: input.repositoryRoot,
      artifactPath: paths.proposal,
      role: "proposal",
      content: stableProtocolJson(nextBundle.data),
      expectedRevision: input.expectedRevision,
      currentRevision: input.expectedRevision,
      mediaType: "application/json",
      ...(baseGitSha === undefined ? {} : { baseGitSha }),
      supersedes: loaded.reference
    });
  } catch (error) {
    if (error instanceof ArtifactRevisionConflictError) {
      return failure("conflict", [
        changeDiagnostic({
          code: "revision_conflict",
          message: error.message,
          path: paths.proposal
        })
      ]);
    }
    throw error;
  }

  // The proposal is written first and the pins are re-pointed after, never the
  // other way round. The tear window is the same width either way, but writing
  // the proposal last would leave the taskgraph pinning a proposal revision that
  // does not exist on disk — the same shape, with the human decision lost as
  // well.
  const repoint = await repointChangeProposalInputs({
    repositoryRoot: input.repositoryRoot,
    changeId,
    previous: loaded.revision,
    current: write.revision,
    ...(baseGitSha === undefined ? {} : { baseGitSha })
  });
  if (!repoint.ok) {
    // **The failure says the acceptance landed.** Everything above this line is
    // already committed to disk: `change.yaml` records the verdict at the new
    // revision. A caller told only "the write failed" reports the opposite to
    // the operator — and the one that did said so out loud, printing "Nothing
    // was rolled back: legion ship will report whole_change_acceptance_evidence
    // unevaluable" about a state where the acceptance *was* written and ship
    // never reaches the gate at all, because it flattens the stale pins to
    // `change_traceability_broken` first. `written` is how the caller can tell
    // the two halves of this function apart.
    return { ...repoint, written: { artifactPath: write.artifactPath, acceptance, revision: write.revision } };
  }

  return {
    ok: true,
    status: "updated",
    bundle: nextBundle.data,
    acceptance,
    artifactPath: write.artifactPath,
    reference: write.reference,
    revision: write.revision,
    repointed: [...repaired.repointed, ...repoint.repointed],
    diagnostics: []
  };
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
