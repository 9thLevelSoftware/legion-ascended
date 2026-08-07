import type { ProtocolMigration } from "./index.js";
import type { VersionedRecord } from "../versioning/index.js";

/**
 * Upcast from protocol 0.2.0 to 0.3.0 — the identity.
 *
 * 0.3.0 adds only optional fields and two new entity kinds, so there is nothing
 * to convert: a 0.2.0 record is a valid 0.3.0 record with a different number on
 * it. This migration writes `schemaVersion` and touches nothing else.
 *
 * **It looks decorative and is load-bearing.** `findProtocolMigrationPath` is a
 * breadth-first walk over registered edges, and `applyMigrations` targets
 * `registry.currentVersion`. With 0.3.0 current and no 0.2.0 -> 0.3.0 edge there
 * is no path from 0.1.0 to 0.3.0 *at all*: `applyMigrations` throws,
 * `upcastProtocolRecords` swallows it, the 0.1.0 document passes through
 * unmigrated, and `requirementSchema.parse` then rejects its prose criteria.
 * Bumping the current version without this hop would make every 0.1.0 document
 * on disk unreadable. `packages/protocol/test/migrations-0-3-0.test.mjs` asserts
 * the chain rather than the hop for that reason.
 *
 * `informationPreserving: true` is the machine-readable form of the identity
 * claim. It is not required on an upcast — the machinery demands it only of a
 * downcast — but it is true here, and declaring a true thing costs nothing.
 *
 * `appliesToKinds` repeats the 0.1.0 migration's two kinds and adds none, and
 * the reason is worth stating because the field is easy to misread as an
 * enforcement point. `migratableKinds()` is a *union* over every registered
 * migration, so `requirement` and `task-contract` are in the read-time walk
 * already; removing either from this list changes no behaviour and would redden
 * nothing. The falsifiable direction is widening, which is why the test suite
 * asserts that a 0.2.0 `review` — a kind this series touched — comes back
 * unchanged. Widening buys nothing here (entity schemas accept any semver, so a
 * 0.2.0 oracle already parses under 0.3.0) and costs a deep clone per record per
 * read plus more on-disk renumbering. Artifact envelopes (`taskgraph`,
 * `change-artifact-manifest`, evidence indexes) must never be claimed: ADR-010
 * records seventeen failing tests from a walk that rewrote them.
 */

const TARGET_VERSION = "0.3.0";

export const legionProtocol020To030: ProtocolMigration = {
  id: "legion.protocol.0-2-0.to.0-3-0",
  fromVersion: "0.2.0",
  toVersion: TARGET_VERSION,
  kind: "upcast",
  description:
    "Renumber 0.2.0 records to 0.3.0. 0.3.0 adds only optional fields and new entity kinds, so no value is added, removed or rewritten.",
  preserves: [
    "every field of every 0.2.0 record: this migration writes schemaVersion and nothing else"
  ],
  informationPreserving: true,
  appliesToKinds: ["requirement", "task-contract"],
  migrate(record: VersionedRecord): unknown {
    return { ...record, schemaVersion: TARGET_VERSION };
  }
};
