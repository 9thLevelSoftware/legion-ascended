import {
  changeIdSchema,
  gitShaSchema,
  releaseSchema,
  type ArtifactPath,
  type ArtifactReference,
  type ArtifactRevision,
  type ChangeId,
  type GitSha,
  type Release
} from "@legion/protocol";

import { ArtifactRevisionConflictError, writeRevisionedArtifact } from "../atomic-write.js";
import { artifactPathForRole, diagnosticForPath, type ArtifactDiagnostic } from "../paths.js";
import { artifactRevisionForContent, readJsonArtifact, stableProtocolJson } from "../revisions.js";

/**
 * The release plan a change records, at `changes/<changeId>/release.json`.
 *
 * Modelled on the attestations service, with one structural difference that
 * removes machinery rather than adding it: **there is exactly one release
 * document per change**, so this module has no listing, no `skipped` array and
 * no directory. That is why `legion ship` grows no new `ShipGatePlaneSkip` entry
 * for this plane — a plane with one file has nothing to report a partial read
 * *of*, and the two states that matter (no file, and a file that will not parse)
 * are already distinguishable from `readRelease`'s own status.
 *
 * The consequence is that the identity check here is `changeId` alone, on
 * `readArchiveRecord`'s rule rather than `readAttestation`'s: for an artifact
 * keyed by its path, the path *is* the identity, and `document.id` is a readable
 * name rather than a locator. A document whose `changeId` names another change
 * is refused, because a release plan is a statement about one change and reading
 * it as another change's plan is the one substitution that would satisfy a gate
 * from a document nobody wrote for it.
 *
 * `releaseSchema` is a discriminated union wrapped in a `superRefine`, so
 * `.extend`/`.partial` are unavailable on it — the revision metadata is stored
 * by spreading and re-parsing rather than by extending the schema.
 */

export interface WriteReleaseInput {
  readonly repositoryRoot: string;
  readonly document: Release;
  readonly expectedRevision?: number;
  readonly baseGitSha?: GitSha | string;
}

export interface ReadReleaseInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
}

export interface ReleaseSuccess {
  readonly ok: true;
  readonly status: "created" | "updated" | "read";
  readonly document: Release;
  readonly artifactPath: ArtifactPath;
  readonly reference: ArtifactReference;
  readonly revision: ArtifactRevision;
  readonly diagnostics: readonly [];
}

export interface ReleaseFailure {
  readonly ok: false;
  readonly status: "invalid" | "not_found" | "conflict";
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

export type ReleaseResult = ReleaseSuccess | ReleaseFailure;

const INVALID_RELEASE_PATH = ".legion/project/changes/invalid-change/release.json" as ArtifactPath;
const ARTIFACT_REVISION_METADATA_KEY = "artifact_revision";

function failure(status: ReleaseFailure["status"], diagnostics: readonly ArtifactDiagnostic[]): ReleaseFailure {
  return { ok: false, status, diagnostics };
}

function releaseDiagnostic(input: {
  readonly code: string;
  readonly message: string;
  readonly path?: ArtifactPath;
}): ArtifactDiagnostic {
  return diagnosticForPath({
    code: input.code,
    message: input.message,
    path: input.path ?? INVALID_RELEASE_PATH
  });
}

function schemaDiagnostics(input: {
  readonly code: string;
  readonly path: ArtifactPath;
  readonly issues?: readonly { readonly path?: readonly PropertyKey[]; readonly message: string }[];
}): readonly ArtifactDiagnostic[] {
  if (input.issues === undefined || input.issues.length === 0) {
    return [
      releaseDiagnostic({
        code: input.code,
        message: "Release failed schema validation.",
        path: input.path
      })
    ];
  }

  return input.issues.map((issue) =>
    releaseDiagnostic({
      code: input.code,
      message: `${issue.message}${issue.path && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
      path: input.path
    })
  );
}

function parseChangeId(input: ChangeId | string): ChangeId | ReleaseFailure {
  const parsed = changeIdSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) => releaseDiagnostic({ code: "invalid_change_id", message: issue.message }))
    );
  }
  return parsed.data;
}

function parseBaseGitSha(
  input: GitSha | string | undefined,
  artifactPath: ArtifactPath
): GitSha | undefined | ReleaseFailure {
  if (input === undefined) return undefined;
  const parsed = gitShaSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        releaseDiagnostic({ code: "invalid_base_git_sha", message: issue.message, path: artifactPath })
      )
    );
  }
  return parsed.data;
}

function assertExpectedRevision(value: number, artifactPath: ArtifactPath): ReleaseFailure | undefined {
  if (!Number.isInteger(value) || value < 0) {
    return failure("invalid", [
      releaseDiagnostic({
        code: "invalid_expected_revision",
        message: "Expected revision must be a non-negative integer.",
        path: artifactPath
      })
    ]);
  }
  return undefined;
}

function releasePath(changeId: ChangeId): ArtifactPath {
  return artifactPathForRole({ role: "release", changeId });
}

function storeArtifactRevision(document: Release, revision: number): Release | ReleaseFailure {
  const parsed = releaseSchema.safeParse({
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
        code: "invalid_release",
        path: releasePath(document.changeId),
        issues: parsed.error.issues
      })
    );
  }
  return parsed.data;
}

function storedArtifactRevision(document: Release): number {
  const value = document.metadata?.attributes?.[ARTIFACT_REVISION_METADATA_KEY];
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  return 1;
}

/**
 * Write the release plan at a revision.
 *
 * One document per change, replaced in place as successive revisions chained
 * through `supersedes`. The reason is the attestation service's, one degree
 * sharper: `release_observation_plan` reads *this document's status*, and a
 * `failed` or `rollback_required` release is a negative fact. If plans
 * accumulated, a fresh `requested` plan would sit beside the `failed` one and the
 * gate's existential would find the favourable record — the
 * favourable-hides-unfavourable fail-open that one-document-per-subject exists to
 * remove.
 */
export async function writeRelease(input: WriteReleaseInput): Promise<ReleaseResult> {
  const parsed = releaseSchema.safeParse(input.document);
  if (!parsed.success) {
    return failure(
      "invalid",
      schemaDiagnostics({
        code: "invalid_release",
        path: INVALID_RELEASE_PATH,
        issues: parsed.error.issues
      })
    );
  }

  const artifactPath = releasePath(parsed.data.changeId);
  const expectedRevision = input.expectedRevision ?? 0;
  const revisionError = assertExpectedRevision(expectedRevision, artifactPath);
  if (revisionError !== undefined) return revisionError;

  const baseGitSha = parseBaseGitSha(input.baseGitSha, artifactPath);
  if (baseGitSha !== undefined && typeof baseGitSha !== "string") return baseGitSha;

  let supersedes: ArtifactReference | undefined;
  if (expectedRevision > 0) {
    const current = await readRelease({
      repositoryRoot: input.repositoryRoot,
      changeId: parsed.data.changeId
    });
    if (!current.ok) return current;
    if (current.revision.revision !== expectedRevision) {
      return failure("conflict", [
        releaseDiagnostic({
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
      role: "release",
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
        releaseDiagnostic({ code: "revision_conflict", message: error.message, path: artifactPath })
      ]);
    }
    throw error;
  }
}

export async function readRelease(input: ReadReleaseInput): Promise<ReleaseResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;

  const artifactPath = releasePath(changeId);
  const read = await readJsonArtifact({
    repositoryRoot: input.repositoryRoot,
    artifactPath,
    schema: releaseSchema
  });
  if (!read.ok) {
    const status = read.diagnostics.some((diagnostic) => diagnostic.code === "not_found") ? "not_found" : "invalid";
    return failure(status, read.diagnostics);
  }

  // `changeId` only. The path is the identity for a singular per-change
  // artifact, so there is no separate id to disagree with it — but a document
  // naming another change at this path is refused rather than read, because a
  // gate satisfied by another change's plan is satisfied by a document nobody
  // wrote for it.
  if (read.value.changeId !== changeId) {
    return failure("invalid", [
      releaseDiagnostic({
        code: "release_change_mismatch",
        message: `Release change ID ${read.value.changeId} does not match requested change ${changeId}.`,
        path: artifactPath
      })
    ]);
  }

  const storedRevision = storedArtifactRevision(read.value);
  return {
    ok: true,
    status: "read",
    document: read.value,
    artifactPath,
    reference: read.reference,
    revision: artifactRevisionForContent({
      role: "release",
      path: artifactPath,
      content: read.bytes,
      revision: storedRevision,
      mediaType: "application/json"
    }),
    diagnostics: []
  };
}
