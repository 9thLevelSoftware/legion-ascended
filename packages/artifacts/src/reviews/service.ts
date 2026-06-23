import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  changeIdSchema,
  gitShaSchema,
  reviewDecisionSchema,
  reviewIdSchema,
  type ArtifactPath,
  type ArtifactReference,
  type ArtifactRevision,
  type ChangeId,
  type GitSha,
  type ReviewDecision,
  type ReviewId
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

export interface WriteReviewDecisionInput {
  readonly repositoryRoot: string;
  readonly document: ReviewDecision;
  readonly expectedRevision?: number;
  readonly baseGitSha?: GitSha | string;
}

export interface ReadReviewDecisionInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
  readonly reviewId: ReviewId | string;
}

export interface ListReviewDecisionsInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
}

export interface ReviewDecisionSuccess {
  readonly ok: true;
  readonly status: "created" | "updated" | "read";
  readonly document: ReviewDecision;
  readonly artifactPath: ArtifactPath;
  readonly reference: ArtifactReference;
  readonly revision: ArtifactRevision;
  readonly diagnostics: readonly [];
}

export interface ReviewDecisionFailure {
  readonly ok: false;
  readonly status: "invalid" | "not_found" | "conflict";
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

export interface ReviewDecisionListSuccess {
  readonly ok: true;
  readonly status: "read";
  readonly reviews: readonly ReviewDecisionSuccess[];
  readonly diagnostics: readonly [];
}

export type ReviewDecisionResult = ReviewDecisionSuccess | ReviewDecisionFailure;
export type ReviewDecisionListResult = ReviewDecisionListSuccess | ReviewDecisionFailure;

const INVALID_REVIEW_PATH = ".legion/project/changes/invalid-change/reviews/invalid-review.json" as ArtifactPath;
const ARTIFACT_REVISION_METADATA_KEY = "artifact_revision";

function failure(status: ReviewDecisionFailure["status"], diagnostics: readonly ArtifactDiagnostic[]): ReviewDecisionFailure {
  return { ok: false, status, diagnostics };
}

function reviewDiagnostic(input: {
  readonly code: string;
  readonly message: string;
  readonly path?: ArtifactPath;
}): ArtifactDiagnostic {
  return diagnosticForPath({
    code: input.code,
    message: input.message,
    path: input.path ?? INVALID_REVIEW_PATH
  });
}

function schemaDiagnostics(input: {
  readonly code: string;
  readonly path: ArtifactPath;
  readonly issues?: readonly { readonly path?: readonly PropertyKey[]; readonly message: string }[];
}): readonly ArtifactDiagnostic[] {
  if (input.issues === undefined || input.issues.length === 0) {
    return [reviewDiagnostic({ code: input.code, message: "Review decision failed schema validation.", path: input.path })];
  }

  return input.issues.map((issue) =>
    reviewDiagnostic({
      code: input.code,
      message: `${issue.message}${issue.path && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
      path: input.path
    })
  );
}

function parseChangeId(input: ChangeId | string): ChangeId | ReviewDecisionFailure {
  const parsed = changeIdSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        reviewDiagnostic({
          code: "invalid_change_id",
          message: issue.message
        })
      )
    );
  }
  return parsed.data;
}

function parseReviewId(input: ReviewId | string): ReviewId | ReviewDecisionFailure {
  const parsed = reviewIdSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        reviewDiagnostic({
          code: "invalid_review_id",
          message: issue.message
        })
      )
    );
  }
  return parsed.data;
}

function parseBaseGitSha(input: GitSha | string | undefined, artifactPath: ArtifactPath): GitSha | undefined | ReviewDecisionFailure {
  if (input === undefined) return undefined;
  const parsed = gitShaSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        reviewDiagnostic({
          code: "invalid_base_git_sha",
          message: issue.message,
          path: artifactPath
        })
      )
    );
  }
  return parsed.data;
}

function assertExpectedRevision(value: number, path: ArtifactPath): ReviewDecisionFailure | undefined {
  if (!Number.isInteger(value) || value < 0) {
    return failure("invalid", [
      reviewDiagnostic({
        code: "invalid_expected_revision",
        message: "Expected revision must be a non-negative integer.",
        path
      })
    ]);
  }
  return undefined;
}

function reviewPath(changeId: ChangeId, reviewId: ReviewId): ArtifactPath {
  return artifactPathForRole({ role: "review", changeId, reviewId });
}

function storeArtifactRevision(document: ReviewDecision, revision: number): ReviewDecision | ReviewDecisionFailure {
  const parsed = reviewDecisionSchema.safeParse({
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
        code: "invalid_review",
        path: reviewPath(document.changeId, document.id),
        issues: parsed.error.issues
      })
    );
  }
  return parsed.data;
}

function storedArtifactRevision(document: ReviewDecision): number {
  const value = document.metadata?.attributes?.[ARTIFACT_REVISION_METADATA_KEY];
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  return 1;
}

function identityDiagnostics(input: {
  readonly document: ReviewDecision;
  readonly changeId: ChangeId;
  readonly reviewId: ReviewId;
  readonly artifactPath: ArtifactPath;
}): readonly ArtifactDiagnostic[] {
  const diagnostics: ArtifactDiagnostic[] = [];
  if (input.document.changeId !== input.changeId) {
    diagnostics.push(
      reviewDiagnostic({
        code: "review_change_mismatch",
        message: `Review decision change ID ${input.document.changeId} does not match requested change ${input.changeId}.`,
        path: input.artifactPath
      })
    );
  }
  if (input.document.id !== input.reviewId) {
    diagnostics.push(
      reviewDiagnostic({
        code: "review_id_mismatch",
        message: `Review decision ID ${input.document.id} does not match requested review ${input.reviewId}.`,
        path: input.artifactPath
      })
    );
  }
  return diagnostics;
}

export async function writeReviewDecision(input: WriteReviewDecisionInput): Promise<ReviewDecisionResult> {
  const parsed = reviewDecisionSchema.safeParse(input.document);
  if (!parsed.success) {
    return failure(
      "invalid",
      schemaDiagnostics({
        code: "invalid_review",
        path: INVALID_REVIEW_PATH,
        issues: parsed.error.issues
      })
    );
  }

  const artifactPath = reviewPath(parsed.data.changeId, parsed.data.id);
  const expectedRevision = input.expectedRevision ?? 0;
  const revisionError = assertExpectedRevision(expectedRevision, artifactPath);
  if (revisionError !== undefined) return revisionError;

  const baseGitSha = parseBaseGitSha(input.baseGitSha, artifactPath);
  if (baseGitSha !== undefined && typeof baseGitSha !== "string") return baseGitSha;

  let supersedes: ArtifactReference | undefined;
  if (expectedRevision > 0) {
    const current = await readReviewDecision({
      repositoryRoot: input.repositoryRoot,
      changeId: parsed.data.changeId,
      reviewId: parsed.data.id
    });
    if (!current.ok) return current;
    if (current.revision.revision !== expectedRevision) {
      return failure("conflict", [
        reviewDiagnostic({
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
      role: "review",
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
        reviewDiagnostic({
          code: "revision_conflict",
          message: error.message,
          path: artifactPath
        })
      ]);
    }
    throw error;
  }
}

export async function readReviewDecision(input: ReadReviewDecisionInput): Promise<ReviewDecisionResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;
  const reviewId = parseReviewId(input.reviewId);
  if (typeof reviewId !== "string") return reviewId;

  const artifactPath = reviewPath(changeId, reviewId);
  const read = await readJsonArtifact({
    repositoryRoot: input.repositoryRoot,
    artifactPath,
    schema: reviewDecisionSchema
  });
  if (!read.ok) {
    const status = read.diagnostics.some((diagnostic) => diagnostic.code === "not_found") ? "not_found" : "invalid";
    return failure(status, read.diagnostics);
  }

  const diagnostics = identityDiagnostics({
    document: read.value,
    changeId,
    reviewId,
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
      role: "review",
      path: artifactPath,
      content: read.bytes,
      revision: storedRevision,
      mediaType: "application/json"
    }),
    diagnostics: []
  };
}

export async function listReviewDecisionsForChange(input: ListReviewDecisionsInput): Promise<ReviewDecisionListResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;

  const reviewsRoot = path.join(input.repositoryRoot, ".legion", "project", "changes", changeId, "reviews");
  let entries;
  try {
    entries = await readdir(reviewsRoot, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { ok: true, status: "read", reviews: [], diagnostics: [] };
    }
    const message = error instanceof Error ? error.message : String(error);
    return failure("invalid", [
      reviewDiagnostic({
        code: "review_discovery_failed",
        message,
        path: ".legion/project/changes/invalid-change/reviews" as ArtifactPath
      })
    ]);
  }

  const reviews: ReviewDecisionSuccess[] = [];
  for (const entry of entries.filter((candidate) => candidate.isFile()).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.name.endsWith(".json")) continue;
    const reviewId = reviewIdSchema.safeParse(entry.name.slice(0, -".json".length));
    if (!reviewId.success) continue;
    const read = await readReviewDecision({
      repositoryRoot: input.repositoryRoot,
      changeId,
      reviewId: reviewId.data
    });
    if (!read.ok) return read;
    reviews.push(read);
  }

  reviews.sort((left, right) => {
    const byCreatedAt = left.document.createdAt.localeCompare(right.document.createdAt);
    if (byCreatedAt !== 0) return byCreatedAt;
    return left.document.id.localeCompare(right.document.id);
  });

  return { ok: true, status: "read", reviews, diagnostics: [] };
}
