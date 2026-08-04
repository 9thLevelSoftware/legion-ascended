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

/**
 * A missing or malformed index reads as empty, matching `readLessonIndex`.
 * Planning must not fail because a retrospective file was hand-edited; broader
 * project corruption is `legion validate`'s report to make.
 */
export async function readRetroIndex(repositoryRoot: string): Promise<RetroIndex> {
  const indexPath = path.join(repositoryRoot, ...RETRO_INDEX_ARTIFACT_PATH.split("/"));
  try {
    const parsed = JSON.parse(await readFile(indexPath, "utf8")) as RetroIndex;
    if (parsed.kind === "retro_index" && Array.isArray(parsed.retrospectives)) return parsed;
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
): readonly (RetroAction & { readonly retroId: string; readonly artifactPath: string })[] {
  return [...index.retrospectives]
    .reverse()
    .flatMap((entry) =>
      entry.actions
        .filter((action) => action.severity !== "minor")
        .map((action) => ({ ...action, retroId: entry.id, artifactPath: entry.artifactPath }))
    )
    .slice(0, limit);
}
