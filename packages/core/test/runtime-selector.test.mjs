import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RUNTIME_DRIVER_IDS,
  RUNTIME_DRIVER_PRECEDENCE,
  RUNTIME_LEGACY_CLI_DRIVER_ID,
  RUNTIME_LEGACY_CLI_GUARANTEES,
  RUNTIME_LOCAL_DRIVER_ID,
  RuntimeLegacyCliDriver,
  RuntimeLocalDriver,
  isRuntimeDriverPrecedenceId,
  isRuntimeDriverSelectionFailure,
  requireRuntimeDriver,
  selectRuntimeDriver
} from "../dist/index.js";

function local() {
  return new RuntimeLocalDriver();
}

function legacy() {
  return new RuntimeLegacyCliDriver();
}

function stubDriver(label) {
  return {
    driverId: { driver: label, version: "0.0.0" },
    async start() {
      throw new Error(`stubDriver ${label} should not be called`);
    },
    async resume() {
      throw new Error(`stubDriver ${label} should not be called`);
    },
    async cancel() {
      throw new Error(`stubDriver ${label} should not be called`);
    },
    async inspect() {
      throw new Error(`stubDriver ${label} should not be called`);
    },
    async *stream() {
      throw new Error(`stubDriver ${label} should not be called`);
    },
    async approve() {
      throw new Error(`stubDriver ${label} should not be called`);
    },
    async artifact() {
      throw new Error(`stubDriver ${label} should not be called`);
    }
  };
}

test("RUNTIME_DRIVER_PRECEDENCE encodes ADR-004 default ordering runtime-eve → runtime-local → runtime-legacy-cli", () => {
  assert.deepEqual(RUNTIME_DRIVER_PRECEDENCE, [
    "runtime-eve",
    RUNTIME_LOCAL_DRIVER_ID,
    RUNTIME_LEGACY_CLI_DRIVER_ID
  ]);
});

test("RUNTIME_DRIVER_IDS exposes the canonical driver id constants", () => {
  assert.equal(RUNTIME_DRIVER_IDS.local, "runtime-local");
  assert.equal(RUNTIME_DRIVER_IDS.eve, "runtime-eve");
  assert.equal(RUNTIME_DRIVER_IDS.legacyCli, "runtime-legacy-cli");
});

test("isRuntimeDriverPrecedenceId narrows known ids and rejects unknown ids", () => {
  assert.equal(isRuntimeDriverPrecedenceId("runtime-local"), true);
  assert.equal(isRuntimeDriverPrecedenceId("runtime-eve"), true);
  assert.equal(isRuntimeDriverPrecedenceId("runtime-legacy-cli"), true);
  assert.equal(isRuntimeDriverPrecedenceId("runtime-future"), false);
  assert.equal(isRuntimeDriverPrecedenceId(""), false);
});

test("selector returns runtime-local when both local and legacy are registered", () => {
  const result = selectRuntimeDriver({
    candidates: {
      [RUNTIME_LOCAL_DRIVER_ID]: local(),
      [RUNTIME_LEGACY_CLI_DRIVER_ID]: legacy()
    }
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.selection.driverId, RUNTIME_LOCAL_DRIVER_ID);
  assert.equal(result.selection.forced, false);
  assert.equal(result.selection.guaranteeLevel, "full");
  const chosen = result.selection.reasons.find((r) => r.code === "precedence_match");
  assert.ok(chosen);
  assert.equal(chosen.driver, RUNTIME_LOCAL_DRIVER_ID);
});

test("selector falls back to runtime-legacy-cli when runtime-local is unavailable", () => {
  const result = selectRuntimeDriver({
    candidates: {
      [RUNTIME_LOCAL_DRIVER_ID]: local(),
      [RUNTIME_LEGACY_CLI_DRIVER_ID]: legacy()
    },
    availability: {
      [RUNTIME_LOCAL_DRIVER_ID]: { available: false, reason: "LEGION_DISABLE_LOCAL is set" }
    }
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.selection.driverId, RUNTIME_LEGACY_CLI_DRIVER_ID);
  assert.equal(result.selection.forced, false);
  assert.equal(result.selection.guaranteeLevel, "reduced");
  const chosen = result.selection.reasons.find((r) => r.code === "precedence_match");
  assert.ok(chosen);
  assert.equal(chosen.driver, RUNTIME_LEGACY_CLI_DRIVER_ID);
  const skipped = result.selection.reasons.find(
    (r) => r.driver === RUNTIME_LOCAL_DRIVER_ID && r.code === "precedence_unavailable"
  );
  assert.ok(skipped);
  assert.match(skipped.detail, /LEGION_DISABLE_LOCAL/);
});

test("selector falls back to runtime-legacy-cli when runtime-local is not registered", () => {
  const result = selectRuntimeDriver({
    candidates: {
      [RUNTIME_LEGACY_CLI_DRIVER_ID]: legacy()
    }
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.selection.driverId, RUNTIME_LEGACY_CLI_DRIVER_ID);
  assert.equal(result.selection.considered.length, 3);
  const notRegistered = result.selection.reasons.find(
    (r) => r.driver === RUNTIME_LOCAL_DRIVER_ID && r.code === "precedence_unavailable"
  );
  assert.ok(notRegistered);
  assert.match(notRegistered.detail, /not registered/);
});

test("selector falls back to runtime-legacy-cli when only Eve is registered but its availability is false", () => {
  const result = selectRuntimeDriver({
    candidates: {
      [RUNTIME_LOCAL_DRIVER_ID]: local(),
      "runtime-eve": stubDriver("runtime-eve"),
      [RUNTIME_LEGACY_CLI_DRIVER_ID]: legacy()
    },
    availability: {
      "runtime-eve": { available: false, reason: "Eve package not installed" }
    }
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.selection.driverId, RUNTIME_LOCAL_DRIVER_ID);
  const eveUnavailable = result.selection.reasons.find(
    (r) => r.driver === "runtime-eve" && r.code === "precedence_unavailable"
  );
  assert.ok(eveUnavailable);
  assert.match(eveUnavailable.detail, /Eve package not installed/);
});

test("selector records precedence_default for every lower-preference driver when a higher one wins", () => {
  const result = selectRuntimeDriver({
    candidates: {
      [RUNTIME_LOCAL_DRIVER_ID]: local(),
      [RUNTIME_LEGACY_CLI_DRIVER_ID]: legacy()
    }
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const legacyDefault = result.selection.reasons.find(
    (r) => r.driver === RUNTIME_LEGACY_CLI_DRIVER_ID && r.code === "precedence_default"
  );
  assert.ok(legacyDefault);
  const legacyUnavailable = result.selection.reasons.find(
    (r) => r.driver === RUNTIME_LEGACY_CLI_DRIVER_ID && r.code === "precedence_unavailable"
  );
  assert.equal(legacyUnavailable, undefined);
});

test("selector honours policy.requestedDriver and marks the selection forced", () => {
  const result = selectRuntimeDriver({
    candidates: {
      [RUNTIME_LOCAL_DRIVER_ID]: local(),
      [RUNTIME_LEGACY_CLI_DRIVER_ID]: legacy()
    },
    requestedDriver: RUNTIME_LEGACY_CLI_DRIVER_ID
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.selection.driverId, RUNTIME_LEGACY_CLI_DRIVER_ID);
  assert.equal(result.selection.forced, true);
  assert.equal(result.selection.requestedDriver, RUNTIME_LEGACY_CLI_DRIVER_ID);
  assert.equal(result.selection.guaranteeLevel, "reduced");
  const reason = result.selection.reasons.find((r) => r.code === "precedence_override");
  assert.ok(reason);
  assert.equal(reason.driver, RUNTIME_LEGACY_CLI_DRIVER_ID);
});

test("selector refuses to fall through silently when the requested driver is unavailable", () => {
  const result = selectRuntimeDriver({
    candidates: {
      [RUNTIME_LOCAL_DRIVER_ID]: local(),
      [RUNTIME_LEGACY_CLI_DRIVER_ID]: legacy()
    },
    availability: {
      [RUNTIME_LEGACY_CLI_DRIVER_ID]: { available: false, reason: "LEGION_DISABLE_LEGACY is set" }
    },
    requestedDriver: RUNTIME_LEGACY_CLI_DRIVER_ID
  });
  assert.equal(isRuntimeDriverSelectionFailure(result), true);
  if (!result.ok) return;
  assert.match(result.message, /LEGION_DISABLE_LEGACY is set/);
  assert.equal(result.requestedDriver, RUNTIME_LEGACY_CLI_DRIVER_ID);
});

test("selector refuses to fall through silently when the requested driver is not registered", () => {
  const result = selectRuntimeDriver({
    candidates: {
      [RUNTIME_LOCAL_DRIVER_ID]: local()
    },
    requestedDriver: RUNTIME_LEGACY_CLI_DRIVER_ID
  });
  assert.equal(isRuntimeDriverSelectionFailure(result), true);
  if (!result.ok) return;
  assert.match(result.message, /runtime-legacy-cli/);
});

test("selector rejects an unknown requested driver id with a typed failure", () => {
  const result = selectRuntimeDriver({
    candidates: {
      [RUNTIME_LOCAL_DRIVER_ID]: local()
    },
    requestedDriver: "runtime-future"
  });
  assert.equal(isRuntimeDriverSelectionFailure(result), true);
  if (!result.ok) return;
  assert.match(result.message, /runtime-future/);
  assert.match(result.message, /not a known ADR-004 driver/);
});

test("selector returns a typed failure when no driver is registered", () => {
  const result = selectRuntimeDriver({ candidates: {} });
  assert.equal(isRuntimeDriverSelectionFailure(result), true);
  if (!result.ok) return;
  assert.match(result.message, /no ADR-004 driver is available/);
  assert.equal(result.considered.length, 3);
  for (const candidate of result.considered) {
    assert.equal(candidate.available, false);
    assert.match(candidate.unavailableReason, /not registered/);
  }
});

test("selector returns a typed failure when every driver is marked unavailable", () => {
  const result = selectRuntimeDriver({
    candidates: {
      [RUNTIME_LOCAL_DRIVER_ID]: local(),
      [RUNTIME_LEGACY_CLI_DRIVER_ID]: legacy()
    },
    availability: {
      [RUNTIME_LOCAL_DRIVER_ID]: { available: false, reason: "local disabled" },
      [RUNTIME_LEGACY_CLI_DRIVER_ID]: { available: false, reason: "legacy disabled" }
    }
  });
  assert.equal(isRuntimeDriverSelectionFailure(result), true);
  if (!result.ok) return;
  assert.match(result.message, /no ADR-004 driver is available/);
  assert.ok(result.reasons.find((r) => r.driver === RUNTIME_LOCAL_DRIVER_ID && /local disabled/.test(r.detail || "")));
  assert.ok(result.reasons.find((r) => r.driver === RUNTIME_LEGACY_CLI_DRIVER_ID && /legacy disabled/.test(r.detail || "")));
});

test("selector considers all three precedence slots even when the first two are unavailable", () => {
  const result = selectRuntimeDriver({
    candidates: {
      [RUNTIME_LOCAL_DRIVER_ID]: local(),
      "runtime-eve": stubDriver("runtime-eve"),
      [RUNTIME_LEGACY_CLI_DRIVER_ID]: legacy()
    },
    availability: {
      [RUNTIME_LOCAL_DRIVER_ID]: { available: false, reason: "env: LEGION_DISABLE_LOCAL" },
      "runtime-eve": { available: false, reason: "env: LEGION_DISABLE_EVE" }
    }
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.selection.driverId, RUNTIME_LEGACY_CLI_DRIVER_ID);
  assert.equal(result.selection.considered.length, 3);
  const localReason = result.selection.reasons.find((r) => r.driver === RUNTIME_LOCAL_DRIVER_ID);
  assert.equal(localReason.code, "precedence_unavailable");
  assert.match(localReason.detail, /LEGION_DISABLE_LOCAL/);
  const eveReason = result.selection.reasons.find((r) => r.driver === "runtime-eve");
  assert.equal(eveReason.code, "precedence_unavailable");
  assert.match(eveReason.detail, /LEGION_DISABLE_EVE/);
});

test("selector surfaces the guarantee level of the chosen driver", () => {
  const localResult = selectRuntimeDriver({
    candidates: { [RUNTIME_LOCAL_DRIVER_ID]: local() }
  });
  assert.equal(localResult.ok, true);
  if (localResult.ok) {
    assert.equal(localResult.selection.guaranteeLevel, "full");
  }
  const legacyResult = selectRuntimeDriver({
    candidates: { [RUNTIME_LEGACY_CLI_DRIVER_ID]: legacy() }
  });
  assert.equal(legacyResult.ok, true);
  if (legacyResult.ok) {
    assert.equal(legacyResult.selection.guaranteeLevel, "reduced");
    assert.equal(legacyResult.selection.guaranteeLevel, RUNTIME_LEGACY_CLI_GUARANTEES.level);
  }
});

test("requireRuntimeDriver returns the driver on success and throws TypeError on failure", () => {
  const ok = selectRuntimeDriver({
    candidates: { [RUNTIME_LOCAL_DRIVER_ID]: local() }
  });
  assert.equal(typeof requireRuntimeDriver(ok), "object");

  const bad = selectRuntimeDriver({ candidates: {} });
  assert.throws(() => requireRuntimeDriver(bad), TypeError);
});

test("selector enumerates considered candidates in precedence order", () => {
  const result = selectRuntimeDriver({
    candidates: {
      [RUNTIME_LOCAL_DRIVER_ID]: local(),
      "runtime-eve": stubDriver("runtime-eve"),
      [RUNTIME_LEGACY_CLI_DRIVER_ID]: legacy()
    }
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.selection.considered.map((c) => c.driverId),
    ["runtime-eve", RUNTIME_LOCAL_DRIVER_ID, RUNTIME_LEGACY_CLI_DRIVER_ID]
  );
});