/**
 * P09-T01 — Deterministic path-level conflict detector.
 *
 * The merge queue MUST detect overlapping write paths between
 * sequenced entries before it allows the rebase step to advance.
 * Detection is path-based (NOT byte-based) and is fully deterministic:
 * given the same ordered entries and ownership map, the detector
 * returns the same `ConflictReport[]`.
 *
 * Why this lives in its own module:
 *  - The merge queue orchestrator calls `detectPathConflicts` per
 *    step; the detector is pure and side-effect free.
 *  - The CLI adapter can wrap a richer filesystem-level conflict
 *    detector (e.g. `git merge-tree`) and feed its results into the
 *    same `ConflictReport` shape — keeping the surface provider-
 *    neutral.
 *
 * Conflict semantics:
 *  - Two entries "overlap" when their `TaskContract.scope.write`
 *    paths intersect (exact path equality OR one is a sub-path of
 *    the other).
 *  - Sequential violations occur when a `sequentialFiles` path in
 *    entry N+1 was already claimed by an earlier entry's `write`
 *    scope.
 *  - The detector never reads from disk; it works from the supplied
 *    entry contracts and ownership map.
 */

import type { ConflictReport, MergeQueueEntry, PathOwnershipClaim, PathOwnershipMap } from "./contract.js";

/**
 * Normalize a POSIX path so substring/equality comparisons are
 * consistent regardless of trailing slashes or `./` prefixes.
 */
export function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const rawSegment of path.split("/")) {
    if (rawSegment === "" || rawSegment === ".") continue;
    if (rawSegment === "..") {
      segments.pop();
      continue;
    }
    segments.push(rawSegment);
  }
  return segments.join("/");
}

/**
 * Two paths conflict if either:
 *  - they are equal, OR
 *  - one is a strict prefix of the other (parent/child relationship).
 *
 * The detector returns true in both cases — a parent write covers
 * every descendant, and a child write touches the parent's scope.
 */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === 0 || b.length === 0) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Build an ownership claim set from a single entry. The detector
 * never inspects filesystem state; it only knows what the entry
 * declared in its contract.
 */
export function claimsForEntry(entry: MergeQueueEntry): readonly PathOwnershipClaim[] {
  const claims: PathOwnershipClaim[] = [];
  for (const writePath of entry.taskContract.scope.write) {
    claims.push({
      path: normalizePath(writePath),
      ownerEntrySequenceIndex: entry.sequenceIndex,
      kind: "write"
    });
  }
  for (const sequentialPath of entry.taskContract.scope.sequentialFiles) {
    claims.push({
      path: normalizePath(sequentialPath),
      ownerEntrySequenceIndex: entry.sequenceIndex,
      kind: "sequential"
    });
  }
  return claims;
}

/**
 * Detect path conflicts for an ordered set of entries.
 *
 * Algorithm:
 *  1. Walk entries in `sequenceIndex` order.
 *  2. For each entry, compute the union of normalized `write` paths
 *     and `sequentialFiles` paths.
 *  3. Compare against claims from any earlier entry whose write
 *     scopes overlap. Overlap produces an `overlapping_write`
 *     conflict; sequentialFiles touching an earlier entry's write
 *     scope produces a `sequential_violation`.
 *  4. Honor an externally supplied `PathOwnershipMap` if provided —
 *     it lets the CLI inject filesystem-level ownership claims
 *     (e.g. claims discovered by `git ls-tree`).
 *
 * Returns a stable, sorted, deduped array of `ConflictReport`
 * entries so two detectors running on the same input always return
 * the same shape.
 */
export function detectPathConflicts(
  entries: readonly MergeQueueEntry[],
  ownership?: PathOwnershipMap
): readonly ConflictReport[] {
  const ordered = [...entries].sort((a, b) => a.sequenceIndex - b.sequenceIndex);

  // Map: normalized path -> set of sequence indices that claimed it.
  const claimsByPath = new Map<string, Set<number>>();
  const conflictKey = (path: string, index: number) => `${path}|${index}`;
  const conflicts = new Map<string, ConflictReport>();

  const recordClaim = (path: string, ownerIndex: number, _kind: PathOwnershipClaim["kind"]) => {
    const existing = claimsByPath.get(path) ?? new Set<number>();
    const alreadySeen = existing.has(ownerIndex);
    if (!alreadySeen) existing.add(ownerIndex);
    claimsByPath.set(path, existing);
  };

  const recordConflict = (path: string, indices: readonly number[], reason: ConflictReport["reason"]) => {
    if (indices.length < 2) return;
    const sortedIndices = [...new Set(indices)].sort((a, b) => a - b);
    const key = `${path}|${reason}`;
    const existing = conflicts.get(key);
    if (existing !== undefined) {
      const merged = new Set<number>([...existing.conflictingEntrySequenceIndices, ...sortedIndices]);
      conflicts.set(key, {
        path,
        conflictingEntrySequenceIndices: [...merged].sort((a, b) => a - b),
        reason
      });
      return;
    }
    conflicts.set(key, {
      path,
      conflictingEntrySequenceIndices: sortedIndices,
      reason
    });
  };

  // Layer 1: external ownership map (filesystem-discovered claims).
  if (ownership !== undefined) {
    for (const entry of ordered) {
      for (const writePath of entry.taskContract.scope.write) {
        const normalized = normalizePath(writePath);
        const externalClaims = ownership.forPath(normalized);
        for (const external of externalClaims) {
          if (external.ownerEntrySequenceIndex === entry.sequenceIndex) continue;
          recordClaim(normalized, external.ownerEntrySequenceIndex, external.kind);
          recordClaim(normalized, entry.sequenceIndex, "write");
          recordConflict(normalized, [external.ownerEntrySequenceIndex, entry.sequenceIndex], "overlapping_write");
        }
      }
    }
  }

  // Layer 2: contract-declared write/sequential scopes.
  for (const entry of ordered) {
    const claims = claimsForEntry(entry);
    const writePaths = new Set<string>();
    const sequentialPaths = new Set<string>();
    for (const claim of claims) {
      if (claim.kind === "write") writePaths.add(claim.path);
      else sequentialPaths.add(claim.path);
    }

    // Overlapping writes — any earlier entry that already claims any
    // of these paths (or a path that contains/contains them) is in
    // conflict.
    for (const writePath of writePaths) {
      for (const [claimedPath, owners] of claimsByPath.entries()) {
        if (pathsOverlap(claimedPath, writePath)) {
          for (const owner of owners) {
            if (owner !== entry.sequenceIndex) {
              recordConflict(writePath, [owner, entry.sequenceIndex], "overlapping_write");
            }
          }
        }
      }
    }

    // Sequential violations — entry's sequentialFiles that touch
    // an earlier entry's write scope out of order. We classify
    // these separately so audit consumers can distinguish "two
    // writers tried the same path" from "a sequential claim
    // collided with an earlier writer's path".
    for (const sequentialPath of sequentialPaths) {
      for (const [claimedPath, owners] of claimsByPath.entries()) {
        if (pathsOverlap(claimedPath, sequentialPath)) {
          for (const owner of owners) {
            if (owner !== entry.sequenceIndex) {
              recordConflict(sequentialPath, [owner, entry.sequenceIndex], "sequential_violation");
            }
          }
        }
      }
    }

    // Earlier sequential/write claims are already in `claimsByPath`.
    // Do not compare an entry's own sequential marker with its own
    // write scope; that marker means "serialize this file if another
    // entry also touches it", not "conflict with myself".

    // Commit this entry's claims before advancing.
    for (const claim of claims) recordClaim(claim.path, claim.ownerEntrySequenceIndex, claim.kind);
  }

  // Stable, sorted output. Sort by path then reason then indices.
  return [...conflicts.values()]
    .map((conflict) => ({
      path: conflict.path,
      conflictingEntrySequenceIndices: [...conflict.conflictingEntrySequenceIndices].sort((a, b) => a - b),
      reason: conflict.reason
    }))
    .sort((a, b) => {
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      if (a.reason !== b.reason) return a.reason.localeCompare(b.reason);
      return a.conflictingEntrySequenceIndices[0]! - b.conflictingEntrySequenceIndices[0]!;
    });
}

/**
 * Convenience helper: build an in-memory `PathOwnershipMap` from a
 * flat claim list. Useful for tests and for CLI adapters that load
 * filesystem claims into memory before invoking the orchestrator.
 */
export function createStaticPathOwnershipMap(
  claims: readonly PathOwnershipClaim[]
): PathOwnershipMap {
  const byPath = new Map<string, PathOwnershipClaim[]>();
  for (const claim of claims) {
    const bucket = byPath.get(claim.path) ?? [];
    bucket.push(claim);
    byPath.set(claim.path, bucket);
  }
  return {
    forPath(path: string) {
      return byPath.get(path) ?? [];
    }
  };
}
