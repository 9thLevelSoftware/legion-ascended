/**
 * Driver fallback policy for Legion Next (ADR-004).
 *
 * Precedence (when no explicit `preferredDriver` is set):
 *   1. `runtime-eve`        — Vercel Eve adapter (this package).
 *      Selected when the pinned Eve peer dependency is installed.
 *   2. `runtime-local`      — deterministic in-memory driver.
 *      Used for unit tests, local development, and environments
 *      where Eve is unavailable. Always available; the canonical
 *      last-resort sink.
 *   3. `runtime-legacy-cli` — transitional compatibility path
 *      with reduced guarantees. Used only when the board is
 *      pinned to a v8-style workflow.
 *
 * Rationale: ADR-004 says `runtime-eve` is the "first external
 * durable runtime candidate after Phase 5 validates live public
 * contracts". Phase 5 (this card) certifies the public
 * contract, so the production default is now `runtime-eve`
 * when available; `runtime-local` becomes the deterministic
 * fallback. The selector returns the first driver whose
 * `isAvailable()` predicate is true and respects an explicit
 * `preferredDriver` override.
 */

import { RUNTIME_EVE_PINNED_VERSION, type EveTransport } from "../transport/contract.js";

export type DriverId = "runtime-local" | "runtime-eve" | "runtime-legacy-cli";

export interface DriverSelectorOptions {
  readonly preferredDriver?: DriverId;
  readonly isEveInstalled: boolean;
  readonly isLegacyCliAvailable: boolean;
  readonly isLocalAvailable: boolean;
}

export interface DriverSelection {
  readonly driver: DriverId;
  readonly pinnedEveVersion: typeof RUNTIME_EVE_PINNED_VERSION | null;
  readonly reason: string;
}

const PRECEDENCE: readonly DriverId[] = ["runtime-eve", "runtime-local", "runtime-legacy-cli"] as const;

export function selectDriver(options: DriverSelectorOptions): DriverSelection {
  if (options.preferredDriver) {
    return resolvePreferred(options.preferredDriver, options);
  }
  for (const driver of PRECEDENCE) {
    const selection = checkAvailability(driver, options);
    if (selection) return selection;
  }
  return {
    driver: "runtime-local",
    pinnedEveVersion: null,
    reason: "no driver is available; falling back to runtime-local as a last-resort sink"
  };
}

function resolvePreferred(preferred: DriverId, options: DriverSelectorOptions): DriverSelection {
  const selection = checkAvailability(preferred, options);
  if (selection) return selection;
  for (const driver of PRECEDENCE) {
    if (driver === preferred) continue;
    const fallback = checkAvailability(driver, options);
    if (fallback) {
      return {
        ...fallback,
        reason: `preferred driver ${preferred} is unavailable; ${fallback.reason}`
      };
    }
  }
  return {
    driver: "runtime-local",
    pinnedEveVersion: null,
    reason: `preferred driver ${preferred} is unavailable and no configured fallback driver is available; falling back to runtime-local as a last-resort sink`
  };
}

function checkAvailability(driver: DriverId, options: DriverSelectorOptions): DriverSelection | null {
  switch (driver) {
    case "runtime-local":
      if (!options.isLocalAvailable) return null;
      return {
        driver: "runtime-local",
        pinnedEveVersion: null,
        reason: "runtime-local is always available and is the canonical default for tests and development"
      };
    case "runtime-eve":
      if (!options.isEveInstalled) return null;
      return {
        driver: "runtime-eve",
        pinnedEveVersion: RUNTIME_EVE_PINNED_VERSION,
        reason: `runtime-eve is selected because the pinned eve@${RUNTIME_EVE_PINNED_VERSION} peer dependency is installed`
      };
    case "runtime-legacy-cli":
      if (!options.isLegacyCliAvailable) return null;
      return {
        driver: "runtime-legacy-cli",
        pinnedEveVersion: null,
        reason: "runtime-legacy-cli is selected because the workspace is pinned to a v8-style workflow"
      };
  }
}

/**
 * Helper used by tests / ops code to assert that a given Eve
 * transport is the pinned version before binding the driver to
 * the board. Returns `null` when the transport is a real Eve
 * transport at the pinned version, and a structured reason
 * otherwise.
 */
export function checkEveTransportVersion(transport: EveTransport): string | null {
  if (transport.pinnedEveVersion === RUNTIME_EVE_PINNED_VERSION) return null;
  return `transport pinned ${transport.pinnedEveVersion} does not match canonical ${RUNTIME_EVE_PINNED_VERSION}`;
}
