import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  approvalIdSchema,
  approvalSchema,
  changeIdSchema,
  gitShaSchema,
  type Approval,
  type ApprovalId,
  type ArtifactPath,
  type ArtifactReference,
  type ArtifactRevision,
  type ChangeId,
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

export interface WriteApprovalInput {
  readonly repositoryRoot: string;
  readonly document: Approval;
  readonly expectedRevision?: number;
  readonly baseGitSha?: GitSha | string;
}

export interface ReadApprovalInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
  readonly approvalId: ApprovalId | string;
}

export interface ListApprovalsInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
}

export interface ApprovalSuccess {
  readonly ok: true;
  readonly status: "created" | "updated" | "read";
  readonly document: Approval;
  readonly artifactPath: ArtifactPath;
  readonly reference: ArtifactReference;
  readonly revision: ArtifactRevision;
  readonly diagnostics: readonly [];
}

export interface ApprovalFailure {
  readonly ok: false;
  readonly status: "invalid" | "not_found" | "conflict";
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

export interface ApprovalListSuccess {
  readonly ok: true;
  readonly status: "read";
  readonly approvals: readonly ApprovalSuccess[];
  /**
   * Directory entries under `approvals/` that produced no entry in `approvals`.
   *
   * Copied from the task-run listing rather than from the review listing, which
   * silently `continue`s past anything it cannot read and still reports
   * `ok: true`. For approvals that silence is sharper than a miscount: an
   * approval file holds both the grant and, once it is revoked, the revocation.
   * Dropping the file therefore drops the revocation, and a consumer that cannot
   * see the skip reads "this change has no approval" — which is `unevaluable`,
   * blocking, and survivable — or worse, keeps a stale grant it read from
   * somewhere else. The consumer that must be exact now has something to read,
   * and can refuse to answer instead of answering from what it kept.
   *
   * Empty on every healthy change, so callers that ignore it are unaffected.
   */
  readonly skipped: readonly string[];
  readonly diagnostics: readonly [];
}

export type ApprovalResult = ApprovalSuccess | ApprovalFailure;
export type ApprovalListResult = ApprovalListSuccess | ApprovalFailure;

const INVALID_APPROVAL_PATH = ".legion/project/changes/invalid-change/approvals/invalid-approval.json" as ArtifactPath;
const ARTIFACT_REVISION_METADATA_KEY = "artifact_revision";

function failure(status: ApprovalFailure["status"], diagnostics: readonly ArtifactDiagnostic[]): ApprovalFailure {
  return { ok: false, status, diagnostics };
}

function approvalDiagnostic(input: {
  readonly code: string;
  readonly message: string;
  readonly path?: ArtifactPath;
}): ArtifactDiagnostic {
  return diagnosticForPath({
    code: input.code,
    message: input.message,
    path: input.path ?? INVALID_APPROVAL_PATH
  });
}

function schemaDiagnostics(input: {
  readonly code: string;
  readonly path: ArtifactPath;
  readonly issues?: readonly { readonly path?: readonly PropertyKey[]; readonly message: string }[];
}): readonly ArtifactDiagnostic[] {
  if (input.issues === undefined || input.issues.length === 0) {
    return [approvalDiagnostic({ code: input.code, message: "Approval failed schema validation.", path: input.path })];
  }

  return input.issues.map((issue) =>
    approvalDiagnostic({
      code: input.code,
      message: `${issue.message}${issue.path && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
      path: input.path
    })
  );
}

function parseChangeId(input: ChangeId | string): ChangeId | ApprovalFailure {
  const parsed = changeIdSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        approvalDiagnostic({
          code: "invalid_change_id",
          message: issue.message
        })
      )
    );
  }
  return parsed.data;
}

function parseApprovalId(input: ApprovalId | string): ApprovalId | ApprovalFailure {
  const parsed = approvalIdSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        approvalDiagnostic({
          code: "invalid_approval_id",
          message: issue.message
        })
      )
    );
  }
  return parsed.data;
}

function parseBaseGitSha(input: GitSha | string | undefined, artifactPath: ArtifactPath): GitSha | undefined | ApprovalFailure {
  if (input === undefined) return undefined;
  const parsed = gitShaSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        approvalDiagnostic({
          code: "invalid_base_git_sha",
          message: issue.message,
          path: artifactPath
        })
      )
    );
  }
  return parsed.data;
}

function assertExpectedRevision(value: number, path: ArtifactPath): ApprovalFailure | undefined {
  if (!Number.isInteger(value) || value < 0) {
    return failure("invalid", [
      approvalDiagnostic({
        code: "invalid_expected_revision",
        message: "Expected revision must be a non-negative integer.",
        path
      })
    ]);
  }
  return undefined;
}

function approvalPath(changeId: ChangeId, approvalId: ApprovalId): ArtifactPath {
  return artifactPathForRole({ role: "approval", changeId, approvalId });
}

function storeArtifactRevision(document: Approval, revision: number): Approval | ApprovalFailure {
  const parsed = approvalSchema.safeParse({
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
        code: "invalid_approval",
        path: approvalPath(document.changeId, document.id),
        issues: parsed.error.issues
      })
    );
  }
  return parsed.data;
}

function storedArtifactRevision(document: Approval): number {
  const value = document.metadata?.attributes?.[ARTIFACT_REVISION_METADATA_KEY];
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  return 1;
}

function identityDiagnostics(input: {
  readonly document: Approval;
  readonly changeId: ChangeId;
  readonly approvalId: ApprovalId;
  readonly artifactPath: ArtifactPath;
}): readonly ArtifactDiagnostic[] {
  const diagnostics: ArtifactDiagnostic[] = [];
  if (input.document.changeId !== input.changeId) {
    diagnostics.push(
      approvalDiagnostic({
        code: "approval_change_mismatch",
        message: `Approval change ID ${input.document.changeId} does not match requested change ${input.changeId}.`,
        path: input.artifactPath
      })
    );
  }
  if (input.document.id !== input.approvalId) {
    diagnostics.push(
      approvalDiagnostic({
        code: "approval_id_mismatch",
        message: `Approval ID ${input.document.id} does not match requested approval ${input.approvalId}.`,
        path: input.artifactPath
      })
    );
  }
  return diagnostics;
}

/**
 * Write an approval at a revision.
 *
 * An approval's whole lifecycle — requested, granted, denied, revoked — lives at
 * one path under one id, as successive revisions chained through `supersedes`.
 * The alternative, a revocation written as a second document pointing back at
 * the grant, puts the negative fact in a file that can be lost independently of
 * the positive one; losing it promotes a superseded grant back to live, which is
 * the failure this artifact exists to prevent. Here the grant and its revocation
 * are the same bytes and cannot be separated.
 */
export async function writeApproval(input: WriteApprovalInput): Promise<ApprovalResult> {
  const parsed = approvalSchema.safeParse(input.document);
  if (!parsed.success) {
    return failure(
      "invalid",
      schemaDiagnostics({
        code: "invalid_approval",
        path: INVALID_APPROVAL_PATH,
        issues: parsed.error.issues
      })
    );
  }

  const artifactPath = approvalPath(parsed.data.changeId, parsed.data.id);
  const expectedRevision = input.expectedRevision ?? 0;
  const revisionError = assertExpectedRevision(expectedRevision, artifactPath);
  if (revisionError !== undefined) return revisionError;

  const baseGitSha = parseBaseGitSha(input.baseGitSha, artifactPath);
  if (baseGitSha !== undefined && typeof baseGitSha !== "string") return baseGitSha;

  let supersedes: ArtifactReference | undefined;
  if (expectedRevision > 0) {
    const current = await readApproval({
      repositoryRoot: input.repositoryRoot,
      changeId: parsed.data.changeId,
      approvalId: parsed.data.id
    });
    if (!current.ok) return current;
    if (current.revision.revision !== expectedRevision) {
      return failure("conflict", [
        approvalDiagnostic({
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
      role: "approval",
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
        approvalDiagnostic({
          code: "revision_conflict",
          message: error.message,
          path: artifactPath
        })
      ]);
    }
    throw error;
  }
}

export async function readApproval(input: ReadApprovalInput): Promise<ApprovalResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;
  const approvalId = parseApprovalId(input.approvalId);
  if (typeof approvalId !== "string") return approvalId;

  const artifactPath = approvalPath(changeId, approvalId);
  const read = await readJsonArtifact({
    repositoryRoot: input.repositoryRoot,
    artifactPath,
    schema: approvalSchema
  });
  if (!read.ok) {
    const status = read.diagnostics.some((diagnostic) => diagnostic.code === "not_found") ? "not_found" : "invalid";
    return failure(status, read.diagnostics);
  }

  const diagnostics = identityDiagnostics({
    document: read.value,
    changeId,
    approvalId,
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
      role: "approval",
      path: artifactPath,
      content: read.bytes,
      revision: storedRevision,
      mediaType: "application/json"
    }),
    diagnostics: []
  };
}

export async function listApprovalsForChange(input: ListApprovalsInput): Promise<ApprovalListResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;

  const approvalsRoot = path.join(input.repositoryRoot, ".legion", "project", "changes", changeId, "approvals");
  let entries;
  try {
    entries = await readdir(approvalsRoot, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { ok: true, status: "read", approvals: [], skipped: [], diagnostics: [] };
    }
    const message = error instanceof Error ? error.message : String(error);
    return failure("invalid", [
      approvalDiagnostic({
        code: "approval_discovery_failed",
        message,
        path: ".legion/project/changes/invalid-change/approvals" as ArtifactPath
      })
    ]);
  }

  const approvals: ApprovalSuccess[] = [];
  // Every drop is recorded. Nothing writes a subdirectory under `approvals/`
  // today, unlike `reviews/`, which legitimately holds per-review run artifacts
  // — so a directory here is already something unexpected and is reported
  // rather than filtered away, and the `isFile()` guard stays so that the first
  // writer of one produces a skip instead of a parse failure.
  const skipped: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      skipped.push(entry.name);
      continue;
    }
    const approvalId = approvalIdSchema.safeParse(entry.name.slice(0, -".json".length));
    if (!approvalId.success) {
      skipped.push(entry.name);
      continue;
    }
    const read = await readApproval({
      repositoryRoot: input.repositoryRoot,
      changeId,
      approvalId: approvalId.data
    });
    if (!read.ok) {
      skipped.push(entry.name);
      continue;
    }
    approvals.push(read);
  }

  // `createdAt`, not `decidedAt`: `requested` and `expired` approvals carry no
  // decision timestamp at all, and `createdAt` is the request instant, which
  // stays fixed as an approval transitions from granted to revoked in place.
  approvals.sort((left, right) => {
    const byCreatedAt = left.document.createdAt.localeCompare(right.document.createdAt);
    if (byCreatedAt !== 0) return byCreatedAt;
    return left.document.id.localeCompare(right.document.id);
  });

  return { ok: true, status: "read", approvals, skipped, diagnostics: [] };
}
