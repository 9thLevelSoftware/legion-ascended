import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { hashContent } from "@legion/artifacts";
import type { ArtifactReference } from "@legion/protocol";

/**
 * Re-verifying the artifacts a governance record pinned.
 *
 * An approval, an attestation or a verification surface records the bytes it
 * was granted against by content hash. A gate that reads such a record without
 * re-hashing the file certifies the approval, not the artifact: the delta spec
 * or oracle can be edited after approval and the gate still passes. That is the
 * tampering these gates exist to catch, so the re-verification lives here and
 * every gate that consumes a pin goes through it.
 *
 * Three properties this module holds, each of which is a defect if dropped:
 *
 * 1. **It hashes with `hashContent`.** That helper returns the protocol
 *    `ContentHash` in the `sha256:<hex>` form `ArtifactReference.sha256` is
 *    typed as, and every pin in the tree was minted through it (via
 *    `artifactReferenceForContent`). A hand-rolled
 *    `createHash("sha256").digest("hex")` yields a bare hex string that can
 *    never equal a stored pin, and the symptom is `drift` reported against a
 *    clean artifact.
 *
 * 2. **It does not normalize line endings.** `hashContent` hashes raw bytes.
 *    (The CRLF-normalizing `hashBytes` in the requirements service is a
 *    different, private helper and none of these pins were minted with it.)
 *    Normalizing here would disagree with every pin on a Windows checkout with
 *    CRLF in the working tree, and PRs that block on drift would block on
 *    nothing.
 *
 * 3. **It resolves paths itself and never throws.** `resolveProjectArtifactPath`
 *    raises `ArtifactPathError` for any path outside `.legion/project`, for any
 *    uppercase character and for any `:`. Pinned references are not limited to
 *    project artifacts — a verification surface or an attestation pins ordinary
 *    repository files such as `docs/next/evidence/P13-T02/threat-model.json`,
 *    which `artifactPathSchema` accepts and that resolver refuses. Building on
 *    it would make `legion ship` die on the very pins it exists to check, and
 *    `legion ship` is the honest-reporting command: a thrown error there is the
 *    worst available failure. Every refusal is a verdict instead.
 *
 *    Dropping that resolver drops its two Windows defences with it, so both are
 *    reinstated below as verdicts rather than as exceptions — see
 *    `namesSomethingOtherThanTheTrackedFile`. Dropping a defence is only a
 *    widening when the reason it existed no longer applies, and both reasons
 *    still apply here.
 */
export type PinVerdict =
  /** The file is present and its bytes hash to the pinned digest. */
  | "match"
  /**
   * The file is present and hashes to something else. Evidence exists and is
   * negative: a consuming gate reports `unsatisfied`, never `unevaluable`.
   */
  | "drift"
  /**
   * The path does not resolve to a file. A pin asserts the file existed at that
   * digest, so its absence is a negative answer too — also `unsatisfied`.
   */
  | "missing"
  /**
   * The pin was not checked: nobody pre-resolved this reference, the path left
   * the repository, the path names something other than the file the repository
   * tracks there, or the read failed for a reason other than absence. A
   * consuming gate reports `unevaluable`. This state exists because the
   * verifier is pre-resolved (hashing is I/O; the gate evaluator is
   * synchronous), so a gate can ask about a reference no collector gathered.
   * Folding that into `missing` would report "the approved artifact is gone"
   * about a file sitting right there; folding it into `match` would be a
   * fail-open.
   */
  | "unverified";

export type VerifyPinnedReference = (reference: ArtifactReference) => PinVerdict;

export interface ResolvePinnedReferencesInput {
  readonly repositoryRoot: string;
  /**
   * Every reference a gate may ask about. References sharing a path are read
   * once, so a pin can be re-checked against several records for one read.
   */
  readonly references: Iterable<ArtifactReference>;
}

/** What one path resolved to. `undefined` digest means it could not be hashed. */
type ResolvedPath =
  | { readonly kind: "hashed"; readonly sha256: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unverified" };

function isErrorCode(error: unknown, ...codes: readonly string[]): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

/**
 * Whether `candidate` is `root` or sits underneath it.
 *
 * The artifact-path regex already refuses `..` segments and absolute paths, but
 * it cannot refuse a symlink whose target leaves the repository — and a pin
 * that reads through such a link would hash a file the repository does not
 * contain. Containment is therefore checked after `realpath`, on the resolved
 * location, not on the declared one.
 */
function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Whether a pinned path denotes something other than the file the repository
 * tracks at that path.
 *
 * `artifactPathSchema` permits `:` inside a segment — it only refuses a leading
 * drive letter — so `docs/notes.md:approved` is a schema-valid reference, not an
 * impossible fixture. On Windows that names an NTFS alternate data stream: bytes
 * attached to `docs/notes.md` that git does not track and no reviewer sees.
 * Hashing them answers `match` while the tracked file at the same path says
 * something else, which is precisely the tampering this module exists to catch,
 * inverted. Refused unconditionally rather than under `process.platform ===
 * "win32"`, because a pin is written once and verified on whatever machine ships
 * the change; a reference that verifies on Linux and fails open on Windows is
 * worse than one that never verifies.
 */
function isWindowsStreamPath(artifactPath: string): boolean {
  return artifactPath.includes(":");
}

/**
 * Whether the file that was actually opened differs from the declared path only
 * by letter case.
 *
 * The project resolver refuses uppercase outright. This module cannot — real
 * pins name `docs/next/evidence/P13-T02/threat-model.json` — so the equivalent
 * defence is applied to the *resolved* location instead: `realpath` returns the
 * casing the filesystem stores (verified on Windows), so a declared path that
 * case-folds onto a differently-cased file is visible here and nowhere else.
 * It matters because a repository can contain `docs/NOTES.md` and
 * `docs/notes.md` as two tracked files on Linux and only one after a Windows
 * checkout, at which point a pin on the missing one silently verifies the
 * survivor.
 *
 * Only case-folding aliases are refused, not every path whose real location
 * differs. A symlink that resolves elsewhere inside the repository is still
 * hashed, which is the containment rule immediately above deliberately
 * permitting in-repository links; folding the two checks together would revoke
 * that without saying so.
 */
function isCaseFoldedAlias(declaredPath: string, resolvedRelative: string): boolean {
  return (
    resolvedRelative !== declaredPath &&
    resolvedRelative.toLowerCase() === declaredPath.toLowerCase()
  );
}

async function resolveOne(repositoryRoot: string, artifactPath: string): Promise<ResolvedPath> {
  if (isWindowsStreamPath(artifactPath)) return { kind: "unverified" };

  const segments = artifactPath.split("/");
  const target = path.resolve(repositoryRoot, ...segments);
  if (!contains(path.resolve(repositoryRoot), target)) return { kind: "unverified" };

  try {
    const [realRoot, realTarget] = await Promise.all([realpath(repositoryRoot), realpath(target)]);
    if (!contains(realRoot, realTarget)) return { kind: "unverified" };
    if (isCaseFoldedAlias(artifactPath, path.relative(realRoot, realTarget).split(path.sep).join("/"))) {
      return { kind: "unverified" };
    }
    return { kind: "hashed", sha256: hashContent(await readFile(realTarget)) };
  } catch (error) {
    // ENOENT and ENOTDIR are the file genuinely not being there. Everything
    // else — EACCES, EISDIR, ELOOP, a name the platform refuses — is a read
    // that failed, which is not a read that returned nothing. Reporting those
    // as `missing` would blame the artifact for the reader's problem, and a
    // gate would block on a file that is present and correct.
    if (isErrorCode(error, "ENOENT", "ENOTDIR")) return { kind: "missing" };
    return { kind: "unverified" };
  }
}

/**
 * Hash every distinct referenced path once, then answer synchronously.
 *
 * The split exists because `deriveShipGates` is synchronous and pure — its two
 * unit suites call it with plain object literals and no `await`, and every gate
 * added on top of it inherits that. Doing the I/O here and injecting the answer
 * keeps it that way.
 *
 * The bytes are read at resolution time, so a file edited between here and the
 * gate's question reports the state at resolution. That is deliberate: the
 * report is then a snapshot of one moment rather than a mix of epochs.
 */
export async function resolvePinnedReferences(
  input: ResolvePinnedReferencesInput
): Promise<VerifyPinnedReference> {
  const resolved = new Map<string, ResolvedPath>();

  for (const reference of input.references) {
    if (resolved.has(reference.path)) continue;
    resolved.set(reference.path, await resolveOne(input.repositoryRoot, reference.path));
  }

  return (reference: ArtifactReference): PinVerdict => {
    const entry = resolved.get(reference.path);
    if (entry === undefined) return "unverified";
    if (entry.kind === "missing") return "missing";
    if (entry.kind === "unverified") return "unverified";
    return entry.sha256 === reference.sha256 ? "match" : "drift";
  };
}
