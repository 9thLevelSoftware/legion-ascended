/**
 * P10-T01 — Deterministic hashing for release-observation board adapter.
 *
 * Mirrors the P09-T02 whole-change hash contract: every emitted
 * event payload and projection state is content-addressed so
 * audit consumers can prove "same orchestrator result ⇒ same
 * events ⇒ same projection".
 *
 * Hash inputs are JSON-canonicalized through a stable key sort
 * so the result is independent of property order in source
 * objects.
 */

import { createHash } from "node:crypto";

import type { ContentHash, SchemaVersion } from "@legion/protocol";

import type {
  ReleaseObservationEventPayload,
  ReleaseObservationProjectionState
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
          JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])
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
// Event payload hash — content-addressed hash over the emitted event
// payload so downstream reducers can detect re-emitted events with
// divergent content
// ---------------------------------------------------------------------------

export function deriveReleaseObservationEventPayloadHash(
  payload: ReleaseObservationEventPayload
): ContentHash {
  // The wire-level `schemaVersion` + `kind` ride on every
  // release-observation event. The content-addressed hash
  // discriminates by the release-observation-event-payload
  // tag and the hash version, then folds the rest of the
  // payload under sorted keys.
  const payloadRecord = payload as unknown as Record<string, unknown>;
  const {
    schemaVersion: _payloadSchemaVersion,
    kind: _payloadKind,
    ...rest
  } = payloadRecord;
  return contentHash(
    canonical({
      kind: "release-observation-event-payload",
      schemaVersion: RELEASE_OBSERVATION_ADAPTER_HASH_VERSION,
      ...rest
    })
  );
}

// ---------------------------------------------------------------------------
// Projection state hash — content-addressed hash over the reduced
// release-observation state
// ---------------------------------------------------------------------------

export function deriveReleaseObservationProjectionStateHash(
  state: ReleaseObservationProjectionState | null
): ContentHash {
  return contentHash(
    canonical({
      kind: "release-observation-projection-state",
      schemaVersion: RELEASE_OBSERVATION_ADAPTER_HASH_VERSION,
      state
    })
  );
}

// ---------------------------------------------------------------------------
// Versioning — explicitly exported so consumers can audit the
// canonical-string contract without scraping the file
// ---------------------------------------------------------------------------

export const RELEASE_OBSERVATION_ADAPTER_HASH_VERSION: SchemaVersion =
  "1.0.0" as SchemaVersion;
