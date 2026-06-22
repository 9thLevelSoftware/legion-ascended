#!/usr/bin/env node
/**
 * P08-T01 evidence fixture: serialize a real WorkerContext to JSON
 * so the reviewer can verify the canonical shape without running
 * tests. Run from the repo root via:
 *
 *   node scripts/serialize-p08-worker-context.mjs
 *
 * The output is written to
 *   docs/next/evidence/P08-T01/worker-context.json
 *
 * It is the authoritative Phase 8 fresh-context shape: the
 * `WORKER_CONTEXT_KEYS` allowlist, the deep-freeze invariant, and
 * the deterministic `workerContextHash` / `isolationTag` values.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "docs", "next", "evidence", "P08-T01", "worker-context.json");

const core = await import(join(ROOT, "packages", "core", "dist", "index.js"));

const fixture = await import(
  join(ROOT, "packages", "core", "test", "dispatch-fixture.mjs")
);

const contract = fixture.makeFixtureContract();
const bundle = fixture.makeFixtureWorkerBundle();
const ready = fixture.makeFixtureReadyContext(contract);

const dispatcher = new core.FreshContextDispatcher({
  now: () => "2026-06-22T01:00:00.000Z"
});

const result = dispatcher.dispatch({
  taskContract: contract,
  bundleRegistry: core.createStaticWorkerBundleRegistry([bundle]),
  protocolVersion: "0.1.0",
  availableContracts: ready.availableContracts,
  availableAgents: ready.availableAgents,
  availableArtifacts: ready.availableArtifacts
});

if (!result.ok) {
  console.error("Dispatch did not produce a context:", JSON.stringify(result, null, 2));
  process.exit(1);
}

// WorkerContext is deeply frozen; JSON.parse(JSON.stringify(...))
// produces a stable JSON snapshot for the evidence bundle.
const serializable = JSON.parse(JSON.stringify(result.workerContext));

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(
  OUTPUT,
  JSON.stringify(
    {
      schemaVersion: serializable.schemaVersion,
      kind: serializable.kind,
      protocolVersion: serializable.protocolVersion,
      workerContextHash: serializable.workerContextHash,
      isolationTag: serializable.isolationTag,
      createdAt: serializable.createdAt,
      matchedAgentId: result.matchedAgentId,
      contextRefs: serializable.contextRefs,
      scope: serializable.scope,
      workerBundle: serializable.workerBundle,
      model: serializable.model,
      taskContract: {
        id: serializable.taskContract.id,
        revision: serializable.taskContract.revision,
        title: serializable.taskContract.title,
        wave: serializable.taskContract.wave,
        agents: serializable.taskContract.agents
      }
    },
    null,
    2
  ) + "\n",
  "utf8"
);

console.log(`Wrote ${OUTPUT}`);
