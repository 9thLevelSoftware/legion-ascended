#!/usr/bin/env node
/**
 * P08-T02 evidence fixture: serialize a real per-task review
 * pipeline result to JSON so the reviewer can verify the canonical
 * shape without running the test suite. Run from the repo root via:
 *
 *   node scripts/serialize-p08-t02-review.mjs
 *
 * The output is written to
 *   docs/next/evidence/P08-T02/review-pipeline-result.json
 *
 * It is the authoritative Phase 8 per-task-review shape: the
 * `REVIEW_PIPELINE_KEYS` allowlist, the deep-freeze invariant, the
 * deterministic `reviewPipelineHash` value, the verification report,
 * the independent review record, and the acceptance decision.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "docs", "next", "evidence", "P08-T02", "review-pipeline-result.json");

const core = await import(join(ROOT, "packages", "core", "dist", "index.js"));

const fixture = await import(
  join(ROOT, "packages", "core", "test", "review-fixture.mjs")
);

const dispatchFixture = await import(
  join(ROOT, "packages", "core", "test", "dispatch-fixture.mjs")
);

const contract = dispatchFixture.makeFixtureContract({
  risk: { tier: "R2", reasons: ["multi-module", "user-facing-path"] }
});
const bundle = dispatchFixture.makeFixtureWorkerBundle();
const ready = dispatchFixture.makeFixtureReadyContext(contract);

const dispatcher = new core.FreshContextDispatcher({
  now: () => "2026-06-22T02:00:00.000Z"
});

const dispatch = dispatcher.dispatch({
  taskContract: contract,
  bundleRegistry: core.createStaticWorkerBundleRegistry([bundle]),
  protocolVersion: "0.1.0",
  ...ready
});

if (!dispatch.ok) {
  console.error("Dispatch did not produce a worker context:", JSON.stringify(dispatch, null, 2));
  process.exit(1);
}

const review = fixture.makeReviewerInput({
  findings: [
    {
      id: "fnd_p08-t02_minor",
      title: "minor coverage gap",
      body: "Coverage report shows one branch under-tested in the gate evaluator.",
      severity: "minor",
      evidenceRefs: ["ev_p08-t02_coverage"]
    }
  ],
  summary: "Independent review: passing R2 task with one minor coverage finding."
});

const pipeline = new core.PerTaskReviewPipeline({
  now: () => "2026-06-22T02:30:00.000Z"
});

const result = await pipeline.run({
  taskContract: contract,
  workerContext: dispatch.workerContext,
  implementer: fixture.makeImplementer(),
  runner: fixture.makePassingRunner(),
  review
});

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, JSON.stringify(result, null, 2) + "\n", "utf8");

console.log(
  `serialized per-task review pipeline result: ` +
    `outcome=${result.decision.outcome} ` +
    `tier=${result.decision.tier} ` +
    `pipelineHash=${result.reviewPipelineHash}`
);