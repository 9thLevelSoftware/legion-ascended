/**
 * Finding the brainstorm an intake session can be seeded from.
 *
 * `legion explore` has written a typed `exploration.json` since Phase C0, and
 * until now nothing read it — the same shape as the v8 bug it was meant to fix,
 * where exploration produced eleven sections and initialization consumed six.
 * This module is the read side.
 *
 * It never treats an exploration as authoritative. The caller gets proposals
 * and open questions; what it does with them is constrained by `createSession`,
 * which turns proposals into suggestions and open questions into extra required
 * nodes.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { explorationSchema, type Exploration } from "@legion/protocol";

import { latestGuidanceRuns, type GuidanceRunDocument } from "../guidance-run.js";

/**
 * An exploration on disk, addressable by either of the two IDs it carries.
 *
 * A guidance run and the exploration entity it produced have *different* IDs:
 * the run is named by its directory, the entity by `formatEntityId("run", ...)`
 * derived from it. `--from-exploration` is given the run ID a human can see,
 * while `intakeSessionSchema` stores the entity ID because its `runId` field is
 * branded. Matching only one of them meant a seeded session could never reload
 * the exploration it named, and every proposal silently disappeared on the
 * second invocation.
 */
export interface ExplorationCandidate {
  /** The guidance run directory name, as `--from-exploration` accepts it. */
  readonly runId: string;
  /** The exploration entity's own `run_*` ID, as a session records it. */
  readonly explorationRunId: string;
  readonly artifactPath: string;
  readonly createdAt: string;
  readonly topic: string;
}

function explorationArtifactPathOf(run: GuidanceRunDocument): string | undefined {
  const value = run.outputs["explorationArtifactPath"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function readExplorationRunId(
  repositoryRoot: string,
  artifactPath: string
): Promise<string | undefined> {
  try {
    const raw = await readFile(path.join(repositoryRoot, ...artifactPath.split("/")), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const runId = (parsed as { runId?: unknown }).runId;
    return typeof runId === "string" ? runId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Explorations on disk that carry a typed artifact, newest first.
 *
 * Each artifact is opened to read its entity ID rather than re-deriving it from
 * the run ID. Re-deriving would duplicate the naming rule in a second place,
 * and the two would drift the moment either changed.
 */
export async function listExplorations(
  repositoryRoot: string,
  limitPerWorkflow: number = DISCOVERY_LIMIT
): Promise<readonly ExplorationCandidate[]> {
  const runs = await latestGuidanceRuns({
    repositoryRoot,
    workflows: ["explore"],
    // A number, always. Omitting the option is not "no limit" —
    // `latestGuidanceRuns` defaults to three, tighter than the discovery cap
    // rather than looser — and passing `undefined` to a defaulted parameter
    // silently restores the default it was meant to override.
    limitPerWorkflow
  });

  // Read in parallel. These are independent files and the list is walked on
  // every `legion start` invocation against a seeded session, so serializing
  // them put a round of disk latency per exploration in front of every single
  // question.
  const withArtifacts = runs.flatMap((run) => {
    const artifactPath = explorationArtifactPathOf(run);
    return artifactPath === undefined ? [] : [{ run, artifactPath }];
  });

  return Promise.all(
    withArtifacts.map(async ({ run, artifactPath }) => {
      const topic = run.input["topic"];
      return {
        runId: run.runId,
        explorationRunId: (await readExplorationRunId(repositoryRoot, artifactPath)) ?? run.runId,
        artifactPath,
        createdAt: run.createdAt,
        topic: typeof topic === "string" ? topic : "exploration"
      };
    })
  );
}

/**
 * How many explorations the *discovery* list offers.
 *
 * A cap belongs on the list a human reads. It does not belong on resolution: a
 * session pins one exploration by ID, and ten newer runs must not make its
 * proposals disappear. `loadExploration` therefore searches without the cap,
 * which also lets `--from-exploration` name an older run.
 */
export const DISCOVERY_LIMIT = 10;

/** Ask for every exploration on disk, however many there are. */
export const ALL_EXPLORATIONS = Number.MAX_SAFE_INTEGER;

export interface LoadedExploration {
  readonly exploration: Exploration;
  readonly artifact: { readonly path: string; readonly sha256: string };
  readonly candidate: ExplorationCandidate;
}

export type LoadExplorationResult =
  | { readonly ok: true; readonly loaded: LoadedExploration }
  | { readonly ok: false; readonly reason: string };

/**
 * Load one exploration by guidance run ID.
 *
 * The artifact is hashed as read so the session records which bytes it was
 * seeded from. Without that, "this answer came from exploration X" is a claim
 * about a file that may since have changed.
 */
export async function loadExploration(
  repositoryRoot: string,
  runId: string
): Promise<LoadExplorationResult> {
  // Unbounded on purpose: see DISCOVERY_LIMIT. A pinned exploration must stay
  // resolvable however many newer runs exist.
  const candidates = await listExplorations(repositoryRoot, ALL_EXPLORATIONS);
  // Either ID resolves: the run ID a human types, or the entity ID a session
  // recorded.
  const candidate = candidates.find(
    (entry) => entry.runId === runId || entry.explorationRunId === runId
  );
  if (candidate === undefined) {
    const known = candidates.map((entry) => entry.runId).join(", ");
    return {
      ok: false,
      reason:
        known.length > 0
          ? `No exploration ${runId}. Available: ${known}.`
          : `No exploration ${runId}. Run legion explore first.`
    };
  }

  let raw: string;
  try {
    raw = await readFile(path.join(repositoryRoot, ...candidate.artifactPath.split("/")), "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `Exploration ${runId} could not be read: ${message}` };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `Exploration ${runId} is not valid JSON: ${message}` };
  }

  const parsed = explorationSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Exploration ${runId} does not match the protocol: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`
    };
  }

  return {
    ok: true,
    loaded: {
      exploration: parsed.data,
      artifact: {
        path: candidate.artifactPath,
        sha256: `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`
      },
      candidate
    }
  };
}
