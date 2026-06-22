/**
 * P09-T02 — Deterministic hashing for whole-change acceptance.
 *
 * Mirrors the P08 / P09 hash contract: every emitted event payload
 * and projection state is content-addressed so audit consumers can
 * prove "same orchestrator result ⇒ same events ⇒ same
 * projection".
 *
 * Hash inputs are JSON-canonicalized through a stable key sort so
 * the result is independent of property order in source objects.
 */

import { createHash } from "node:crypto";

import type {
  ChangeId,
  ContentHash,
  SchemaVersion,
  UtcTimestamp
} from "@legion/protocol";

import type {
  WholeChangeAcceptanceState,
  WholeChangeAggregatedPayload
} from "./contract.js";

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonical).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map(
        (key) =>
          JSON.stringify(key) +
          ":" +
          canonical((value as Record<string, unknown>)[key])
      )
      .join(",") +
    "}"
  );
}

function hexSha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function contentHash(input: string): ContentHash {
  const hex = hexSha256(input);
  if (hex.length !== 64 || !/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error("sha256 hex digest must be 64 lowercase hex characters");
  }
  return `sha256:${hex}` as unknown as ContentHash;
}

// ---------------------------------------------------------------------------
// Public utility — content hash from any frozen value
// ---------------------------------------------------------------------------

export function sha256OfCanonical(value: unknown): ContentHash {
  return contentHash(canonical(value));
}

// ---------------------------------------------------------------------------
// Aggregator hash — proves the (changeId, orchestrator result,
// acceptedBy, reason) tuple maps to a stable hash for idempotency
// ---------------------------------------------------------------------------

export interface WholeChangeAggregatorHashInput {
  readonly changeId: ChangeId;
  readonly mergeQueueHash: ContentHash;
  readonly decisionSha256: ContentHash;
  readonly outcome: string;
  readonly finalHeadRef: string;
  readonly acceptedBy: string;
  readonly reason: string;
  readonly workerContextHashes: readonly ContentHash[];
  readonly acceptedEntries: readonly number[];
  readonly rejectedEntries: readonly number[];
  readonly escalatedEntries: readonly number[];
  readonly conflictEntries: readonly number[];
  readonly acceptedAt: UtcTimestamp;
}

export function deriveWholeChangeAggregatorHash(
  input: WholeChangeAggregatorHashInput
): ContentHash {
  return contentHash(
    canonical({
      kind: "whole-change-aggregator",
      schemaVersion: WHOLE_CHANGE_HASH_VERSION,
      changeId: input.changeId,
      mergeQueueHash: input.mergeQueueHash,
      decisionSha256: input.decisionSha256,
      outcome: input.outcome,
      finalHeadRef: input.finalHeadRef,
      acceptedBy: input.acceptedBy,
      reason: input.reason,
      workerContextHashes: [...input.workerContextHashes].sort(),
      acceptedEntries: [...input.acceptedEntries].sort((a, b) => a - b),
      rejectedEntries: [...input.rejectedEntries].sort((a, b) => a - b),
      escalatedEntries: [...input.escalatedEntries].sort((a, b) => a - b),
      conflictEntries: [...input.conflictEntries].sort((a, b) => a - b),
      acceptedAt: input.acceptedAt
    })
  );
}

// ---------------------------------------------------------------------------
// Event payload hash — content-addressed hash over the emitted event
// payload so downstream reducers can detect re-emitted events with
// divergent content
// ---------------------------------------------------------------------------

export function deriveWholeChangeEventPayloadHash(
  payload: WholeChangeAggregatedPayload
): ContentHash {
  return contentHash(
    canonical({
      kind: "whole-change-event-payload",
      schemaVersion: WHOLE_CHANGE_HASH_VERSION,
      ...payload
    })
  );
}

// ---------------------------------------------------------------------------
// Projection state hash — content-addressed hash over the reduced
// whole-change acceptance state
// ---------------------------------------------------------------------------

export function deriveWholeChangeProjectionStateHash(
  state: WholeChangeAcceptanceState | null
): ContentHash {
  return contentHash(
    canonical({
      kind: "whole-change-projection-state",
      schemaVersion: WHOLE_CHANGE_HASH_VERSION,
      state
    })
  );
}

// ---------------------------------------------------------------------------
// Versioning — explicitly exported so consumers can audit the
// canonical-string contract without scraping the file
// ---------------------------------------------------------------------------

export const WHOLE_CHANGE_HASH_VERSION: SchemaVersion =
  "1.0.0" as SchemaVersion;