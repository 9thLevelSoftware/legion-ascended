import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  changeAcceptancePathDeclarations,
  deriveShipGates,
  isLiveProtectedPathsModifyGrant
} from "../packages/cli/dist/workflow/ship-gates.js";
import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * `protected_acceptance_tests`, arm by arm.
 *
 * ADR-006's R3 question is whether the acceptance tests can be weakened by the
 * implementer. Nothing could answer it: `oracle.protectedPaths` is `.min(1)` and
 * every writer sets it to the change artifact — a path inside the control plane,
 * which the guarded harness restores on every run — and nothing anywhere read it.
 * So the gate fell through `evaluateGate`'s `default:` arm and reported
 * `unevaluable` for every input whatsoever.
 *
 * The transcript in tests/ship-risk-gates records the four verdicts this release
 * moves. What a transcript of statuses cannot hold is the distinction between two
 * `unevaluable`s, and this gate has six of them with six different cures — so the
 * assertions here are on the *sentences* as much as on the statuses. A
 * status-only suite passes against a build that answers `unevaluable` for
 * everything, which is precisely the build this release replaces.
 *
 * The second half drives the whole chain through the real commands, because the
 * arms above cannot see the two things that only exist between packages: that
 * `legion approve protected-paths` writes a document this gate accepts, and what
 * the decision's ordering against the run does to an operator who follows the
 * tool's own advice. A writer whose idea of "decided" is weaker than the reader's
 * idea of "satisfied" exits 0 and leaves ship blocked forever, which is the
 * defect this series has now paid for four times.
 */

const TASK_ID = "tsk_phase-1";
const CHANGE_ID = "chg_gate";
const ORACLE_ID = "orc_gate-c1";
const OTHER_ORACLE_ID = "orc_gate-c2";
const ACCEPTANCE_PATH = "tests/pricing.test.mjs";
const OTHER_PATH = "tests/quoting.test.mjs";
const ORACLE_PIN = {
  path: `.legion/project/changes/${CHANGE_ID}/oracle/${ORACLE_ID}.yaml`,
  sha256: `sha256:${"a".repeat(64)}`
};
const OTHER_PIN = {
  path: `.legion/project/changes/${CHANGE_ID}/oracle/${OTHER_ORACLE_ID}.yaml`,
  sha256: `sha256:${"b".repeat(64)}`
};
const EXECUTION_STARTED_AT = "2026-08-02T09:00:00.000Z";
const DECIDED_BEFORE_AT = "2026-08-01T12:00:00.000Z";
const EVALUATED_AT = "2026-08-10T00:00:00.000Z";

// `declares: false` writes no field at all, which is what an oracle planned
// before this release looks like. A default parameter would silently substitute
// the declared set, so the two states are spelled with a separate flag.
function oracle({ id = ORACLE_ID, reference = ORACLE_PIN, acceptancePaths = [ACCEPTANCE_PATH], declares = true } = {}) {
  return { document: { id, ...(declares ? { acceptancePaths } : {}) }, reference };
}

function item(verdict, coverage = [{ oracleId: ORACLE_ID, path: ACCEPTANCE_PATH }]) {
  return {
    id: "protected-acceptance-paths",
    verdict,
    artifact: { path: `.legion/project/changes/${CHANGE_ID}/runs/run_1/protected-paths.json` },
    traceRefs: coverage.map((entry) => ({
      path: entry.path,
      entity: { kind: "oracle", id: entry.oracleId }
    }))
  };
}

function entries(items) {
  return [{ evidence: { id: "evd_1", taskId: TASK_ID, items } }];
}

function grant({
  id = "apv_gate-protected-paths",
  oracleId = ORACLE_ID,
  pin = ORACLE_PIN,
  pins = true,
  status = "granted",
  decidedAt = DECIDED_BEFORE_AT,
  decidedBy = { kind: "human", id: "dasbl" },
  action = "oracle.protected-paths.modify",
  expiresAt
} = {}) {
  return {
    id,
    changeId: CHANGE_ID,
    status,
    scope: { action, targets: [{ kind: "oracle", id: oracleId }] },
    ...(pins ? { artifacts: [pin] } : {}),
    decidedBy,
    decidedAt,
    ...(expiresAt === undefined ? {} : { expiresAt })
  };
}

const RUNS = [{ id: "run_1", taskId: TASK_ID, startedAt: EXECUTION_STARTED_AT }];

function facts(overrides = {}) {
  return {
    changeId: CHANGE_ID,
    acceptance: undefined,
    approvals: undefined,
    attestations: undefined,
    reviews: undefined,
    deltas: undefined,
    oracles: [oracle()],
    taskRuns: undefined,
    release: undefined,
    evaluatedAt: EVALUATED_AT,
    verifyPin: () => "match",
    classifySource: () => ({ kind: "unrecognised" }),
    ...overrides
  };
}

function gate({ items = [item("pass")], change = facts() } = {}) {
  const report = deriveShipGates({
    tasks: [{ id: "ctr_phase-1", risk: { tier: "R3", reasons: ["test"] } }],
    taskIdFor: () => TASK_ID,
    entries: entries(items),
    reviews: [],
    change
  });
  return report.gates.find((row) => row.gate === "protected_acceptance_tests");
}

test("an oracle plane that would not read is unestablished, never 'nothing is protected'", () => {
  // The all-or-nothing rule, stated as a verdict. "Every declared path is
  // unchanged" is trivially true of a list that lost the oracle protecting the
  // touched one, so a plane that came back short has to answer differently from a
  // plane that came back empty.
  const row = gate({ change: facts({ oracles: undefined }) });
  assert.equal(row.status, "unevaluable");
  assert.match(row.reason, /could not be read as a complete set/);
  assert.equal(row.recovery.command, "legion ship");
});

test("no oracle declaring a path is unevaluable, with its own sentence and its own cure", () => {
  // The branch every change on disk today is in, and the one a vacuous quantifier
  // reports `satisfied` for. It is decided from the *declarations* rather than
  // from any verdict, because it is a property of the plan: a run cannot answer a
  // question nobody asked, and the item is written at build time while a replan
  // can declare one afterwards.
  const row = gate({ change: facts({ oracles: [oracle({ declares: false })] }) });
  assert.equal(row.status, "unevaluable");
  assert.match(row.reason, /No oracle in this change declares a protected acceptance path/);
  assert.match(row.reason, /Nobody said, so nothing is known/);
  // The cure is authoring, not approving: an approval must predate a run, and
  // advising one here would send an operator who has built through a one-way door.
  assert.equal(row.recovery.command, "legion start --intake");
});

test("an empty acceptancePaths array is treated as no declaration, not as a satisfied set", () => {
  // `[].every(...)` is `true`. The schema makes the field `.min(1)` when present,
  // so this shape is unreachable from a parsed document — and this function's
  // parameter type admits it, which is exactly when a fail-open produced by a
  // shape rather than by a mistake ships.
  const row = gate({ change: facts({ oracles: [oracle({ acceptancePaths: [] })] }) });
  assert.equal(row.status, "unevaluable");
  assert.match(row.reason, /No oracle in this change declares a protected acceptance path/);
});

test("a declaration with no item in the task's latest evidence is unevaluable, and the cure is a build", () => {
  const row = gate({ items: [] });
  assert.equal(row.status, "unevaluable");
  assert.match(row.reason, /records no protected-acceptance-paths item/);
  assert.match(row.reason, new RegExp(ACCEPTANCE_PATH.replace(".", "\\.")));
  assert.equal(row.recovery.command, "legion build");
});

test("a declaration the run never snapshotted is unevaluable, not covered by the pass beside it", () => {
  // The stale-pass arm. The item is written at build time and stays `pass`
  // forever; a replan that adds a second protected path afterwards would
  // otherwise be answered by a run that never hashed it. The trace references
  // record which declarations the run actually covered, so the gate can tell.
  const row = gate({
    items: [item("pass", [{ oracleId: ORACLE_ID, path: ACCEPTANCE_PATH }])],
    change: facts({
      oracles: [oracle(), oracle({ id: OTHER_ORACLE_ID, reference: OTHER_PIN, acceptancePaths: [OTHER_PATH] })]
    })
  });
  assert.equal(row.status, "unevaluable");
  assert.match(row.reason, /covered by no pre-run snapshot/);
  assert.match(row.reason, new RegExp(OTHER_ORACLE_ID));
  assert.equal(row.recovery.command, "legion build");
});

test("an unknown observation is unevaluable and cites the report, never folded into a pass", () => {
  // A path neither side of the dispatch could resolve is a path this run cannot
  // say anything about. Folding it into `pass` would certify an acceptance test
  // the run may have created and immediately weakened, which is the third
  // fail-open this gate's `unevaluable` arm exists for.
  const row = gate({ items: [item("unknown")] });
  assert.equal(row.status, "unevaluable");
  assert.match(row.reason, /could not compare every protected acceptance path/);
  assert.match(row.reason, /protected-paths\.json/);
  // Lesson 1: this arm has two causes and `legion build` repairs only one of
  // them, so the recovery names the other. A rebuild re-reads the same deleted
  // predecessor report and answers `unknown` again forever.
  assert.match(row.recovery.reason, /restore it from\s+version control/);
});

test("the item is read through its own reader, so unknown is not spelled like silence", () => {
  // `evidenceItemVerdict` collapses every verdict that is not pass/fail to
  // `undefined`, which would make "a declared path could not be resolved"
  // indistinguishable from "no item was written". The two have different cures
  // and different sentences, so the distinction has to survive the read.
  const absent = gate({ items: [] });
  const unknown = gate({ items: [item("unknown")] });
  assert.equal(absent.status, "unevaluable");
  assert.equal(unknown.status, "unevaluable");
  assert.notEqual(absent.reason, unknown.reason);
});

test("a changed path with no decision behind it is unsatisfied, and the cure is not an approval", () => {
  const row = gate({
    items: [item("fail")],
    change: facts({ approvals: [], taskRuns: RUNS })
  });
  assert.equal(row.status, "unsatisfied");
  assert.match(row.reason, /no granted oracle\.protected-paths\.modify approval decided before run run_1/);
  assert.match(row.reason, new RegExp(ORACLE_ID));
  // Restoring the bytes re-dates nothing; approving now writes a later instant
  // and makes the state permanent. The recovery has to be the one that repairs
  // *this* state, which is the first lesson of this series.
  assert.equal(row.recovery.command, "legion build");
  assert.match(row.recovery.reason, /Approving now cannot help/);
});

test("a changed path with a decision taken before the run is satisfied, naming both instants", () => {
  const row = gate({
    items: [item("fail")],
    change: facts({ approvals: [grant()], taskRuns: RUNS })
  });
  assert.equal(row.status, "satisfied");
  assert.match(row.reason, new RegExp(DECIDED_BEFORE_AT));
  assert.match(row.reason, new RegExp(EXECUTION_STARTED_AT));
  assert.match(row.reason, /dasbl/);
});

test("a decision taken in the run's own millisecond is too late", () => {
  // `>=`, not `>`. Both stamps are millisecond wall-clock so the equal pair is
  // reachable, no honest writer produces it — `legion approve protected-paths`
  // writes no runs and `legion build` writes no approvals — and an unorderable
  // pair is not evidence that the decision came first.
  const row = gate({
    items: [item("fail")],
    change: facts({ approvals: [grant({ decidedAt: EXECUTION_STARTED_AT })], taskRuns: RUNS })
  });
  assert.equal(row.status, "unsatisfied");
  assert.match(row.reason, /taken at or after run run_1/);
});

test("a decision by a tool, a revoked one, and a lapsed one all fail to permit the change", () => {
  // The three rules `surfacePinReaffirmation` already pays for, reused rather
  // than re-argued. Each is checked separately because each is one line away from
  // being dropped, and dropping any of them satisfies this gate off a record
  // nobody stands behind.
  const byTool = gate({
    items: [item("fail")],
    change: facts({ approvals: [grant({ decidedBy: { kind: "tool", id: "legion-cli" } })], taskRuns: RUNS })
  });
  assert.equal(byTool.status, "unsatisfied");

  const revoked = gate({
    items: [item("fail")],
    change: facts({
      approvals: [
        grant(),
        grant({ id: "apv_gate-revocation", status: "revoked", decidedAt: "2026-08-01T18:00:00.000Z" })
      ],
      taskRuns: RUNS
    })
  });
  assert.equal(revoked.status, "unsatisfied", "a revocation strictly later than the grant stands");

  const lapsed = gate({
    items: [item("fail")],
    change: facts({ approvals: [grant({ expiresAt: "2026-08-02T00:00:00.000Z" })], taskRuns: RUNS })
  });
  assert.equal(lapsed.status, "unsatisfied", "an expiry before the evaluation instant is a spent decision");
});

test("a withdrawal recorded in the grant's own millisecond leaves the negative standing", () => {
  // `>=`, not `>`, on the standing-negative comparison — measured missing: the
  // suite's other revocation is six hours later and survives either operator.
  // PR 1's rule is that a negative stands unless a live grant is *strictly*
  // later, so the unorderable pair must not be read as the grant winning. Both
  // stamps are millisecond wall-clock, so the pair is reachable.
  const row = gate({
    items: [item("fail")],
    change: facts({
      approvals: [
        grant(),
        grant({ id: "apv_gate-revocation", status: "revoked", decidedAt: DECIDED_BEFORE_AT })
      ],
      taskRuns: RUNS
    })
  });
  assert.equal(row.status, "unsatisfied");
});

test("a decision pinning the oracle twice is refused rather than read by whichever pin came first", () => {
  // `artifacts` carries no uniqueness constraint, so a document pinning the right
  // digest beside a wrong one asserts two truths about one file. Measured
  // missing: relaxing the guard to take the first match reddened nothing, and
  // under it the grant would be accepted for oracle bytes the approver never
  // read. Both orders, because a `find` passes one of them.
  const wrongPin = { path: ORACLE_PIN.path, sha256: `sha256:${"c".repeat(64)}` };
  for (const artifacts of [[ORACLE_PIN, wrongPin], [wrongPin, ORACLE_PIN]]) {
    const row = gate({
      items: [item("fail")],
      change: facts({ approvals: [{ ...grant(), artifacts }], taskRuns: RUNS })
    });
    assert.equal(row.status, "unsatisfied", `two pins for one path must not permit the change (${artifacts[0].sha256})`);
  }
});

test("a decision pinned to bytes the oracle no longer carries does not permit the change", () => {
  // The pin is what stops the decision being a blanket exemption. Re-planning the
  // oracle to protect a *different* set of tests must invalidate the grant rather
  // than silently extend it to paths nobody looked at.
  const row = gate({
    items: [item("fail")],
    change: facts({
      approvals: [grant({ pin: { path: ORACLE_PIN.path, sha256: `sha256:${"c".repeat(64)}` } })],
      taskRuns: RUNS
    })
  });
  assert.equal(row.status, "unsatisfied");
});

test("a decision about a different action or a different oracle answers for nothing", () => {
  const wrongAction = gate({
    items: [item("fail")],
    change: facts({ approvals: [grant({ action: "oracle.approve" })], taskRuns: RUNS })
  });
  assert.equal(wrongAction.status, "unsatisfied");

  const wrongOracle = gate({
    items: [item("fail")],
    change: facts({ approvals: [grant({ oracleId: OTHER_ORACLE_ID })], taskRuns: RUNS })
  });
  assert.equal(wrongOracle.status, "unsatisfied");
});

test("authorisation is required of every declaring oracle, not of some one of them", () => {
  // The evidence item carries a verdict and no touched-path set, so the gate
  // cannot know *which* path moved. A check of the form "some grant names some
  // oracle" would therefore bless the weakening of a path nobody approved. Every
  // declaring oracle must carry a live pre-run decision, and the sentence names
  // the ones that do not.
  const row = gate({
    items: [
      item("fail", [
        { oracleId: ORACLE_ID, path: ACCEPTANCE_PATH },
        { oracleId: OTHER_ORACLE_ID, path: OTHER_PATH }
      ])
    ],
    change: facts({
      oracles: [oracle(), oracle({ id: OTHER_ORACLE_ID, reference: OTHER_PIN, acceptancePaths: [OTHER_PATH] })],
      approvals: [grant()],
      taskRuns: RUNS
    })
  });
  assert.equal(row.status, "unsatisfied");
  assert.match(row.reason, new RegExp(OTHER_ORACLE_ID));
});

test("a changed path with an unreadable approvals plane is unevaluable, not unsatisfied", () => {
  // A dropped approval file is as likely to hold the grant as the revocation, so
  // nothing may be concluded from what the listing kept. `concealsNegative` is
  // deliberately not set: that field exists so one producer's `satisfied` cannot
  // outrank another producer's doubt inside a combination, and this gate has one
  // producer — on the `pass` arm no approval is needed at all, so the plane is
  // never consulted, and on this arm the doubt already blocks.
  const row = gate({ items: [item("fail")], change: facts({ approvals: undefined, taskRuns: RUNS }) });
  assert.equal(row.status, "unevaluable");
  assert.match(row.reason, /approvals recorded for this change could not be read/);
});

test("a changed path with no establishable run ordering is unevaluable, never 'the decision came first'", () => {
  const row = gate({ items: [item("fail")], change: facts({ approvals: [grant()], taskRuns: undefined }) });
  assert.equal(row.status, "unevaluable");
  assert.match(row.reason, /do not establish when execution began/);
  assert.equal(row.recovery.command, "legion ship");
});

test("an unchanged run is satisfied and names what it looked at", () => {
  const row = gate();
  assert.equal(row.status, "satisfied");
  // The sentence claims what the harness actually compared, which since
  // guarantee 7 is the state this change's *first* run recorded rather than
  // whatever the last attempt happened to leave. "Byte-identical before and
  // after this run" was true of the laundering sequence too.
  assert.match(row.reason, /still matches the state this change's first run recorded/);
  assert.match(row.reason, new RegExp(ACCEPTANCE_PATH.replace(".", "\\.")));
});

test("a verdict this gate does not recognise is unevaluable, never satisfied", () => {
  // Positive arms only. A `default:` that returned `satisfied` would ship an
  // unknown state, which is the fourth lesson of this series.
  const row = gate({ items: [item("not_applicable")] });
  assert.equal(row.status, "unevaluable");
  assert.match(row.reason, /cannot read as an answer/);
});

test("the gate is task-scoped: the run is a task's, so the verdict is too", () => {
  const row = gate();
  assert.equal(row.scope, "task");
  assert.equal(row.subjectId, TASK_ID);
});

test("the declaration set is the change's oracles, deduped and sorted, with absence a distinct state", () => {
  const unestablished = changeAcceptancePathDeclarations({ change: undefined });
  assert.equal(unestablished.unestablished, true);
  assert.deepEqual(unestablished.declarations, []);

  const read = changeAcceptancePathDeclarations({ change: facts({ oracles: [] }) });
  assert.equal(read.unestablished, false, "a plane read whole and empty is not a plane that would not read");
  assert.deepEqual(read.declarations, []);

  const both = changeAcceptancePathDeclarations({
    change: facts({
      oracles: [
        oracle({ id: OTHER_ORACLE_ID, reference: OTHER_PIN, acceptancePaths: [OTHER_PATH] }),
        oracle()
      ]
    })
  });
  assert.deepEqual(
    both.declarations.map((entry) => entry.oracleId),
    [ORACLE_ID, OTHER_ORACLE_ID]
  );
});

test("the writer's predicate is the reader's own, and answers no for every unmet arm", () => {
  // Lesson 3. `legion approve protected-paths` computes "is there anything left
  // to decide here" through this, so a writer whose idea of done is weaker than
  // the reader's idea of satisfied cannot report success, write nothing, and
  // leave the change permanently blocked.
  const subject = { approval: grant(), changeId: CHANGE_ID, oracle: oracle(), evaluatedAt: EVALUATED_AT };
  assert.equal(isLiveProtectedPathsModifyGrant(subject), true);

  assert.equal(
    isLiveProtectedPathsModifyGrant({ ...subject, changeId: "chg_other" }),
    false,
    "an approval about another change answers for nothing"
  );
  assert.equal(
    isLiveProtectedPathsModifyGrant({ ...subject, approval: grant({ action: "oracle.approve" }) }),
    false
  );
  assert.equal(
    isLiveProtectedPathsModifyGrant({ ...subject, approval: grant({ status: "revoked" }) }),
    false
  );
  assert.equal(
    isLiveProtectedPathsModifyGrant({
      ...subject,
      approval: grant({ decidedBy: { kind: "tool", id: "legion-cli" } })
    }),
    false
  );
  assert.equal(
    isLiveProtectedPathsModifyGrant({ ...subject, approval: grant({ pins: false }) }),
    false,
    "a decision pinning nothing does not say which declaration was read"
  );
  assert.equal(
    isLiveProtectedPathsModifyGrant({
      ...subject,
      approval: grant({ expiresAt: "2026-08-02T00:00:00.000Z" })
    }),
    false
  );
  // Deliberately *not* the ordering clause: including it here would make a
  // harmless rerun of the verb write a fresh `decidedAt` and turn a valid
  // ordering invalid. The gate applies ordering on top.
  assert.equal(
    isLiveProtectedPathsModifyGrant({ ...subject, approval: grant({ decidedAt: "2026-09-01T00:00:00.000Z" }) }),
    true
  );
});

// --- end to end, through the real commands ----------------------------------

const ACCEPTANCE_FILE = "acceptance.test.mjs";
const COMPOSE_PATH = "ops/compose.integration.yml";
const CREATED_AT = "2026-08-04T12:00:00.000Z";
const PLAN_ENV = "LEGION_FAKE_EXECUTOR_PLAN";

const R3_ANSWERS = {
  "project-name": "Order Router",
  "project-summary": "Routes orders to the pricing service.",
  "project-owner": "dasbl",
  "problem-statement": "Orders are priced against a stub, so drift ships.",
  "problem-users": "Payments engineers.",
  "problem-success": "A pricing change that breaks the contract fails before release.",
  "req-1-statement": "Orders are priced against the real pricing service",
  "req-1-priority": "must",
  "req-1-category": "behavior",
  "req-1-ac-1-statement": "A quote request reaches the running pricing service",
  "req-1-ac-1-proof": "executable",
  "req-1-ac-1-detail": "node --version",
  "req-1-ac-1-surface-kind": "real-interface",
  "req-1-ac-1-surface-interface": "POST /v1/quote",
  "req-1-ac-1-surface-rationale":
    "The check starts the pricing service and posts a real quote, with no HTTP stub in the path.",
  "req-1-ac-1-surface-pins": COMPOSE_PATH,
  "req-1-ac-1-acceptance-paths": ACCEPTANCE_FILE,
  "req-1-ac-1-more": "false",
  "req-1-more": "false",
  "non-goals": "Currency conversion",
  constraints: "TypeScript only",
  "risk-tier": "R3",
  "risk-reason": "A new surface other services depend on.",
  "budget-files": "20",
  "budget-lines": "2000",
  "budget-new-files": "10",
  "pref-verification": "legion validate"
};

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

/** An R3 change whose criterion protects an acceptance test, planned and committed. */
async function plannedR3(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-protected-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "core.autocrlf", "false"]);

  await mkdir(path.join(root, "ops"), { recursive: true });
  await writeFile(path.join(root, COMPOSE_PATH), "services:\n  pricing:\n    image: pricing:latest\n", "utf8");
  await writeFile(path.join(root, ACCEPTANCE_FILE), "assert(quote.price === 10);\n", "utf8");

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  await writeFile(path.join(root, "intake.json"), JSON.stringify(R3_ANSWERS), "utf8");
  assert.equal((await run("start", "--intake", "intake.json", "--created-at", CREATED_AT)).exitCode, 0);
  const finalized = await run("start", "--finalize", "--json", "--created-at", CREATED_AT);
  assert.equal(finalized.exitCode, 0, finalized.stdout + finalized.stderr);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "intake"]);
  const planned = await run("plan", "1", "--json");
  assert.equal(planned.exitCode, 0, planned.stdout + planned.stderr);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "plan"]);
  return { root, run };
}

async function withPlan(plan, fn) {
  process.env[PLAN_ENV] = JSON.stringify(plan);
  try {
    return await fn();
  } finally {
    delete process.env[PLAN_ENV];
  }
}

const GUTTING_PLAN = { writes: [{ path: ACCEPTANCE_FILE, content: "assert(true);\n" }] };

/** Build with a run that rewrites the protected test, review it, and ship. */
async function buildReviewShip(run, root, plan = GUTTING_PLAN) {
  const build = await withPlan(plan, () => run("build", "--executor", "fake", "--json"));
  assert.equal(build.exitCode, 0, build.stdout + build.stderr);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "build"]);
  assert.equal((await run("review", "--executor", "fake", "--json")).exitCode, 0);
  assert.equal((await run("review", "--accept", "--approver", "dasbl", "--json")).exitCode, 0);
  const shipped = await run("ship", "--json");
  const payload = parseJsonOutput(shipped);
  // The review and ship artifacts are committed too, so a caller can run a second
  // cycle without `--allow-dirty` — which is what an operator following the
  // gate's recovery does, and what the laundering test below has to drive.
  git(root, ["add", "-A"]);
  git(root, ["commit", "--allow-empty", "-m", "review and ship"]);
  return payload.diagnostics.find((entry) => entry.gate === "protected_acceptance_tests");
}

test("a run that edits a protected test with no decision behind it blocks ship, and the cure is not an approval", async (t) => {
  // The whole chain, through the real commands: an interview names the test, the
  // plan copies it onto the oracle, the harness hashes it either side of a
  // dispatch that rewrites it, the item records the change, and ship refuses.
  //
  // Every link is a separate spelling in a separate package, and nothing else in
  // the tree joins them: a rename on any one would leave every unit suite green
  // and the gate reporting "nobody declared one" on a repository that declared
  // one correctly.
  const { root, run } = await plannedR3(t);
  const row = await buildReviewShip(run, root);

  assert.notEqual(row, undefined, "the gate must be unmet");
  assert.equal(row.code, "risk_gate_unsatisfied");
  assert.match(row.message, /no granted oracle\.protected-paths\.modify approval decided before run/);
  // The bytes the run left are still there: this gate blocks a ship, and the
  // harness restores nothing.
  assert.equal(await readFile(path.join(root, ACCEPTANCE_FILE), "utf8"), "assert(true);\n");
});

test("a decision recorded before the build satisfies the gate, end to end", async (t) => {
  // Lesson 3, driven rather than reasoned about: the verb's idea of "decided"
  // has to be the gate's idea of "satisfied", or the command exits 0 and ship
  // stays blocked forever with no flag anywhere that would make it write.
  const { root, run } = await plannedR3(t);

  const decided = await run("approve", "protected-paths", "--approver", "dasbl", "--json");
  assert.equal(decided.exitCode, 0, decided.stdout + decided.stderr);
  const payload = parseJsonOutput(decided);
  assert.equal(payload.status, "approved");
  assert.deepEqual(payload.undecided, []);
  assert.deepEqual(payload.decisions[0].paths, [ACCEPTANCE_FILE]);
  // Nothing has run, so the routing is to the act this decision has to precede.
  assert.equal(payload.nextAction.command, "legion build");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "approve protected paths"]);

  // A rerun writes nothing, because `settled` is computed through the gate's own
  // predicate rather than a weaker paraphrase of it.
  const again = await run("approve", "protected-paths", "--approver", "dasbl", "--json");
  assert.equal(again.exitCode, 0);
  assert.equal(parseJsonOutput(again).status, "unchanged");

  const row = await buildReviewShip(run, root);
  assert.equal(row, undefined, "the gate must be satisfied once a prior decision permits the change");
});

test("the same decision taken after the build cannot rescue it, and the command says so", async (t) => {
  // The one-way door, driven end to end. The verb still writes — the record is a
  // true governance fact and refusing would leave no way to record one at all —
  // but it warns, and the gate's own recovery names restoring the bytes rather
  // than approving, because nothing re-orders a decision already taken.
  const { root, run } = await plannedR3(t);
  const blocked = await buildReviewShip(run, root);
  assert.equal(blocked.code, "risk_gate_unsatisfied");

  const late = await run("approve", "protected-paths", "--approver", "dasbl", "--json");
  assert.equal(late.exitCode, 0, late.stdout + late.stderr);
  const payload = parseJsonOutput(late);
  assert.equal(payload.status, "approved");
  assert.equal(
    payload.warnings.some((warning) => warning.code === "approval_after_execution"),
    true,
    "the operator has to be told the decision is dated after the work it claims to gate"
  );
  assert.match(payload.warnings[0].message, /protected_acceptance_tests/);
  assert.equal(payload.nextAction.command, "legion ship");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "late approval"]);

  const shipped = await run("ship", "--json");
  const row = parseJsonOutput(shipped).diagnostics.find(
    (entry) => entry.gate === "protected_acceptance_tests"
  );
  assert.notEqual(row, undefined, "approving afterwards must not satisfy the gate");
  assert.match(row.message, /taken at or after run/);
});

test("a second build does not launder a recorded weakening, and restoring the file does clear it", async (t) => {
  // The defect four reviewers drove independently against the compiled build,
  // using nothing but the real commands and the recovery this gate itself names.
  //
  // Attempt 1 guts the acceptance test; the item records `fail` and ship blocks,
  // naming `legion build` as part of the cure. Running that command *without*
  // restoring anything used to clear the block outright: attempt 2 took its own
  // pre-dispatch snapshot of the tree as it stood, so the gutted bytes became its
  // own `before`, it observed `unchanged`, recorded `pass`, and the gate — which
  // reads the latest attempt per task — reported satisfied. No approval, no
  // hand-written artifact, and the weakened assertion still on disk. It was the
  // same negatives-buried-by-positives shape `architecture_or_security_review`
  // reordered its arms to close, arriving through the evidence index instead of
  // through a gate's own arms.
  //
  // The three phases below are the whole claim: fail, fail again on a bare
  // rebuild, pass only once the bytes are actually back. The middle one is the
  // regression; the third is lesson 1 — the recovery has to repair the state, so
  // it is run and checked rather than asserted about.
  const { root, run } = await plannedR3(t);
  const original = await readFile(path.join(root, ACCEPTANCE_FILE), "utf8");

  const first = await buildReviewShip(run, root);
  assert.notEqual(first, undefined, "the run that gutted the test must block ship");
  assert.equal(first.code, "risk_gate_unsatisfied");

  // The gate's own recovery command, with nothing restored. The executor writes
  // nothing at all, so only the re-baselining could turn this green.
  const second = await buildReviewShip(run, root, { writes: [] });
  assert.notEqual(second, undefined, "a rebuild that restores nothing must not clear the gate");
  assert.match(second.message, /no granted oracle\.protected-paths\.modify approval decided before run/);
  assert.equal(await readFile(path.join(root, ACCEPTANCE_FILE), "utf8"), "assert(true);\n");

  // The other half of the recovery, the half that was never checked: put the
  // bytes back. Nothing else changes — no approval is written, no oracle is
  // replanned.
  await writeFile(path.join(root, ACCEPTANCE_FILE), original, "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "restore the acceptance test"]);
  const third = await buildReviewShip(run, root, { writes: [] });
  assert.equal(third, undefined, "restoring the path and rebuilding must clear the gate");
});

test("a rebuild cannot launder a run that authored the test deciding it either", async (t) => {
  // The same laundering reached through the `created` arm rather than the
  // `modified` one. A run that writes the acceptance test it is judged by is
  // `changed` by design — writing the bar is the same self-grading act as
  // lowering it — and under a per-attempt baseline the very next build saw the
  // file present on both sides and recorded `pass`. The anchor is `absent`, so it
  // stays `changed` until a human decides it.
  const { root, run } = await plannedR3(t);
  await rm(path.join(root, ACCEPTANCE_FILE));
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "remove the acceptance test"]);

  const created = await buildReviewShip(run, root, {
    writes: [{ path: ACCEPTANCE_FILE, content: "assert(quote.price === 10);\n" }]
  });
  assert.notEqual(created, undefined, "a run that authors its own acceptance test must block ship");

  const rebuilt = await buildReviewShip(run, root, { writes: [] });
  assert.notEqual(rebuilt, undefined, "a rebuild must not turn the creation into a clean run");
});

test("a decision that was withdrawn is decided again, because settled is the gate's own predicate", async (t) => {
  // Lesson 3's inverse, and the arm the suite was measured to be missing: the
  // `settled` computation in `legion approve protected-paths` reads through
  // `isLiveProtectedPathsModifyGrant`, and replacing that call with
  // `existing.ok` reddened nothing. A withdrawn decision is exactly the input the
  // two disagree about — the document exists and reads, so the weaker rule calls
  // it settled, exits 0 with "nothing to decide", writes nothing, and leaves
  // `protected_acceptance_tests` unsatisfiable with no flag anywhere that would
  // make the command write.
  const { root, run } = await plannedR3(t);
  const granted = await run("approve", "protected-paths", "--approver", "dasbl", "--json");
  assert.equal(granted.exitCode, 0, granted.stdout + granted.stderr);
  const approvalPath = path.join(
    root,
    ...parseJsonOutput(granted).decisions[0].artifactPath.split("/")
  );
  const document = JSON.parse(await readFile(approvalPath, "utf8"));
  document.status = "revoked";
  await writeFile(approvalPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  const again = await run("approve", "protected-paths", "--approver", "dasbl", "--json");
  assert.equal(again.exitCode, 0, again.stdout + again.stderr);
  const payload = parseJsonOutput(again);
  assert.equal(payload.status, "approved", "a withdrawn decision is not a live grant, so there is something to decide");
  assert.equal(payload.decisions[0].action, "regrant");
  assert.deepEqual(payload.undecided, []);
});

test("legion approve protected-paths refuses a change that declares none, rather than writing a record nothing reads", async (t) => {
  const { run } = await plannedR3(t);
  const named = await run(
    "approve",
    "protected-paths",
    "--oracle",
    "orc_not-here",
    "--approver",
    "dasbl",
    "--json"
  );
  assert.equal(named.exitCode, 1);
  assert.match(
    JSON.stringify(parseJsonOutput(named).diagnostics),
    /oracle_not_declaring_acceptance_paths/
  );
});
