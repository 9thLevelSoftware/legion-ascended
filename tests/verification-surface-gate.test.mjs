import assert from "node:assert/strict";
import { test } from "node:test";

import {
  integrationSurfaceVerdict,
  verificationSurfaceChecks
} from "../packages/cli/dist/commands/workflow/build.js";
import {
  deriveShipGates,
  shipGateDiagnostics,
  shipGatePinnedReferences,
  shipGateRecovery
} from "../packages/cli/dist/workflow/ship-gates.js";

/**
 * `integration_or_real_interface_checks`, gate side and producer side.
 *
 * The gate asks whether verification reached the integration or real interface
 * the plan said it would. Until this release it fell through `evaluateGate`'s
 * `default:` arm and answered "Legion does not yet produce evidence for this
 * gate" on every R2 change — honest, and the reason every R2 change was
 * structurally unshippable.
 *
 * The fixtures here are structurally minimal, as tests/ship-risk-gates' are: the
 * smallest shapes `deriveShipGates` reads. End-to-end shape — that a real
 * interview, plan and build actually produce them — is
 * tests/verification-surface-authoring.
 */

const TASK_ID = "tsk_phase-1";
const CHANGE_ID = "chg_surface";

const COMPOSE_PIN = { path: "ops/compose.integration.yml", sha256: `sha256:${"b".repeat(64)}` };

function surface(kind, overrides = {}) {
  return {
    kind,
    interface: "POST /v1/orders",
    rationale: "The suite posts a real order through the running API rather than a mocked client.",
    pinned: [COMPOSE_PIN],
    ...overrides
  };
}

function entry(items) {
  return { evidence: { id: "evd_1", taskId: TASK_ID, items }, acceptance: { status: "accepted" } };
}

function item(id, verdict) {
  return { id, verdict };
}

const PASSING_ITEMS = [item("declared-verification", "pass"), item("diff-reconciliation", "pass")];

/**
 * R2 is the only tier whose gate set derives this gate.
 *
 * `contracts` and `entries` are plural because the gate is change-scoped: its
 * question is about every task of the change, so a fixture that could only build
 * one task could not exercise the branch the scope exists for. The singular
 * `contract`/`items` spellings stay as sugar for the one-task case, which is what
 * `legion plan` produces for a single-criterion requirement.
 */
function gateFor({ contract, items = PASSING_ITEMS, contracts, entries, change } = {}) {
  const tasks =
    contracts ??
    [{ id: "ctr_phase-1", risk: { tier: "R2", reasons: ["test"] }, ...(contract ?? {}) }];
  const report = deriveShipGates({
    tasks,
    taskIdFor: (task) => (task.id === "ctr_phase-1" ? TASK_ID : `tsk_${task.id.slice("ctr_".length)}`),
    entries: entries ?? [entry(items)],
    reviews: [],
    ...(change === undefined ? {} : { change })
  });
  return report.gates.find((gate) => gate.gate === "integration_or_real_interface_checks");
}

/**
 * A run-time pin observer that agrees with the declaration.
 *
 * `verificationSurfaceChecks` hashes every non-unit surface's pins at the instant
 * the commands finished, so every producer-side fixture has to say what was on
 * disk then. Required rather than defaulted in the production signature, and
 * spelled out here for the same reason: a fixture that omitted it would be
 * asserting the outcome of a run nobody checked the bytes of.
 */
function observedAsDeclared(path) {
  return { path, sha256: COMPOSE_PIN.sha256 };
}

test("a task that declares no verification surface is unevaluable, never satisfied", () => {
  // Every task contract on disk before this release, and every project planned
  // without an interview. Nothing declared a surface, so nothing is known — and
  // the alternative, treating an undeclared command as a unit surface, would
  // manufacture a recorded negative from a schema default nobody wrote.
  const gate = gateFor({
    contract: { verification: [{ command: "pnpm", args: ["test"], expectedExitCode: 0 }] }
  });

  assert.equal(gate.status, "unevaluable");
  assert.match(gate.reason, /declares a verification surface/);
});

test("a task shaped only as an id and a risk tier does not throw", () => {
  // `task.verification` and `task.oracleRefs` are absent in every unit fixture in
  // tests/ship-risk-gates, tests/ship-delta-spec-approval and
  // tests/ship-human-approval-gate. A bare `task.verification.some(...)` throws a
  // TypeError out of `deriveShipGates` — out of the one command whose entire job
  // is reporting honestly on input that is already degraded.
  const gate = gateFor();

  assert.equal(gate.status, "unevaluable");
});

test("declaring only unit surfaces is unsatisfied, and says so differently from silence", () => {
  // The branch this gate exists for. A change that filled the declaration in for
  // every executable criterion and wrote `unit` each time has *answered* R2's
  // question, and the answer is no. Reporting that as `unevaluable` would tell
  // the operator nobody said, which is false and invites the repair of saying it
  // again.
  //
  // It is decided from the declarations rather than from any evidence verdict,
  // and that is not a style choice: `evidenceItemVerdict` maps every verdict that
  // is not `pass`/`fail` to absence, so an all-unit answer expressed as a verdict
  // would arrive at this gate spelled exactly like silence.
  const gate = gateFor({
    contract: {
      verification: [{ command: "pnpm", args: ["test"], expectedExitCode: 0, surface: surface("unit") }]
    }
  });

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /recorded answer, not a missing one/);

  // And the two reasons must not read alike, because they send an operator
  // somewhere different.
  const absent = gateFor();
  assert.notEqual(gate.reason, absent.reason);
});

test("a non-unit surface with a passing check and a clean pin is satisfied", () => {
  const gate = gateFor({
    contract: {
      verification: [
        { command: "pnpm", args: ["test"], expectedExitCode: 0, surface: surface("real-interface") }
      ]
    },
    items: [...PASSING_ITEMS, item("integration-surface-check", "pass")],
    change: { changeId: CHANGE_ID, verifyPin: () => "match" }
  });

  assert.equal(gate.status, "satisfied");
  assert.match(gate.reason, /POST \/v1\/orders/);
});

test("a pin that drifted after the build is unsatisfied, however the evidence reads", () => {
  // The evidence item was written when the pins were clean and stays `pass`
  // forever. A gate that read only the verdict would certify a declaration whose
  // compose file has since been edited to swap the real service for an in-memory
  // fake — which is precisely the edit this gate exists to catch, and precisely
  // the one a passing test suite hides.
  const gate = gateFor({
    contract: {
      verification: [
        { command: "pnpm", args: ["test"], expectedExitCode: 0, surface: surface("real-interface") }
      ]
    },
    items: [...PASSING_ITEMS, item("integration-surface-check", "pass")],
    change: { changeId: CHANGE_ID, verifyPin: () => "drift" }
  });

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /ops\/compose\.integration\.yml/);
  assert.match(gate.reason, /bytes have changed/);
});

test("a pinned file that is gone is unsatisfied; one nobody hashed is unevaluable", () => {
  // `missing` and `unverified` look alike and mean opposite things. A pin asserts
  // the file existed at that digest, so its absence is evidence and is negative;
  // a reference no collector gathered was simply not checked, and reporting that
  // as `match` would pass an unchecked pin while reporting it as `missing` would
  // say a file sitting right there is gone.
  const contract = {
    verification: [
      { command: "pnpm", args: ["test"], expectedExitCode: 0, surface: surface("integration") }
    ]
  };
  const items = [...PASSING_ITEMS, item("integration-surface-check", "pass")];

  const missing = gateFor({ contract, items, change: { changeId: CHANGE_ID, verifyPin: () => "missing" } });
  assert.equal(missing.status, "unsatisfied");
  assert.match(missing.reason, /no longer present/);

  const unverified = gateFor({
    contract,
    items,
    change: { changeId: CHANGE_ID, verifyPin: () => "unverified" }
  });
  assert.equal(unverified.status, "unevaluable");
  assert.match(unverified.reason, /did not hash/);
});

test("a declared surface with no evidence item is unevaluable, not satisfied by its clean pin", () => {
  // Declared and never built. The pins are clean because nothing has touched
  // them, and a gate that stopped at the pin check would report a boundary
  // reached by a run that never happened.
  const gate = gateFor({
    contract: {
      verification: [
        { command: "pnpm", args: ["test"], expectedExitCode: 0, surface: surface("real-interface") }
      ]
    },
    items: PASSING_ITEMS,
    change: { changeId: CHANGE_ID, verifyPin: () => "match" }
  });

  assert.equal(gate.status, "unevaluable");
  assert.match(gate.reason, /no integration-surface-check/);
});

test("an integration-surface-check of unknown does not satisfy the gate", () => {
  // `unknown` is what build records when a declared non-unit surface was never
  // exercised — an oracle that produced no command, or a command index with no
  // result. This gate reads the full verdict rather than going through
  // `evidenceItemVerdict`, which collapses `unknown` to absence, so the reason
  // can say which of the two it is.
  const gate = gateFor({
    contract: {
      verification: [
        { command: "pnpm", args: ["test"], expectedExitCode: 0, surface: surface("end-to-end") }
      ]
    },
    items: [...PASSING_ITEMS, item("integration-surface-check", "unknown")],
    change: { changeId: CHANGE_ID, verifyPin: () => "match" }
  });

  assert.equal(gate.status, "unevaluable");
  assert.match(gate.reason, /did not reach every declared non-unit surface/);
});

test("a failed integration-surface-check is unsatisfied", () => {
  const gate = gateFor({
    contract: {
      verification: [
        { command: "pnpm", args: ["test"], expectedExitCode: 0, surface: surface("integration") }
      ]
    },
    items: [...PASSING_ITEMS, item("integration-surface-check", "fail")],
    change: { changeId: CHANGE_ID, verifyPin: () => "match" }
  });

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /failed integration-surface-check/);
});

test("a verdict of not_applicable is read as absence, not as a pass", () => {
  // Holds the gate's own verdict reader against a future refactor back to
  // `evidenceItemVerdict`. Anything that is not `pass`, `fail` or `unknown` says
  // nothing about whether the boundary was reached.
  const gate = gateFor({
    contract: {
      verification: [
        { command: "pnpm", args: ["test"], expectedExitCode: 0, surface: surface("integration") }
      ]
    },
    items: [...PASSING_ITEMS, item("integration-surface-check", "not_applicable")],
    change: { changeId: CHANGE_ID, verifyPin: () => "match" }
  });

  assert.notEqual(gate.status, "satisfied");
});

test("a surface declared on an oracle is read, and its pins are checked", () => {
  // `legion plan` copies one authored criterion onto both the contract's
  // verification entry and the oracle that criterion produces. A gate reading
  // only the contract would miss an oracle-side declaration entirely, which is
  // absence — the answer this gate exists to stop producing.
  const contract = { oracleRefs: ["orc_phase-1-c1"] };
  const items = [...PASSING_ITEMS, item("integration-surface-check", "pass")];
  const oracles = [
    { document: { id: "orc_phase-1-c1", surface: surface("real-interface") }, reference: COMPOSE_PIN }
  ];

  const clean = gateFor({ contract, items, change: { changeId: CHANGE_ID, oracles, verifyPin: () => "match" } });
  assert.equal(clean.status, "satisfied");

  const drifted = gateFor({ contract, items, change: { changeId: CHANGE_ID, oracles, verifyPin: () => "drift" } });
  assert.equal(drifted.status, "unsatisfied");
  assert.match(drifted.reason, /oracle orc_phase-1-c1/);
});

test("an oracle the report could not read leaves the declaration set unestablished", () => {
  // `change.oracles` is all-or-nothing: one malformed file in the directory
  // collapses the plane. Concluding "nothing declares a surface" from a plane
  // that failed to load would turn a declared boundary check into silence, and
  // concluding "everything declared is unit" from a partial set would turn it
  // into a negative nobody recorded.
  const gate = gateFor({
    contract: {
      oracleRefs: ["orc_phase-1-c1"],
      verification: [{ command: "pnpm", args: ["test"], expectedExitCode: 0, surface: surface("unit") }]
    },
    change: { changeId: CHANGE_ID, verifyPin: () => "match" }
  });

  assert.equal(gate.status, "unevaluable");
  assert.match(gate.reason, /orc_phase-1-c1/);
});

test("facts with no verifier at all report unevaluable rather than passing an unchecked pin", () => {
  const gate = gateFor({
    contract: {
      verification: [
        { command: "pnpm", args: ["test"], expectedExitCode: 0, surface: surface("integration") }
      ]
    },
    items: [...PASSING_ITEMS, item("integration-surface-check", "pass")]
  });

  assert.equal(gate.status, "unevaluable");
});

// --- the producer side: which declared surface did this run actually reach ---

function report({ commands = [], failingIndices = [] } = {}) {
  return { commands, failingIndices, passed: failingIndices.length === 0 };
}

function command(index, name, args = []) {
  return { index, command: name, args };
}

test("a declared surface whose command never ran is unrun, and never reads as passed", () => {
  // The sharpest fail-open in the item. `synthesizeReport` records
  // `failingIndices: []` for a run that produced no results at all — a missing
  // runner, a thrown dispatch — so a rule that only asked "is this index among
  // the failures" would answer no, and a declared integration check that was
  // never attempted would be recorded as passing.
  const checks = verificationSurfaceChecks({
    task: {
      verification: [
        { command: "pnpm", args: ["test"], expectedExitCode: 0, surface: surface("real-interface") }
      ]
    },
    verification: { report: report(), passed: false },
    observePin: observedAsDeclared,
    reaffirmedPin: () => false
  });

  assert.equal(checks.length, 1);
  assert.equal(checks[0].outcome, "unrun");
  assert.notEqual(checks[0].outcome, "passed");
});

test("a surface attributed to a command that is not the one it was declared on is unrun", () => {
  // "Contract entries occupy indices 0..n-1 in declaration order" is a positional
  // covenant spanning two packages, and a covenant is not a contract. If core
  // ever reorders the command list, trusting the position would credit one
  // command's pass to another command's declaration — the only way this item can
  // lie rather than merely fail to answer.
  const checks = verificationSurfaceChecks({
    task: {
      verification: [
        { command: "pnpm", args: ["test"], expectedExitCode: 0, surface: surface("integration") }
      ]
    },
    verification: { report: report({ commands: [command(0, "make", ["smoke"])] }), passed: true },
    observePin: observedAsDeclared,
    reaffirmedPin: () => false
  });

  assert.equal(checks[0].outcome, "unrun");
  assert.match(checks[0].note, /is not the one this surface was declared on/);
});

test("a failing declared surface is failed, and a passing one passed", () => {
  const task = {
    verification: [
      { command: "pnpm", args: ["test"], expectedExitCode: 0, surface: surface("real-interface") }
    ]
  };

  const passing = verificationSurfaceChecks({
    task,
    verification: { report: report({ commands: [command(0, "pnpm", ["test"])] }), passed: true },
    observePin: observedAsDeclared,
    reaffirmedPin: () => false
  });
  assert.equal(passing[0].outcome, "passed");

  const failing = verificationSurfaceChecks({
    task,
    verification: {
      report: report({ commands: [command(0, "pnpm", ["test"])], failingIndices: [0] }),
      passed: false
    },
    observePin: observedAsDeclared,
    reaffirmedPin: () => false
  });
  assert.equal(failing[0].outcome, "failed");
});

test("an oracle that produced no executable command has its surface recorded as unrun", () => {
  // An inspection oracle, or one whose execution mode no runner can execute. It
  // is absent from `oracleAttribution` and present in `unevaluatedOracleRefs`, so
  // nothing ran the command its declaration describes.
  const checks = verificationSurfaceChecks({
    task: { verification: [] },
    verification: {
      report: report({ commands: [] }),
      passed: true,
      oracleAttribution: [],
      oracleSurfaces: [{ oracleId: "orc_phase-1", surface: surface("end-to-end") }]
    },
    observePin: observedAsDeclared,
    reaffirmedPin: () => false
  });

  assert.equal(checks.length, 1);
  assert.equal(checks[0].outcome, "unrun");
  assert.match(checks[0].note, /produced no executable command/);
});

test("no report means no checks at all, so build emits no item and ship reports absence", () => {
  // Verification blocked before it ran — no worker context, an unreadable oracle.
  // That is not a task whose declared surfaces failed; it is a task whose
  // declared surfaces were never asked about, and the two must not share a
  // verdict.
  assert.deepEqual(
    verificationSurfaceChecks({
      task: {
        verification: [
          { command: "pnpm", args: ["test"], expectedExitCode: 0, surface: surface("integration") }
        ]
      },
      verification: { passed: false, blockedReason: "No worker context was available for verification." },
      observePin: observedAsDeclared
    }),
    []
  );
});

// --- the altitude: this gate asks about the change, not about one criterion ---

/** A second task, as `legion plan` builds one per executable criterion. */
function secondTask(contract = {}) {
  return { id: "ctr_phase-2", risk: { tier: "R2", reasons: ["test"] }, ...contract };
}

function entryFor(taskId, items) {
  return { evidence: { id: `evd_${taskId}`, taskId, items }, acceptance: { status: "accepted" } };
}

const UNIT_ONLY = {
  verification: [
    {
      command: "node",
      args: ["--test", "arithmetic"],
      expectedExitCode: 0,
      surface: {
        kind: "unit",
        interface: "PricingEngine.quote()",
        rationale: "Exercises the pricing module in process; nothing outside this repository is reached.",
        pinned: [{ path: "packages/pricing/src/engine.ts", sha256: `sha256:${"c".repeat(64)}` }]
      }
    }
  ]
};

const REAL_INTERFACE_TASK = {
  verification: [
    { command: "pnpm", args: ["test"], expectedExitCode: 0, surface: surface("real-interface") }
  ]
};

test("an honest unit criterion does not block a change that does reach a real interface", () => {
  // The specification defect this release corrects, and the reason the gate moved
  // to change scope. `legion plan` materializes one task per executable
  // criterion, so a task-scoped all-unit rule fired per *criterion*: a change
  // whose first criterion posts through the running API and whose second is a
  // pure-arithmetic unit check was blocked, forever, by the criterion that
  // truthfully said it crosses no boundary. There was no way to answer it — the
  // requirement set cannot be rewritten — so the only escapes were deleting the
  // honest criterion or relabelling it `integration`. A gate that punishes an
  // accurate answer teaches operators to give an inaccurate one, which costs more
  // than the gate is worth.
  //
  // ADR-006's wording is "verification reaches the relevant integration or real
  // interface **for the change**", and that is now what is asked.
  const gate = gateFor({
    contracts: [{ id: "ctr_phase-1", risk: { tier: "R2", reasons: ["test"] }, ...REAL_INTERFACE_TASK }, secondTask(UNIT_ONLY)],
    entries: [
      entryFor(TASK_ID, [...PASSING_ITEMS, item("integration-surface-check", "pass")]),
      entryFor("tsk_phase-2", PASSING_ITEMS)
    ],
    change: { changeId: CHANGE_ID, verifyPin: () => "match" }
  });

  assert.equal(gate.status, "satisfied");
  assert.equal(gate.scope, "change");
  assert.equal(gate.subjectId, CHANGE_ID);
});

test("a change whose every declared surface is unit is still unsatisfied", () => {
  // The negative survives the altitude change, and it has to: a whole change
  // stating that nothing in it crosses a boundary has answered R2's question.
  // Moving the determination to change scope without keeping this would turn the
  // recorded negative back into silence, which is the fail-open the whole gate
  // exists to close.
  const gate = gateFor({
    contracts: [
      { id: "ctr_phase-1", risk: { tier: "R2", reasons: ["test"] }, ...UNIT_ONLY },
      secondTask(UNIT_ONLY)
    ],
    entries: [entryFor(TASK_ID, PASSING_ITEMS), entryFor("tsk_phase-2", PASSING_ITEMS)],
    change: { changeId: CHANGE_ID, verifyPin: () => "match" }
  });

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /Every verification surface this change declares is a unit surface/);
  assert.match(gate.reason, /recorded answer, not a missing one/);
});

test("a change-scoped verdict collapses to one diagnostic however many tasks derived it", () => {
  // PR 0's collapse, reached by this gate for the first time. Without it a
  // three-criterion change would print the same sentence about the same change
  // three times, under three different task ids — and the operator would read
  // three defects where there is one.
  const report = deriveShipGates({
    tasks: [
      { id: "ctr_phase-1", risk: { tier: "R2", reasons: ["test"] }, ...UNIT_ONLY },
      { id: "ctr_phase-2", risk: { tier: "R2", reasons: ["test"] }, ...UNIT_ONLY },
      { id: "ctr_phase-3", risk: { tier: "R2", reasons: ["test"] }, ...UNIT_ONLY }
    ],
    taskIdFor: (task) => `tsk_${task.id.slice("ctr_".length)}`,
    entries: [
      entryFor("tsk_phase-1", PASSING_ITEMS),
      entryFor("tsk_phase-2", PASSING_ITEMS),
      entryFor("tsk_phase-3", PASSING_ITEMS)
    ],
    reviews: [],
    change: { changeId: CHANGE_ID, verifyPin: () => "match" }
  });

  const rows = report.gates.filter((gate) => gate.gate === "integration_or_real_interface_checks");
  assert.equal(rows.length, 3, "one row per task, so the tier arithmetic still holds");

  const diagnostics = shipGateDiagnostics({ gates: report.gates, path: "taskgraph.json" }).filter(
    (entry) => entry.gate === "integration_or_real_interface_checks"
  );
  assert.equal(diagnostics.length, 1, JSON.stringify(diagnostics));
  assert.match(diagnostics[0].message, new RegExp(CHANGE_ID));
});

test("one authored surface read from both the contract and its oracle counts once", () => {
  // `legion plan` copies one criterion's declaration onto the task contract's
  // verification entry *and* onto the oracle that criterion produces, so reading
  // both planes finds the same fact twice. Unioning them without an identity
  // check counted one declaration as two: the drift diagnostic read "2 of this
  // change's declared surfaces are unmet" over one file, the satisfied reason
  // read "reached 2 declared surfaces (POST /v1/orders, POST /v1/orders)", and
  // every pinned file was hashed and compared twice.
  const declaration = surface("real-interface");
  const hashed = [];
  const gate = gateFor({
    contract: {
      oracleRefs: ["orc_phase-1-c1"],
      verification: [{ command: "pnpm", args: ["test"], expectedExitCode: 0, surface: declaration }]
    },
    items: [...PASSING_ITEMS, item("integration-surface-check", "pass")],
    change: {
      changeId: CHANGE_ID,
      oracles: [{ document: { id: "orc_phase-1-c1", surface: declaration }, reference: COMPOSE_PIN }],
      verifyPin: (reference) => {
        hashed.push(reference.path);
        return "match";
      }
    }
  });

  assert.equal(gate.status, "satisfied");
  assert.equal(hashed.length, 1, `one pin, checked once, not ${hashed.length} times`);
  // Both origins survive the collapse, because "where did this come from" is
  // still two true answers about one fact.
  assert.match(gate.reason, /verification entry 1 of tsk_phase-1 and oracle orc_phase-1-c1/);
  assert.doesNotMatch(gate.reason, /POST \/v1\/orders.*POST \/v1\/orders/);
});

test("two tasks declaring an identical surface are not collapsed into one", () => {
  // The dedupe is scoped to one task, and this is why. Two criteria that happen
  // to describe the same boundary have their own evidence entries answering for
  // them, so merging across tasks would drop one task's verdict and answer for it
  // with another's. Here the second task never ran, and the change must not be
  // satisfied by the first task's pass standing in for it — except that it *is*
  // satisfied, because one surface genuinely was reached. What this asserts is
  // that both were considered: the reason names the unmet one.
  const gate = gateFor({
    contracts: [
      { id: "ctr_phase-1", risk: { tier: "R2", reasons: ["test"] }, ...REAL_INTERFACE_TASK },
      secondTask(REAL_INTERFACE_TASK)
    ],
    entries: [
      entryFor(TASK_ID, [...PASSING_ITEMS, item("integration-surface-check", "pass")]),
      entryFor("tsk_phase-2", PASSING_ITEMS)
    ],
    change: { changeId: CHANGE_ID, verifyPin: () => "match" }
  });

  assert.equal(gate.status, "satisfied");
  assert.match(gate.reason, /1 other declared surface is unmet/);
});

test("no surface reached cleanly means the negative wins over the unknown", () => {
  // Aggregation is `some` for `satisfied` and negative-first for everything else.
  // A change where one declared surface failed and another was never exercised
  // must report the failure: it is the more actionable fact and the one the
  // operator has to answer.
  const gate = gateFor({
    contracts: [
      { id: "ctr_phase-1", risk: { tier: "R2", reasons: ["test"] }, ...REAL_INTERFACE_TASK },
      secondTask(REAL_INTERFACE_TASK)
    ],
    entries: [
      entryFor(TASK_ID, PASSING_ITEMS),
      entryFor("tsk_phase-2", [...PASSING_ITEMS, item("integration-surface-check", "fail")])
    ],
    change: { changeId: CHANGE_ID, verifyPin: () => "match" }
  });

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /failed integration-surface-check/);
});

// --- the cure: a drifted pin a named human has re-affirmed ---

const APPROVER = { kind: "human", id: "dasbl" };
const CURRENT_COMPOSE = `sha256:${"d".repeat(64)}`;

function reaffirmation(overrides = {}) {
  return {
    id: "apv_reaffirm",
    changeId: CHANGE_ID,
    status: "granted",
    scope: { action: "verification.surface.reaffirm", targets: [{ kind: "change", id: CHANGE_ID }] },
    artifacts: [{ path: COMPOSE_PIN.path, sha256: CURRENT_COMPOSE }],
    decidedBy: APPROVER,
    decidedAt: "2026-08-05T12:00:00.000Z",
    ...overrides
  };
}

/** `drift` for the declaration, `match` for the bytes a human re-affirmed. */
function verifyAgainstCurrent(reference) {
  if (reference.sha256 === CURRENT_COMPOSE) return "match";
  return "drift";
}

function driftedGate({ approvals, evaluatedAt } = {}) {
  return gateFor({
    contract: REAL_INTERFACE_TASK,
    items: [...PASSING_ITEMS, item("integration-surface-check", "pass")],
    change: {
      changeId: CHANGE_ID,
      approvals,
      evaluatedAt,
      verifyPin: verifyAgainstCurrent
    }
  });
}

test("a drifted pin a named human re-affirmed against the current bytes is satisfied", () => {
  // The blocking defect this release corrects. A verification-surface pin was
  // minted only at `legion start --finalize`, and nothing in Legion could ever
  // re-mint it: a second interview cannot finalize over the first, and a
  // finalized session cannot be aborted. So the first byte changed in an
  // integration harness — the honest maintenance the declaration exists to
  // encourage — permanently unsatisfied this gate for every change tracing that
  // requirement, with `GATE_RECOVERY` naming no way back.
  assert.equal(driftedGate({ approvals: [reaffirmation()] }).status, "satisfied");
});

test("a gate satisfied over a re-affirmed pin says so, and carries the judgement that makes it visible", () => {
  // The defect: this arm emitted the sentence "was exercised, and every pinned
  // reference still matches" after a re-affirmation, which is false about the
  // declaration's pin *by construction* — a re-affirmation is reachable only
  // from `drift`. It also set neither `waived` nor `judgement`, so
  // `legion ship` reported `waivedGates: []`, `humanJudgementGates: []` and no
  // warning at all over a gate whose current bytes nothing had run against.
  // Measured through the real CLI on the dogfood workspace: overwrite the
  // pinned compose file with prose stating the integration environment no
  // longer exists, `legion approve surface --approver dogfood`, then ship —
  // `{"status":"ready","riskGates":{"satisfied":7,...,"waivedGates":[],
  // "humanJudgementGates":[]},"diagnostics":[]}`. ADR-011 claimed those two
  // lists name every gate satisfied with nothing machine-checkable behind it;
  // this was the counterexample, and the payload was what was wrong.
  const gate = driftedGate({ approvals: [reaffirmation()] });

  assert.equal(gate.status, "satisfied");
  assert.doesNotMatch(gate.reason, /every pinned reference still matches/);
  assert.match(gate.reason, /no longer matches the bytes that check ran against/);
  assert.match(gate.reason, /dasbl re-affirmed the declaration/);
  assert.match(gate.reason, /no verification has run against them/);

  assert.deepEqual(gate.judgement, {
    basis: "pin-reaffirmation",
    gate: "integration_or_real_interface_checks",
    decidedBy: "dasbl",
    decidedAt: "2026-08-05T12:00:00.000Z",
    path: COMPOSE_PIN.path,
    interface: REAL_INTERFACE_TASK.verification[0].surface.interface
  });
});

test("a change with one clean surface and one re-affirmed one is satisfied by the clean one", () => {
  // The ordering rule, asserted rather than assumed. Aggregation across surfaces
  // is `some`, so the gate must report the *strongest* route it has: a change
  // that also reaches a real interface through pins nothing has touched is
  // machine-checked end to end, and attaching a human-judgement echo to it would
  // over-report exactly as badly as the missing echo under-reported. Without
  // this test, `outcomes.find(satisfied)` picking whichever came first would be
  // green half the time by fixture order.
  const other = {
    command: "pnpm",
    args: ["test:e2e"],
    expectedExitCode: 0,
    surface: surface("end-to-end", {
      interface: "GET /v1/orders/{id}",
      pinned: [{ path: "ops/compose.e2e.yml", sha256: `sha256:${"e".repeat(64)}` }]
    })
  };
  const gate = gateFor({
    contracts: [
      { id: "ctr_phase-1", risk: { tier: "R2", reasons: ["test"] }, ...REAL_INTERFACE_TASK },
      secondTask({ verification: [other] })
    ],
    entries: [
      entryFor(TASK_ID, [...PASSING_ITEMS, item("integration-surface-check", "pass")]),
      entryFor("tsk_phase-2", [...PASSING_ITEMS, item("integration-surface-check", "pass")])
    ],
    change: {
      changeId: CHANGE_ID,
      approvals: [reaffirmation()],
      // The declared compose pin drifted and was re-affirmed; the e2e one is
      // untouched.
      verifyPin: (reference) =>
        reference.path === COMPOSE_PIN.path
          ? reference.sha256 === CURRENT_COMPOSE
            ? "match"
            : "drift"
          : "match"
    }
  });

  assert.equal(gate.status, "satisfied");
  assert.equal(gate.judgement, undefined);
  assert.match(gate.reason, /GET \/v1\/orders\/\{id\}/);
});

test("a clean pin keeps the unqualified sentence and raises no judgement", () => {
  // The other half of the pair, and the reason the assertion above is not a
  // tautology: without this, replacing the whole arm with an unconditional
  // judgement would still pass. A surface whose pins match is machine-checked
  // end to end and must not be echoed as somebody's decision — over-reporting a
  // human judgement is the same unreadable payload as under-reporting one.
  const gate = gateFor({
    contract: REAL_INTERFACE_TASK,
    items: [...PASSING_ITEMS, item("integration-surface-check", "pass")],
    change: { changeId: CHANGE_ID, approvals: [reaffirmation()], verifyPin: () => "match" }
  });

  assert.equal(gate.status, "satisfied");
  assert.match(gate.reason, /every pinned reference still matches/);
  assert.equal(gate.judgement, undefined);
});

test("a drifted pin with no re-affirmation is unsatisfied and names the cure", () => {
  const gate = driftedGate({ approvals: [] });

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /bytes have changed/);
  assert.match(gate.reason, /legion approve surface --approver <id>/);
});

test("a re-affirmation of bytes that are no longer there does not survive", () => {
  // This is what stops the record being a blanket exemption. The approval pins
  // the digest the approver looked at and ship re-hashes it, so it covers exactly
  // one revision of the file: edit it again and the drift returns. An approval
  // that named only the path would permanently disable the pin check for that
  // file.
  const gate = gateFor({
    contract: REAL_INTERFACE_TASK,
    items: [...PASSING_ITEMS, item("integration-surface-check", "pass")],
    change: {
      changeId: CHANGE_ID,
      approvals: [reaffirmation()],
      // A third revision: neither the declared digest nor the re-affirmed one.
      verifyPin: () => "drift"
    }
  });

  assert.equal(gate.status, "unsatisfied");
});

test("a re-affirmation by a tool, or one revoked, or one lapsed, does not answer the drift", () => {
  // Every rule `deltaSpecApprovalStatus` applies, applied here — because a cure
  // that a machine could grant, or that a withdrawal could not take back, would
  // be a laundering mechanism rather than a decision.
  const byTool = driftedGate({
    approvals: [reaffirmation({ decidedBy: { kind: "tool", id: "legion" } })]
  });
  assert.equal(byTool.status, "unsatisfied");

  const revoked = driftedGate({
    approvals: [
      reaffirmation(),
      reaffirmation({
        id: "apv_reaffirm_revoked",
        status: "revoked",
        decidedAt: "2026-08-06T12:00:00.000Z"
      })
    ]
  });
  assert.equal(revoked.status, "unsatisfied", "a later withdrawal puts the drift back");

  const lapsed = driftedGate({
    approvals: [reaffirmation({ expiresAt: "2026-08-05T18:00:00.000Z" })],
    evaluatedAt: "2026-08-07T00:00:00.000Z"
  });
  assert.equal(lapsed.status, "unsatisfied");
});

test("a re-affirmation of a different change, or a different file, is not read", () => {
  const otherChange = driftedGate({ approvals: [reaffirmation({ changeId: "chg_elsewhere" })] });
  assert.equal(otherChange.status, "unsatisfied");

  const otherFile = driftedGate({
    approvals: [reaffirmation({ artifacts: [{ path: "ops/other.yml", sha256: CURRENT_COMPOSE }] })]
  });
  assert.equal(otherFile.status, "unsatisfied");
});

test("a missing pinned file is not offered the re-affirmation cure", () => {
  // `legion approve surface` mints its pin by hashing the file, so there is no
  // document it could produce for a path that is not there. Naming the cure for a
  // state it cannot reach would be advice that fails.
  const gate = gateFor({
    contract: REAL_INTERFACE_TASK,
    items: [...PASSING_ITEMS, item("integration-surface-check", "pass")],
    change: { changeId: CHANGE_ID, approvals: [reaffirmation()], verifyPin: () => "missing" }
  });

  assert.equal(gate.status, "unsatisfied");
  assert.match(gate.reason, /no longer present/);
  assert.doesNotMatch(gate.reason, /legion approve surface/);
});

// --- routing: a blocked ship has to be sent somewhere that can help ---

test("each unmet state routes to the command that repairs that state", () => {
  // `GATE_RECOVERY` holds one command per gate id and this gate has four unmet
  // states with four repairs, so the verdict carries its own recovery and
  // `shipGateRecovery` prefers it. Naming one of the four in the table would send
  // three quarters of blocked operators to a command that cannot help them —
  // which is the no-route-out loop this whole series exists to close, in a new
  // costume.
  const fallback = { command: "legion build", reason: "fallback" };
  const recoveryFor = (gate) => shipGateRecovery({ gates: [gate], fallback }).command;

  assert.equal(recoveryFor(driftedGate({ approvals: [] })), "legion approve surface --approver <id>");

  assert.equal(
    recoveryFor(
      gateFor({
        contract: REAL_INTERFACE_TASK,
        items: PASSING_ITEMS,
        change: { changeId: CHANGE_ID, verifyPin: () => "match" }
      })
    ),
    "legion build",
    "declared but never exercised"
  );

  assert.equal(
    recoveryFor(gateFor({ contract: UNIT_ONLY, change: { changeId: CHANGE_ID, verifyPin: () => "match" } })),
    "legion start --intake",
    "an all-unit change needs a declaration, not a build"
  );

  assert.equal(
    recoveryFor(gateFor()),
    "legion start --intake",
    "a change that declares nothing needs a declaration, not a build"
  );
});

// --- the pin collector: each family individually falsifiable ---

test("every family of pinned reference a gate can ask about is collected", () => {
  // The collector lived inline in `ship.ts` behind a comment claiming an
  // end-to-end drift test could falsify a dropped family. Mutation testing
  // disproved it: `oracle-input.ts` copies the criterion's surface — the
  // identical `pinned` array — onto the oracle, and `resolvePinnedReferences`
  // dedupes by path, so either verification-surface collector alone resolved
  // every path the other would have. Deleting one reddened nothing anywhere.
  //
  // So the fixture deliberately breaks that parity: the contract and the oracle
  // pin *different* files. Each family is then asserted on its own, and deleting
  // any one line reddens exactly one assertion here.
  const references = shipGatePinnedReferences({
    deltas: [{ requirementId: "req_a", path: "delta.md", delta: { path: "delta.md", sha256: `sha256:${"1".repeat(64)}` } }],
    oracles: [
      {
        reference: { path: "oracle.yaml", sha256: `sha256:${"2".repeat(64)}` },
        document: {
          id: "orc_a",
          surface: { ...surface("integration"), pinned: [{ path: "ops/oracle-only.yml", sha256: `sha256:${"3".repeat(64)}` }] }
        }
      }
    ],
    approvals: [{ artifacts: [{ path: "ops/reaffirmed.yml", sha256: `sha256:${"4".repeat(64)}` }] }],
    tasks: [
      {
        verification: [
          {
            command: "pnpm",
            args: ["test"],
            surface: { ...surface("integration"), pinned: [{ path: "ops/contract-only.yml", sha256: `sha256:${"5".repeat(64)}` }] }
          }
        ]
      }
    ]
  });

  const paths = references.map((reference) => reference.path);
  assert.ok(paths.includes("delta.md"), "the delta spec family");
  assert.ok(paths.includes("oracle.yaml"), "the oracle document family");
  assert.ok(paths.includes("ops/oracle-only.yml"), "an oracle's declared surface");
  assert.ok(paths.includes("ops/contract-only.yml"), "a task contract's declared surface");
  assert.ok(paths.includes("ops/reaffirmed.yml"), "the bytes an approval was decided against");
});

test("an absent plane contributes no references rather than throwing", () => {
  // `legion ship` degrades every change plane to `undefined` when it cannot be
  // read, and this collector runs before any gate does. Throwing here would take
  // out the whole report on the artifact it exists to describe.
  assert.deepEqual(
    shipGatePinnedReferences({ deltas: undefined, oracles: undefined, approvals: undefined, tasks: [{}] }),
    []
  );
});

// --- the producer: what the pinned files held while the command ran ---

test("a passing command whose pinned file did not hold the declared bytes is mismatched", () => {
  // The epoch gap. The pins were hashed when the declaration was authored and
  // again at ship time, never while the command ran — so a `pass` established
  // "the declared bytes are on disk now" and "a command passed at some point",
  // and never that the command passed against the declared bytes. Overwrite the
  // compose file with one naming an in-memory fake, build, revert, ship: every
  // later hash agreed and the run had provably executed against the fake.
  const checks = verificationSurfaceChecks({
    task: {
      verification: [
        { command: "pnpm", args: ["test"], expectedExitCode: 0, surface: surface("real-interface") }
      ]
    },
    verification: { report: report({ commands: [command(0, "pnpm", ["test"])] }), passed: true },
    observePin: (path) => ({ path, sha256: `sha256:${"9".repeat(64)}` }),
    reaffirmedPin: () => false
  });

  assert.equal(checks[0].outcome, "mismatched");
  assert.notEqual(checks[0].outcome, "passed");
  assert.match(checks[0].note, /did not hold the declared bytes while it ran/);
  assert.deepEqual(checks[0].pins, [
    { path: COMPOSE_PIN.path, declared: COMPOSE_PIN.sha256, observed: `sha256:${"9".repeat(64)}` }
  ]);
});

test("a pinned file that could not be hashed during the run is mismatched, not passed", () => {
  const checks = verificationSurfaceChecks({
    task: {
      verification: [
        { command: "pnpm", args: ["test"], expectedExitCode: 0, surface: surface("real-interface") }
      ]
    },
    verification: { report: report({ commands: [command(0, "pnpm", ["test"])] }), passed: true },
    observePin: () => undefined,
    reaffirmedPin: () => false
  });

  assert.equal(checks[0].outcome, "mismatched");
  assert.equal(checks[0].pins[0].observed, undefined);
});

test("a run-time mismatch never upgrades an outcome, and never touches a unit surface", () => {
  // A command that failed stays `failed`: the operator's first problem is the
  // failure, and `passed` is the only outcome for which "checked against the
  // declared bytes" is load-bearing.
  const failing = verificationSurfaceChecks({
    task: {
      verification: [
        { command: "pnpm", args: ["test"], expectedExitCode: 0, surface: surface("real-interface") }
      ]
    },
    verification: {
      report: report({ commands: [command(0, "pnpm", ["test"])], failingIndices: [0] }),
      passed: false
    },
    observePin: (path) => ({ path, sha256: `sha256:${"9".repeat(64)}` }),
    reaffirmedPin: () => false
  });
  assert.equal(failing[0].outcome, "failed");

  // A unit surface's pins are never re-checked by the ship gate, so hashing them
  // here would record a fact nothing reads and let an unrelated edit downgrade an
  // item the gate does not consult.
  const unit = verificationSurfaceChecks({
    task: {
      verification: [{ command: "pnpm", args: ["test"], expectedExitCode: 0, surface: surface("unit") }]
    },
    verification: { report: report({ commands: [command(0, "pnpm", ["test"])] }), passed: true },
    observePin: () => {
      throw new Error("a unit surface's pins must not be hashed at run time");
    },
    reaffirmedPin: () => false
  });
  assert.equal(unit[0].outcome, "passed");
  assert.equal(unit[0].pins, undefined);
});

// --- the join: what build turns those outcomes into ---

test("an unrun declared surface is recorded unknown, never pass", () => {
  // The mutation that proved this untested: replacing the `unrun` arm with
  // `false`, so a declared real-interface surface nobody executed is recorded
  // `integration-surface-check: pass`, left all 812 tests in the tree green. The
  // two halves either side of this join were covered — `verificationSurfaceChecks`
  // returns `unrun` correctly, and the gate refuses to satisfy on an injected
  // `unknown` — and nothing exercised the step between them, which is the only
  // place those two facts meet.
  //
  // Its consequence is the whole fail-open: the pins are untouched so they still
  // answer `match`, the gate reads `pass`, and `legion ship` certifies at R2 that
  // verification reached a real interface for a run that ran nothing.
  assert.equal(integrationSurfaceVerdict([{ kind: "real-interface", outcome: "unrun" }]), "unknown");
  assert.notEqual(integrationSurfaceVerdict([{ kind: "real-interface", outcome: "unrun" }]), "pass");
});

test("a failed declared surface is recorded fail", () => {
  // Uncovered by the same gap: nothing in the tree drove a *failing* declared
  // non-unit surface through the producer at all, so `fail` was only ever
  // injected as a literal at the gate.
  assert.equal(integrationSurfaceVerdict([{ kind: "real-interface", outcome: "failed" }]), "fail");
});

test("a run-time pin mismatch is recorded unknown", () => {
  assert.equal(integrationSurfaceVerdict([{ kind: "integration", outcome: "mismatched" }]), "unknown");
});

test("a negative outranks a not-known, and every-passing is the only pass", () => {
  assert.equal(
    integrationSurfaceVerdict([
      { kind: "real-interface", outcome: "unrun" },
      { kind: "integration", outcome: "failed" }
    ]),
    "fail",
    "a failure an operator can act on outranks a question nobody answered"
  );
  assert.equal(
    integrationSurfaceVerdict([
      { kind: "real-interface", outcome: "passed" },
      { kind: "integration", outcome: "passed" }
    ]),
    "pass"
  );
  assert.equal(
    integrationSurfaceVerdict([
      { kind: "real-interface", outcome: "passed" },
      { kind: "integration", outcome: "unrun" }
    ]),
    "unknown",
    "one surface reaching its boundary does not answer for another that never ran"
  );
});

test("no non-unit check means no item at all, so the gate reads the declarations", () => {
  // `undefined` is "write nothing", and it must not be spellable as a verdict.
  // An all-unit answer expressed as a verdict would reach the gate through
  // `evidenceItemVerdict`, which collapses everything that is not `pass`/`fail`
  // to absence — so the explicit "nothing here crosses a boundary" would arrive
  // spelled exactly like silence.
  assert.equal(integrationSurfaceVerdict([]), undefined);
  assert.equal(integrationSurfaceVerdict([{ kind: "unit", outcome: "failed" }]), undefined);
});

test("bytes a human re-affirmed are accepted at run time, so the cure is not self-defeating", () => {
  // Without this the cure would unblock ship and block the next build. A
  // legitimately edited pinned file is re-affirmed at its *new* digest, but the
  // declaration on the task contract still records the old one — so a run-time
  // check comparing only against the declaration would record `mismatched` on
  // every build after a re-affirmation, forever, and leave the change blocked by
  // the command that exists to unblock it.
  const edited = `sha256:${"e".repeat(64)}`;
  const checks = verificationSurfaceChecks({
    task: {
      verification: [
        { command: "pnpm", args: ["test"], expectedExitCode: 0, surface: surface("real-interface") }
      ]
    },
    verification: { report: report({ commands: [command(0, "pnpm", ["test"])] }), passed: true },
    observePin: (path) => ({ path, sha256: edited }),
    reaffirmedPin: (path, sha256) => path === COMPOSE_PIN.path && sha256 === edited
  });

  assert.equal(checks[0].outcome, "passed");

  // And a digest nobody re-affirmed still mismatches, so the predicate is a
  // lookup rather than a switch that turns the check off.
  const unvouched = verificationSurfaceChecks({
    task: {
      verification: [
        { command: "pnpm", args: ["test"], expectedExitCode: 0, surface: surface("real-interface") }
      ]
    },
    verification: { report: report({ commands: [command(0, "pnpm", ["test"])] }), passed: true },
    observePin: (path) => ({ path, sha256: `sha256:${"f".repeat(64)}` }),
    reaffirmedPin: (path, sha256) => path === COMPOSE_PIN.path && sha256 === edited
  });
  assert.equal(unvouched[0].outcome, "mismatched");
});
