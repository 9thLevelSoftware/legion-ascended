import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  attestationIdSchema,
  attestationSchema,
  changeIdSchema,
  gitShaSchema,
  type Attestation,
  type AttestationId,
  type ArtifactPath,
  type ArtifactReference,
  type ArtifactRevision,
  type ChangeId,
  type GitSha
} from "@legion/protocol";

import { ArtifactRevisionConflictError, writeRevisionedArtifact } from "../atomic-write.js";
import { artifactPathForRole, diagnosticForPath, type ArtifactDiagnostic } from "../paths.js";
import { artifactRevisionForContent, readJsonArtifact, stableProtocolJson } from "../revisions.js";

export interface WriteAttestationInput {
  readonly repositoryRoot: string;
  readonly document: Attestation;
  readonly expectedRevision?: number;
  readonly baseGitSha?: GitSha | string;
}

export interface ReadAttestationInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
  readonly attestationId: AttestationId | string;
}

export interface ListAttestationsInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
}

export interface AttestationSuccess {
  readonly ok: true;
  readonly status: "created" | "updated" | "read";
  readonly document: Attestation;
  readonly artifactPath: ArtifactPath;
  readonly reference: ArtifactReference;
  readonly revision: ArtifactRevision;
  readonly diagnostics: readonly [];
}

export interface AttestationFailure {
  readonly ok: false;
  readonly status: "invalid" | "not_found" | "conflict";
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

export interface AttestationListSuccess {
  readonly ok: true;
  readonly status: "read";
  readonly attestations: readonly AttestationSuccess[];
  /**
   * Directory entries under `attestations/` that produced no entry above.
   *
   * Copied from the approvals listing, and load-bearing for the same reason
   * sharpened by one degree. An attestation file holds whichever verdict was
   * last recorded for its kind — and because re-attesting *replaces* rather than
   * accumulates, a `fail` or a `not_applicable` lives at exactly the path a
   * `pass` used to. So a dropped file is as likely to drop a negative as a
   * positive, and a consumer that cannot see the skip answers from what it kept.
   * `legion ship` turns any skip into whole-plane absence instead.
   *
   * Empty on every healthy change, so callers that ignore it are unaffected.
   */
  readonly skipped: readonly string[];
  readonly diagnostics: readonly [];
}

export type AttestationResult = AttestationSuccess | AttestationFailure;
export type AttestationListResult = AttestationListSuccess | AttestationFailure;

const INVALID_ATTESTATION_PATH =
  ".legion/project/changes/invalid-change/attestations/invalid-attestation.json" as ArtifactPath;
const ARTIFACT_REVISION_METADATA_KEY = "artifact_revision";

function failure(
  status: AttestationFailure["status"],
  diagnostics: readonly ArtifactDiagnostic[]
): AttestationFailure {
  return { ok: false, status, diagnostics };
}

function attestationDiagnostic(input: {
  readonly code: string;
  readonly message: string;
  readonly path?: ArtifactPath;
}): ArtifactDiagnostic {
  return diagnosticForPath({
    code: input.code,
    message: input.message,
    path: input.path ?? INVALID_ATTESTATION_PATH
  });
}

function schemaDiagnostics(input: {
  readonly code: string;
  readonly path: ArtifactPath;
  readonly issues?: readonly { readonly path?: readonly PropertyKey[]; readonly message: string }[];
}): readonly ArtifactDiagnostic[] {
  if (input.issues === undefined || input.issues.length === 0) {
    return [
      attestationDiagnostic({
        code: input.code,
        message: "Attestation failed schema validation.",
        path: input.path
      })
    ];
  }

  return input.issues.map((issue) =>
    attestationDiagnostic({
      code: input.code,
      message: `${issue.message}${issue.path && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}`,
      path: input.path
    })
  );
}

function parseChangeId(input: ChangeId | string): ChangeId | AttestationFailure {
  const parsed = changeIdSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        attestationDiagnostic({ code: "invalid_change_id", message: issue.message })
      )
    );
  }
  return parsed.data;
}

function parseAttestationId(input: AttestationId | string): AttestationId | AttestationFailure {
  const parsed = attestationIdSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        attestationDiagnostic({ code: "invalid_attestation_id", message: issue.message })
      )
    );
  }
  return parsed.data;
}

function parseBaseGitSha(
  input: GitSha | string | undefined,
  artifactPath: ArtifactPath
): GitSha | undefined | AttestationFailure {
  if (input === undefined) return undefined;
  const parsed = gitShaSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid",
      parsed.error.issues.map((issue) =>
        attestationDiagnostic({ code: "invalid_base_git_sha", message: issue.message, path: artifactPath })
      )
    );
  }
  return parsed.data;
}

function assertExpectedRevision(value: number, artifactPath: ArtifactPath): AttestationFailure | undefined {
  if (!Number.isInteger(value) || value < 0) {
    return failure("invalid", [
      attestationDiagnostic({
        code: "invalid_expected_revision",
        message: "Expected revision must be a non-negative integer.",
        path: artifactPath
      })
    ]);
  }
  return undefined;
}

function attestationPath(changeId: ChangeId, attestationId: AttestationId): ArtifactPath {
  return artifactPathForRole({ role: "attestation", changeId, attestationId });
}

function storeArtifactRevision(document: Attestation, revision: number): Attestation | AttestationFailure {
  const parsed = attestationSchema.safeParse({
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
        code: "invalid_attestation",
        path: attestationPath(document.changeId, document.id),
        issues: parsed.error.issues
      })
    );
  }
  return parsed.data;
}

function storedArtifactRevision(document: Attestation): number {
  const value = document.metadata?.attributes?.[ARTIFACT_REVISION_METADATA_KEY];
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  return 1;
}

function identityDiagnostics(input: {
  readonly document: Attestation;
  readonly changeId: ChangeId;
  readonly attestationId: AttestationId;
  readonly artifactPath: ArtifactPath;
}): readonly ArtifactDiagnostic[] {
  const diagnostics: ArtifactDiagnostic[] = [];
  if (input.document.changeId !== input.changeId) {
    diagnostics.push(
      attestationDiagnostic({
        code: "attestation_change_mismatch",
        message: `Attestation change ID ${input.document.changeId} does not match requested change ${input.changeId}.`,
        path: input.artifactPath
      })
    );
  }
  if (input.document.id !== input.attestationId) {
    diagnostics.push(
      attestationDiagnostic({
        code: "attestation_id_mismatch",
        message: `Attestation ID ${input.document.id} does not match requested attestation ${input.attestationId}.`,
        path: input.artifactPath
      })
    );
  }
  return diagnostics;
}

/**
 * Write an attestation at a revision.
 *
 * One document per `(changeId, attests)` pair, replaced in place as successive
 * revisions chained through `supersedes` — the approvals storage model, adopted
 * for a reason that is sharper here than there. Every gate that reads this plane
 * asks an existential ("a `pass` attestation of the right kind whose sources
 * hash clean"), and an existential over a set that can accumulate means a later
 * `fail` sits beside an earlier `pass` and never overturns it. Approvals bought
 * that back with a strictly-later supersession rule over `decidedAt`; an
 * attestation has no status lattice and no ordered decision field to build one
 * on, so the storage model has to carry it. Re-attesting replaces, so a `fail`
 * genuinely displaces a `pass` and each gate can be a positive check on one
 * record rather than a quantifier over a possibly-empty set.
 */
export async function writeAttestation(input: WriteAttestationInput): Promise<AttestationResult> {
  const parsed = attestationSchema.safeParse(input.document);
  if (!parsed.success) {
    return failure(
      "invalid",
      schemaDiagnostics({
        code: "invalid_attestation",
        path: INVALID_ATTESTATION_PATH,
        issues: parsed.error.issues
      })
    );
  }

  const artifactPath = attestationPath(parsed.data.changeId, parsed.data.id);
  const expectedRevision = input.expectedRevision ?? 0;
  const revisionError = assertExpectedRevision(expectedRevision, artifactPath);
  if (revisionError !== undefined) return revisionError;

  const baseGitSha = parseBaseGitSha(input.baseGitSha, artifactPath);
  if (baseGitSha !== undefined && typeof baseGitSha !== "string") return baseGitSha;

  let supersedes: ArtifactReference | undefined;
  if (expectedRevision > 0) {
    const current = await readAttestation({
      repositoryRoot: input.repositoryRoot,
      changeId: parsed.data.changeId,
      attestationId: parsed.data.id
    });
    if (!current.ok) return current;
    if (current.revision.revision !== expectedRevision) {
      return failure("conflict", [
        attestationDiagnostic({
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
      role: "attestation",
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
        attestationDiagnostic({ code: "revision_conflict", message: error.message, path: artifactPath })
      ]);
    }
    throw error;
  }
}

export async function readAttestation(input: ReadAttestationInput): Promise<AttestationResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;
  const attestationId = parseAttestationId(input.attestationId);
  if (typeof attestationId !== "string") return attestationId;

  const artifactPath = attestationPath(changeId, attestationId);
  const read = await readJsonArtifact({
    repositoryRoot: input.repositoryRoot,
    artifactPath,
    schema: attestationSchema
  });
  if (!read.ok) {
    const status = read.diagnostics.some((diagnostic) => diagnostic.code === "not_found")
      ? "not_found"
      : "invalid";
    return failure(status, read.diagnostics);
  }

  const diagnostics = identityDiagnostics({
    document: read.value,
    changeId,
    attestationId,
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
      role: "attestation",
      path: artifactPath,
      content: read.bytes,
      revision: storedRevision,
      mediaType: "application/json"
    }),
    diagnostics: []
  };
}

export async function listAttestationsForChange(
  input: ListAttestationsInput
): Promise<AttestationListResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;

  const attestationsRoot = path.join(
    input.repositoryRoot,
    ".legion",
    "project",
    "changes",
    changeId,
    "attestations"
  );
  let entries;
  try {
    entries = await readdir(attestationsRoot, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { ok: true, status: "read", attestations: [], skipped: [], diagnostics: [] };
    }
    const message = error instanceof Error ? error.message : String(error);
    return failure("invalid", [
      attestationDiagnostic({
        code: "attestation_discovery_failed",
        message,
        path: ".legion/project/changes/invalid-change/attestations" as ArtifactPath
      })
    ]);
  }

  const attestations: AttestationSuccess[] = [];
  // Every drop is recorded, including a directory: nothing writes a subdirectory
  // under `attestations/`, so one is already something unexpected and is
  // reported rather than filtered away.
  const skipped: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      skipped.push(entry.name);
      continue;
    }
    const attestationId = attestationIdSchema.safeParse(entry.name.slice(0, -".json".length));
    if (!attestationId.success) {
      skipped.push(entry.name);
      continue;
    }
    const read = await readAttestation({
      repositoryRoot: input.repositoryRoot,
      changeId,
      attestationId: attestationId.data
    });
    if (!read.ok) {
      skipped.push(entry.name);
      continue;
    }
    attestations.push(read);
  }

  // `createdAt`, not `attestedAt`: `createdAt` is the fixed write instant and
  // survives a re-attestation, while `attestedAt` is operator-supplied and moves
  // every time the assertion is retaken. A listing whose order depends on the
  // moving field reorders itself for no reason.
  attestations.sort((left, right) => {
    const byCreatedAt = left.document.createdAt.localeCompare(right.document.createdAt);
    if (byCreatedAt !== 0) return byCreatedAt;
    return left.document.id.localeCompare(right.document.id);
  });

  return { ok: true, status: "read", attestations, skipped, diagnostics: [] };
}
