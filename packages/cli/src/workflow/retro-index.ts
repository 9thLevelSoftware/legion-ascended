import { readFile } from "node:fs/promises";
import path from "node:path";

import { artifactPathSchema, type ArtifactPath } from "@legion/protocol";

/**
 * The retrospective-to-plan loop.
 *
 * `legion retro` wrote its findings inside its own run directory and nothing
 * read them, so the loop the retrospective exists to close was open: lessons
 * were recorded where the next planning pass would never look.
 *
 * This index is the read surface. It follows `knowledge-index.json`'s
 * convention — a committed JSON file under `.legion/project/workflow/`, appended
 * to on each run — because a second convention for the same job is a second
 * thing to keep consistent.
 *
 * `legion plan` reads it and reports the outstanding actions in its payload.
 * Plan is deterministic and runs no executor, so it cannot act on them itself;
 * surfacing them where the caller decomposing the phase will see them is the
 * honest version of "planning consumes retrospectives".
 */

export const RETRO_INDEX_ARTIFACT_PATH = ".legion/project/workflow/retro/retro-index.json";

export interface RetroAction {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly severity: "minor" | "major" | "blocking";
}

export interface RetroIndexEntry {
  readonly id: string;
  readonly createdAt: string;
  /** The change a scoped retrospective covered; absent when it was unscoped. */
  readonly scopedChangeId?: string;
  readonly artifactPath: string;
  readonly summary: string;
  readonly actions: readonly RetroAction[];
}

export interface RetroIndex {
  readonly schemaVersion: 1;
  readonly kind: "retro_index";
  readonly retrospectives: readonly RetroIndexEntry[];
}

const EMPTY_INDEX: RetroIndex = Object.freeze({
  schemaVersion: 1,
  kind: "retro_index",
  retrospectives: []
});

export function retroIndexArtifactPath(): ArtifactPath {
  return artifactPathSchema.parse(RETRO_INDEX_ARTIFACT_PATH);
}

const SEVERITIES = new Set(["minor", "major", "blocking"]);

function isRetroAction(value: unknown): value is RetroAction {
  if (typeof value !== "object" || value === null) return false;
  const action = value as Record<string, unknown>;
  return (
    typeof action["id"] === "string" &&
    typeof action["title"] === "string" &&
    typeof action["body"] === "string" &&
    typeof action["severity"] === "string" &&
    SEVERITIES.has(action["severity"] as string)
  );
}

function isRetroIndexEntry(value: unknown): value is RetroIndexEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["id"] === "string" &&
    typeof entry["createdAt"] === "string" &&
    typeof entry["artifactPath"] === "string" &&
    typeof entry["summary"] === "string" &&
    (entry["scopedChangeId"] === undefined || typeof entry["scopedChangeId"] === "string") &&
    Array.isArray(entry["actions"]) &&
    entry["actions"].every(isRetroAction)
  );
}

/**
 * A missing or malformed index reads as empty, matching `readLessonIndex`.
 * Planning must not fail because a retrospective file was hand-edited; broader
 * project corruption is `legion validate`'s report to make.
 *
 * Every entry is shape-checked, not just the envelope. `{"kind":"retro_index",
 * "retrospectives":[{}]}` is valid JSON with the right two keys, and a
 * top-level-only check accepted it — then planning and recall both dereferenced
 * `entry.actions` and threw, which is the crash the empty fallback promises not
 * to be.
 *
 * Malformed entries are dropped individually rather than voiding the file. One
 * hand-mangled entry should not erase every retrospective recorded beside it.
 */
export async function readRetroIndex(repositoryRoot: string): Promise<RetroIndex> {
  const indexPath = path.join(repositoryRoot, ...RETRO_INDEX_ARTIFACT_PATH.split("/"));
  try {
    const parsed: unknown = JSON.parse(await readFile(indexPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return EMPTY_INDEX;
    const candidate = parsed as Record<string, unknown>;
    if (candidate["kind"] !== "retro_index" || !Array.isArray(candidate["retrospectives"])) return EMPTY_INDEX;
    return {
      schemaVersion: 1,
      kind: "retro_index",
      retrospectives: candidate["retrospectives"].filter(isRetroIndexEntry)
    };
  } catch {
    // Fall through to the empty index.
  }
  return EMPTY_INDEX;
}

export function appendRetroEntry(index: RetroIndex, entry: RetroIndexEntry): RetroIndex {
  return { ...index, retrospectives: [...index.retrospectives, entry] };
}

/**
 * The actions a planner should see, newest retrospective first.
 *
 * Only `major` and `blocking` findings qualify. A retrospective that recorded
 * twelve minor observations would otherwise bury the two that change how the
 * next phase is decomposed, and an unranked list is one nobody reads.
 */
export function outstandingRetroActions(
  index: RetroIndex,
  limit = 5
): readonly (RetroAction & {
  readonly retroId: string;
  readonly artifactPath: string;
  readonly scopedChangeId?: string;
})[] {
  return [...index.retrospectives]
    .reverse()
    .flatMap((entry) =>
      entry.actions
        .filter((action) => action.severity !== "minor")
        .map((action) => ({
          ...action,
          retroId: entry.id,
          artifactPath: entry.artifactPath,
          // Carried through so a reader can tell an action drawn from one
          // phase's retrospective from one drawn across the whole project.
          // Without it the field was written and never read.
          ...(entry["scopedChangeId"] === undefined ? {} : { scopedChangeId: entry["scopedChangeId"] })
        }))
    )
    .slice(0, limit);
}
