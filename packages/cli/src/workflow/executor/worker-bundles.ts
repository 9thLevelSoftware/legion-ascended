import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { WorkerBundleRegistry, WorkerBundleRegistryEntry } from "@legion/core";
import { workerBundleManifestSchema, type ModelManifest, type WorkerBundle } from "@legion/protocol";

import { resolveCliSourceRoot } from "../../source-root.js";

/**
 * Worker bundle registry backed by `bundles/index.json`.
 *
 * The v9 contract says a worker prompt is content-addressed: the bundle
 * declares `promptContentContract.instructionsHash`, and a dispatcher must
 * refuse to run when the prompt on disk does not hash to it. That gate has been
 * specified since P04 and never enforced at runtime, because nothing loaded the
 * bundles. This module is where it starts being enforced.
 */

const BUNDLE_DIRECTORY = "bundles";
const BUNDLE_INDEX = "bundles/index.json";

export class WorkerBundleIntegrityError extends Error {
  readonly bundleId: string;

  constructor(bundleId: string, message: string) {
    super(message);
    this.name = "WorkerBundleIntegrityError";
    this.bundleId = bundleId;
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

interface RawBundleEntry {
  readonly id?: unknown;
  readonly promptFile?: unknown;
  readonly promptContentContract?: { readonly instructionsHash?: unknown };
}

/**
 * Read every bundle manifest and verify its prompt against the declared hash.
 *
 * `workerBundleManifestSchema` is a strict object, so the authoring-only fields
 * (`domainPacks`, `promptFile`) are projected away rather than passed through.
 */
export function loadWorkerBundles(sourceRoot?: string): ReadonlyMap<string, WorkerBundle> {
  const root = sourceRoot ?? resolveCliSourceRoot(import.meta.url, BUNDLE_INDEX);
  const indexPath = path.join(root, ...BUNDLE_INDEX.split("/"));

  let parsed: { readonly bundles?: readonly RawBundleEntry[] };
  try {
    parsed = JSON.parse(readFileSync(indexPath, "utf8")) as { readonly bundles?: readonly RawBundleEntry[] };
  } catch (error) {
    throw new WorkerBundleIntegrityError(
      "index",
      `Worker bundle index could not be read at ${BUNDLE_INDEX}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const bundles = new Map<string, WorkerBundle>();
  for (const entry of parsed.bundles ?? []) {
    const manifest = workerBundleManifestSchema.parse({
      id: entry.id,
      version: (entry as { version?: unknown }).version,
      role: (entry as { role?: unknown }).role,
      domain: (entry as { domain?: unknown }).domain,
      capabilities: (entry as { capabilities?: unknown }).capabilities,
      promptContentContract: entry.promptContentContract
    });

    // The content-addressing gate. A prompt that has drifted from its declared
    // hash means the worker would run instructions nobody approved.
    //
    // A manifest that declares `instructionsHash` but names no prompt file is
    // rejected rather than skipped: otherwise omitting `promptFile` is a way to
    // claim a content-addressable contract while supplying nothing to address,
    // and the gate becomes opt-out.
    if (typeof entry.promptFile !== "string") {
      throw new WorkerBundleIntegrityError(
        manifest.id,
        `Worker bundle ${manifest.id} declares promptContentContract.instructionsHash but names no promptFile, so its prompt cannot be content-addressed. Refusing to dispatch.`
      );
    }

    {
      const promptPath = path.join(root, BUNDLE_DIRECTORY, entry.promptFile);
      let promptBody: string;
      try {
        promptBody = readFileSync(promptPath, "utf8");
      } catch (error) {
        throw new WorkerBundleIntegrityError(
          manifest.id,
          `Worker bundle ${manifest.id} declares prompt ${entry.promptFile}, which could not be read: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      const actual = `sha256:${sha256Hex(promptBody)}`;
      if (actual !== manifest.promptContentContract.instructionsHash) {
        throw new WorkerBundleIntegrityError(
          manifest.id,
          `Worker bundle ${manifest.id} prompt hash mismatch: ${entry.promptFile} hashes to ${actual}, but the manifest declares ${manifest.promptContentContract.instructionsHash}. Refusing to dispatch.`
        );
      }
    }

    bundles.set(manifest.id, manifest);
  }

  return bundles;
}

export interface CreateWorkerBundleRegistryOptions {
  /**
   * The model actually executing the work.
   *
   * Bundles describe a role, not a model, so the manifest is supplied by the
   * caller from the selected executor — the same convention the task-run
   * document already uses.
   */
  readonly model: ModelManifest;
  readonly sourceRoot?: string;
}

/**
 * Build a `WorkerBundleRegistry` keyed by bundle ID.
 *
 * Task contracts name their agent by bundle ID, so lookup is direct. An agent
 * with no bundle returns no entries, and the dispatcher turns that into a
 * `resource_unavailable` issue rather than running unbundled.
 */
export function createWorkerBundleRegistry(
  options: CreateWorkerBundleRegistryOptions
): WorkerBundleRegistry {
  const bundles = loadWorkerBundles(options.sourceRoot);
  return {
    forAgent(agentId: string): readonly WorkerBundleRegistryEntry[] {
      const bundle = bundles.get(agentId);
      if (bundle === undefined) return [];
      return [{ agentId, bundle, model: options.model }];
    }
  };
}
