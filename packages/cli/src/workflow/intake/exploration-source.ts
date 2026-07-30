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

export interface ExplorationCandidate {
  readonly runId: string;
  readonly artifactPath: string;
  readonly createdAt: string;
  readonly topic: string;
}

function explorationArtifactPathOf(run: GuidanceRunDocument): string | undefined {
  const value = run.outputs["explorationArtifactPath"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Explorations on disk that carry a typed artifact, newest first. */
export async function listExplorations(
  repositoryRoot: string
): Promise<readonly ExplorationCandidate[]> {
  const runs = await latestGuidanceRuns({
    repositoryRoot,
    workflows: ["explore"],
    // Deep enough to find a brainstorm from a few days ago, shallow enough that
    // "recent explorations" stays a list a human can read.
    limitPerWorkflow: 10
  });

  const candidates: ExplorationCandidate[] = [];
  for (const run of runs) {
    const artifactPath = explorationArtifactPathOf(run);
    if (artifactPath === undefined) continue;
    const topic = run.input["topic"];
    candidates.push({
      runId: run.runId,
      artifactPath,
      createdAt: run.createdAt,
      topic: typeof topic === "string" ? topic : "exploration"
    });
  }
  return candidates;
}

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
  const candidates = await listExplorations(repositoryRoot);
  const candidate = candidates.find((entry) => entry.runId === runId);
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
