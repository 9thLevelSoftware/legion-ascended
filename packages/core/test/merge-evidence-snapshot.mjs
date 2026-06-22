#!/usr/bin/env node
// P09-T01 evidence dump.
//
// Produces the canonical serialized snapshot of the merge queue
// orchestrator at the Phase 9 cut line: three disjoint, accepted
// task runs sequenced through the integration gate with a
// deterministic identity rebase runner.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MergeQueueOrchestrator
} from "../dist/index.js";

import {
  makeIdentityRebaseRunner,
  makeSequencedEntries
} from "./merge-fixture.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const evidenceDir = join(here, "..", "..", "..", "docs", "next", "evidence", "P09-T01");
mkdirSync(evidenceDir, { recursive: true });

const { entries } = makeSequencedEntries({ baseRef: "main", count: 3 });
const orchestrator = new MergeQueueOrchestrator({
  now: () => "2026-06-22T03:00:00.000Z"
});

const result = await orchestrator.run({
  entries,
  rebaseRunner: makeIdentityRebaseRunner(),
  initialHeadRef: "main",
  now: () => "2026-06-22T03:00:00.000Z"
});

const snapshotPath = join(evidenceDir, "merge-queue-snapshot.json");
writeFileSync(snapshotPath, JSON.stringify(result, null, 2));
console.log(`wrote ${snapshotPath}`);
console.log(`outcome=${result.decision.outcome}`);
console.log(`mergeQueueHash=${result.mergeQueueHash}`);
console.log(`decisionSha256=${result.decision.decisionSha256}`);
