import type { EvidenceIndexEntry } from "@legion/artifacts";

/**
 * Selecting the evidence that actually describes a task's current state.
 *
 * Every build attempt writes a new evidence entry with a new ID, and the index
 * keeps them all — `replaceEvidenceEntry` only replaces an identical ID. So the
 * index is a history, not a snapshot, and any check that scans it indiscriminately
 * reads the wrong thing:
 *
 *  - Scanning for *any* failure makes a single failed attempt permanent. The
 *    operator is told to rerun, reruns successfully, and stays blocked forever.
 *  - Returning the *first* verdict found reads the oldest attempt, so an early
 *    pass masks a later failure — the exact inverse of what a gate is for.
 *
 * Both are fixed by deciding on the latest attempt per task and nothing else.
 */

/**
 * Attempt number for an evidence entry.
 *
 * Run and evidence IDs end in `-attempt-N`. Parsing the integer matters:
 * lexicographic ordering puts `attempt-10` before `attempt-2`, which would make
 * "latest" wrong exactly when a task has been retried enough to need it.
 */
export function attemptFromEvidence(entry: EvidenceIndexEntry): number {
  const candidates = [entry.evidence.runId, entry.evidence.id];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const match = /-attempt-(\d+)$/u.exec(candidate);
    if (match?.[1] !== undefined) return Number.parseInt(match[1], 10);
  }
  return 0;
}

/**
 * The newest entry per task ID.
 *
 * Entries without a task ID are skipped — they cannot be attributed to a task,
 * and callers that care about untagged evidence report it separately.
 */
export function latestEvidencePerTask(
  entries: readonly EvidenceIndexEntry[]
): ReadonlyMap<string, EvidenceIndexEntry> {
  const latest = new Map<string, EvidenceIndexEntry>();
  for (const entry of entries) {
    const taskId = entry.evidence.taskId;
    if (taskId === undefined) continue;
    const current = latest.get(taskId);
    if (current === undefined || attemptFromEvidence(entry) >= attemptFromEvidence(current)) {
      latest.set(taskId, entry);
    }
  }
  return latest;
}

/** The newest entry for each task, in stable task-ID order. */
export function latestEvidenceEntries(
  entries: readonly EvidenceIndexEntry[]
): readonly EvidenceIndexEntry[] {
  return [...latestEvidencePerTask(entries).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => entry);
}
