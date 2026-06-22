/**
 * ADR-004 fallback driver selector.
 *
 * Purpose:
 *  - Resolve the canonical `runtime-eve → runtime-local →
 *    runtime-legacy-cli` precedence into a single RuntimeDriver
 *    implementation the board can bind to. The precedence is the
 *    ADR-004 default after P05-T02 certifies Eve; the selector
 *    exposes it as data so:
 *      * a config layer can override the order,
 *      * an availability layer can disable individual candidates,
 *      * an audit trail can record WHY the selector picked the
 *        driver it picked.
 *  - Provide a typed `RuntimeDriverSelectionFailure` for the case
 *    where every candidate is unavailable. The failure lists every
 *    candidate with its unavailable reason so a board operator can
 *    understand the cascade without reading code paths.
 *  - Be deterministic and side-effect free. The selector never
 *    starts a driver itself; it only resolves candidates and
 *    surfaces a decision object the caller (state machine, evidence
 *    indexer, etc.) acts on.
 *
 * Why this is its own module:
 *  - The contract (`./contract.ts`) is the WHAT — the seven-method
 *    surface every driver satisfies.
 *  - The driver implementations (`./local-driver.ts`,
 *    `./legacy-cli-driver.ts`, the future `./eve-driver.ts`) are the
 *    HOW — each driver implements WHAT.
 *  - The selector is the WHICH — given an environment and a policy,
 *    which HOW to bind to WHAT for a given task. Keeping it separate
 *    means the drivers stay focused on a single responsibility and
 *    the precedence rules are documented in one place.
 *
 * Driver order rationale (ADR-004):
 *  - `runtime-eve` is the first preference now that P05-T02 has
 *    certified the Eve adapter against the public contract.
 *  - `runtime-local` is the second preference because it is
 *    deterministic and provider-free; tests, replay, and the
 *    fallback path depend on it.
 *  - `runtime-legacy-cli` is the LAST preference because it carries
 *    reduced guarantees (placeholder checkpoint fingerprint, single
 *    terminal event shape, reference-only artifact preservation).
 *    Selecting it surfaces a `level: "reduced"` decision so audit
 *    logs can flag the run as legacy-compat.
 *
 * Override behaviour:
 *  - `policy.requestedDriver` forces the selector to choose that
 *    driver if it is registered and available. This supports:
 *      * forced-local in test suites,
 *      * forced-legacy during a Phase 6 Eve rollout rollback,
 *      * forced-eve once P05-T02 certifies the Eve adapter.
 *  - A forced-but-unavailable driver surfaces a structured failure
 *    rather than silently falling through to a different driver;
 *    silently downgrading would mask operator intent.
 *
 * The selector is part of `@legion/core` and depends on
 * `@legion/protocol` only — same import boundary as the rest of the
 * runtime module. Tests in
 * `packages/core/test/runtime-selector.test.mjs` pin every branch
 * of the selection logic.
 */

import type { RuntimeDriver, RuntimeDriverId } from "./contract.js";

import {
  RUNTIME_LEGACY_CLI_DRIVER_ID,
  RUNTIME_LEGACY_CLI_GUARANTEES,
  type RuntimeLegacyCliDriver,
  type RuntimeLegacyCliGuarantees,
  type RuntimeLegacyCliGuaranteeLevel
} from "./legacy-cli-driver.js";
import {
  RUNTIME_LOCAL_DRIVER_ID,
  type RuntimeLocalDriver
} from "./local-driver.js";

/**
 * The well-known driver ids the selector recognises. The order here
 * is the documented ADR-004 default precedence (eve → local →
 * legacy-cli). The selector is type-safe against this tuple so a
 * future driver can be added in exactly one place.
 */
export const RUNTIME_DRIVER_PRECEDENCE = [
  "runtime-eve" as const,
  RUNTIME_LOCAL_DRIVER_ID,
  RUNTIME_LEGACY_CLI_DRIVER_ID
] as const;

export type RuntimeDriverPrecedenceId = (typeof RUNTIME_DRIVER_PRECEDENCE)[number];

/**
 * Reason the selector picked a driver (or skipped it). Codes are
 * stable contracts; downstream audit code pattern-matches on the
 * code field, not on the message.
 */
export type RuntimeDriverSelectionReasonCode =
  | "precedence_match"
  | "precedence_default"
  | "precedence_override"
  | "precedence_unavailable";

export interface RuntimeDriverSelectionReason {
  readonly driver: RuntimeDriverPrecedenceId;
  readonly code: RuntimeDriverSelectionReasonCode;
  readonly detail?: string;
}

/**
 * A driver candidate the selector considered. `available` is the
 * driver-supplied availability check result; `guaranteeLevel` is
 * the documented guarantee level for the candidate (drivers may
 * advertise `full` or `reduced`; the selector preserves it).
 */
export interface RuntimeDriverCandidate {
  readonly driverId: RuntimeDriverPrecedenceId;
  readonly driver: RuntimeDriver;
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly guaranteeLevel: RuntimeLegacyCliGuaranteeLevel;
}

/**
 * The selector's decision. `driver` is the chosen implementation;
 * `considered` is the full set of candidates consulted (in
 * precedence order), with the reason each was picked or skipped.
 * `requestedDriver` records whether the policy forced a choice;
 * `forced` is true when the requested driver was honoured.
 */
export interface RuntimeDriverSelection {
  readonly driver: RuntimeDriver;
  readonly driverId: RuntimeDriverPrecedenceId;
  readonly guaranteeLevel: RuntimeLegacyCliGuaranteeLevel;
  readonly forced: boolean;
  readonly requestedDriver: RuntimeDriverPrecedenceId | null;
  readonly considered: readonly RuntimeDriverCandidate[];
  readonly reasons: readonly RuntimeDriverSelectionReason[];
}

/**
 * Typed failure raised when the selector cannot choose any driver.
 * The `considered` field enumerates every candidate and the reason
 * each was unavailable, so the board can surface a clear message
 * ("runtime-local: env flag LEGION_DISABLE_LOCAL; runtime-eve: not
 * registered; runtime-legacy-cli: env flag LEGION_DISABLE_LEGACY")
 * instead of a generic "no driver".
 */
export interface RuntimeDriverSelectionFailure {
  readonly ok: false;
  readonly requestedDriver: RuntimeDriverPrecedenceId | null;
  readonly considered: readonly RuntimeDriverCandidate[];
  readonly reasons: readonly RuntimeDriverSelectionReason[];
  readonly message: string;
}

/**
 * Selector input. `candidates` is a map of well-known driver id to
 * the registered driver instance; `availability` is a map of driver
 * id to a synchronous availability check (env flag, process probe,
 * etc.); `requestedDriver` is the optional forced choice.
 *
 * The selector never imports host CLI / Eve / sqlite packages — it
 * only references the driver instances the caller registers. The
 * import-boundary scan therefore permits this file as long as the
 * driver implementations themselves stay clean (which
 * `scan-runtime-import-boundaries.mjs` enforces separately).
 */
export interface RuntimeDriverSelectorInput {
  readonly candidates: Partial<Record<RuntimeDriverPrecedenceId, RuntimeDriver>>;
  readonly availability?: Partial<Record<RuntimeDriverPrecedenceId, { available: boolean; reason?: string }>>;
  readonly requestedDriver?: RuntimeDriverPrecedenceId;
}

/**
 * Union result of `selectRuntimeDriver`. Successful selections
 * return a `RuntimeDriverSelection`; failed selections return a
 * `RuntimeDriverSelectionFailure`. Callers must narrow on the
 * `ok` field (when added to the failure variant) or use the
 * `isRuntimeDriverSelectionFailure` helper.
 */
export type RuntimeDriverSelectionResult =
  | { readonly ok: true; readonly selection: RuntimeDriverSelection }
  | RuntimeDriverSelectionFailure;

/**
 * Helper for downstream code that wants a runtime check rather than
 * the type-narrowed `ok` flag.
 */
export function isRuntimeDriverSelectionFailure(
  result: RuntimeDriverSelectionResult
): result is RuntimeDriverSelectionFailure {
  return result.ok === false;
}

/**
 * Resolve the guarantee level advertised by a registered driver.
 *  - `runtime-local` is always `full`.
 *  - `runtime-legacy-cli` exposes `RUNTIME_LEGACY_CLI_GUARANTEES.level`
 *    so the constant is the single source of truth.
 *  - `runtime-eve` is treated as `full` because ADR-004 explicitly
 *    promises durable sessions, subagents, and step checkpoints.
 *  - An unknown driver (registered manually) defaults to `full`
 *    because the selector cannot prove it is reduced.
 */
function guaranteeLevelFor(
  driverId: RuntimeDriverPrecedenceId,
  driver: RuntimeDriver | undefined
): RuntimeLegacyCliGuaranteeLevel {
  if (driverId === RUNTIME_LEGACY_CLI_DRIVER_ID) {
    if (driver && typeof (driver as Partial<RuntimeLegacyCliDriver>).guarantees === "function") {
      const guarantees = (driver as RuntimeLegacyCliDriver).guarantees() as RuntimeLegacyCliGuarantees;
      return guarantees.level;
    }
    return RUNTIME_LEGACY_CLI_GUARANTEES.level;
  }
  return "full";
}

function unavailableReasonFor(
  driverId: RuntimeDriverPrecedenceId,
  input: RuntimeDriverSelectorInput
): string | undefined {
  const explicit = input.availability?.[driverId];
  if (explicit && explicit.available === false) {
    return explicit.reason ?? `${driverId} marked unavailable`;
  }
  if (!input.candidates[driverId]) {
    return `${driverId} not registered`;
  }
  return undefined;
}

/**
 * The selector. Deterministic, side-effect free, and total: every
 * input produces either a `RuntimeDriverSelection` or a
 * `RuntimeDriverSelectionFailure`. There is no silent fallback.
 *
 * Selection algorithm:
 *  1. Build the candidate list in `RUNTIME_DRIVER_PRECEDENCE` order.
 *     Each candidate records availability (from `input.availability`
 *     plus "not registered" if absent) and the guarantee level.
 *  2. If `input.requestedDriver` is set:
 *     - find the requested candidate in the candidate list,
 *     - if registered and available, return it with `forced: true`
 *       and `code: "precedence_override"`,
 *     - otherwise return a typed failure listing every candidate's
 *       unavailability (override refused rather than silently
 *       downgraded).
 *  3. Otherwise walk the candidate list in precedence order:
 *     - first registered and available candidate wins,
 *     - the chosen driver records `code: "precedence_match"`,
 *     - every skipped candidate records
 *       `code: "precedence_unavailable"` (if unavailable) or
 *       `code: "precedence_default"` (if skipped because a higher
 *       preference was chosen).
 *  4. If no candidate is registered and available, return a typed
 *     failure listing every candidate's unavailability.
 */
export function selectRuntimeDriver(input: RuntimeDriverSelectorInput): RuntimeDriverSelectionResult {
  const considered: RuntimeDriverCandidate[] = [];
  const reasons: RuntimeDriverSelectionReason[] = [];

  for (const driverId of RUNTIME_DRIVER_PRECEDENCE) {
    const driver = input.candidates[driverId];
    const explicitAvailability = input.availability?.[driverId];
    const registered = driver !== undefined;
    const available = registered && (explicitAvailability?.available ?? true);
    const unavailableReason = registered
      ? explicitAvailability?.available === false
        ? explicitAvailability.reason ?? `${driverId} marked unavailable`
        : undefined
      : `${driverId} not registered`;
    considered.push({
      driverId,
      driver: driver as RuntimeDriver,
      available,
      ...(unavailableReason ? { unavailableReason } : {}),
      guaranteeLevel: guaranteeLevelFor(driverId, driver)
    });
  }

  if (input.requestedDriver !== undefined) {
    const requestedCandidate = considered.find((c) => c.driverId === input.requestedDriver);
    if (!requestedCandidate) {
      return buildFailure(input, considered, reasons, `requested driver ${input.requestedDriver} is not a known ADR-004 driver`);
    }
    if (!requestedCandidate.driver) {
      reasons.push({
        driver: input.requestedDriver,
        code: "precedence_unavailable",
        detail: requestedCandidate.unavailableReason ?? `${input.requestedDriver} not registered`
      });
      return buildFailure(input, considered, reasons, `requested driver ${input.requestedDriver} is not registered`);
    }
    if (!requestedCandidate.available) {
      reasons.push({
        driver: input.requestedDriver,
        code: "precedence_unavailable",
        detail: requestedCandidate.unavailableReason ?? `${input.requestedDriver} marked unavailable`
      });
      return buildFailure(input, considered, reasons, `requested driver ${input.requestedDriver} is unavailable: ${requestedCandidate.unavailableReason ?? "unknown reason"}`);
    }
    reasons.push({
      driver: input.requestedDriver,
      code: "precedence_override",
      detail: "policy.requestedDriver forced the choice"
    });
    return {
      ok: true,
      selection: {
        driver: requestedCandidate.driver,
        driverId: input.requestedDriver,
        guaranteeLevel: requestedCandidate.guaranteeLevel,
        forced: true,
        requestedDriver: input.requestedDriver,
        considered,
        reasons
      }
    };
  }

  const chosen = considered.find((c) => c.driver && c.available);
  if (!chosen || !chosen.driver) {
    for (const candidate of considered) {
      reasons.push({
        driver: candidate.driverId,
        code: "precedence_unavailable",
        detail: candidate.unavailableReason ?? `${candidate.driverId} not registered`
      });
    }
    return buildFailure(input, considered, reasons, "no ADR-004 driver is available");
  }

  reasons.push({
    driver: chosen.driverId,
    code: "precedence_match",
    detail: `first available candidate in ${RUNTIME_DRIVER_PRECEDENCE.join(" → ")} order`
  });
  for (const candidate of considered) {
    if (candidate.driverId === chosen.driverId) continue;
    reasons.push({
      driver: candidate.driverId,
      code: candidate.available ? "precedence_default" : "precedence_unavailable",
      ...(candidate.unavailableReason ? { detail: candidate.unavailableReason } : {})
    });
  }

  return {
    ok: true,
    selection: {
      driver: chosen.driver,
      driverId: chosen.driverId,
      guaranteeLevel: chosen.guaranteeLevel,
      forced: false,
      requestedDriver: null,
      considered,
      reasons
    }
  };
}

function buildFailure(
  input: RuntimeDriverSelectorInput,
  considered: readonly RuntimeDriverCandidate[],
  reasons: readonly RuntimeDriverSelectionReason[],
  message: string
): RuntimeDriverSelectionFailure {
  return {
    ok: false,
    requestedDriver: input.requestedDriver ?? null,
    considered,
    reasons,
    message
  };
}

/**
 * Convenience: resolve the canonical `runtime-local` driver from a
 * selector input that is guaranteed to include one. Throws a
 * `TypeError` if the selector returned a failure. Useful for
 * bootstrap code that knows it has a local driver wired in and
 * wants the driver instance without narrowing the union.
 */
export function requireRuntimeDriver(result: RuntimeDriverSelectionResult): RuntimeDriver {
  if (result.ok) return result.selection.driver;
  throw new TypeError(`RuntimeDriver selection failed: ${result.message}`);
}

/**
 * Type guard for the selector's well-known driver ids. Mirrors
 * `RuntimeDriverPrecedenceId` so future drivers can be added in one
 * place and immediately surface in this guard.
 */
export function isRuntimeDriverPrecedenceId(value: string): value is RuntimeDriverPrecedenceId {
  return (RUNTIME_DRIVER_PRECEDENCE as readonly string[]).includes(value);
}

/**
 * Convenience helpers that fetch the canonical driver ids exposed
 * from the runtime barrel. Re-exported here so selector consumers
 * do not need to import the driver modules directly.
 */
export const RUNTIME_DRIVER_IDS = Object.freeze({
  local: RUNTIME_LOCAL_DRIVER_ID,
  eve: "runtime-eve" as const,
  legacyCli: RUNTIME_LEGACY_CLI_DRIVER_ID
});

export type { RuntimeDriverId };