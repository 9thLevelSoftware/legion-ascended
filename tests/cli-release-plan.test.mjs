import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * `legion release plan`, driven through the real CLI against a real R3 change.
 *
 * The claim this file exists to hold is that the verb **cannot write a plan the
 * gate will refuse, and cannot report success over one**. Those are the two
 * halves of this series' third lesson, and the second half has gone unprotected
 * three times: a writer whose idea of "done" is weaker than the reader's idea of
 * "satisfied" exits 0, writes nothing, and leaves the change blocked forever with
 * no flag anywhere that would make it write.
 *
 * The fixture carries **two** executable criteria, so `legion plan` materialises
 * two tasks. One task would make every coverage assertion in this file vacuous:
 * the default covers everything, a partial cover is unreachable, and the gate's
 * quantifier could be deleted without anything failing.
 */

const CREATED_AT = "2026-08-04T12:00:00.000Z";
const COMPOSE_PATH = "ops/compose.integration.yml";
const HEALTH = "p99 quote latency stays under 400ms for 30 minutes after the cutover";
const TRIGGER = "quote error rate exceeds 1% over any 5 minute window";

const ANSWERS = {
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
  "req-1-ac-1-more": "true",
  "req-1-ac-2-statement": "A rejected quote is surfaced to the caller unchanged",
  "req-1-ac-2-proof": "executable",
  "req-1-ac-2-detail": "node --version",
  "req-1-ac-2-surface-kind": "real-interface",
  "req-1-ac-2-surface-interface": "POST /v1/quote/reject",
  "req-1-ac-2-surface-rationale":
    "The check drives a rejection through the running pricing service rather than a fake error path.",
  "req-1-ac-2-surface-pins": COMPOSE_PATH,
  "req-1-ac-2-more": "false",
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

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * A change planned, approved, built, reviewed and accepted — ship's own input.
 *
 * `tier` and `stopAfter` are parameters rather than a second copy of this
 * function because two of the three warnings this verb emits are only reachable
 * off the default path: `release_plan_gate_not_derived` needs a change no task of
 * which derives the gate, which means a tier below R3.
 */
async function preparedChange(t, options = {}) {
  const tier = options.tier ?? "R3";
  const root = await mkdtemp(path.join(tmpdir(), "legion-release-plan-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "core.autocrlf", "false"]);

  await mkdir(path.join(root, "ops"), { recursive: true });
  await writeFile(path.join(root, COMPOSE_PATH), "services:\n  pricing:\n    image: pricing:latest\n", "utf8");

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  await writeFile(
    path.join(root, "intake.json"),
    JSON.stringify({ ...ANSWERS, "risk-tier": tier }),
    "utf8"
  );
  assert.equal((await run("start", "--intake", "intake.json", "--created-at", CREATED_AT)).exitCode, 0);
  assert.equal((await run("start", "--finalize", "--json", "--created-at", CREATED_AT)).exitCode, 0);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "intake"]);
  assert.equal((await run("plan", "1", "--json")).exitCode, 0);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "plan"]);
  if (options.stopAfter === "plan") {
    const planOnlyChangeId = (await readdir(path.join(root, ".legion/project/changes")))[0];
    return {
      root,
      run,
      changeId: planOnlyChangeId,
      changeDir: path.join(root, ".legion/project/changes", planOnlyChangeId),
      taskIds: JSON.parse(
        await readFile(path.join(root, ".legion/project/changes", planOnlyChangeId, "taskgraph.json"), "utf8")
      ).tasks.map((task) => `tsk_${task.id.slice("ctr_".length)}`)
    };
  }
  assert.equal((await run("approve", "spec", "--approver", "dasbl", "--json")).exitCode, 0);
  assert.equal((await run("approve", "oracle", "--approver", "dasbl", "--json")).exitCode, 0);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "approve"]);
  assert.equal((await run("build", "--executor", "fake", "--json")).exitCode, 0);
  assert.equal((await run("review", "--executor", "fake", "--json")).exitCode, 0);
  assert.equal((await run("review", "--accept", "--approver", "dasbl", "--json")).exitCode, 0);

  const changeId = (await readdir(path.join(root, ".legion/project/changes")))[0];
  const changeDir = path.join(root, ".legion/project/changes", changeId);
  const taskgraph = JSON.parse(await readFile(path.join(changeDir, "taskgraph.json"), "utf8"));
  const taskIds = taskgraph.tasks.map((task) => `tsk_${task.id.slice("ctr_".length)}`);
  assert.equal(taskIds.length, 2, "the fixture needs two tasks, or every coverage assertion here is vacuous");
  return { root, run, changeId, changeDir, taskIds };
}

const PLAN = ["release", "plan", "--environment", "staging", "--rollback-strategy", "revert"];

test("bare legion release is a usage error, not a help screen", async (t) => {
  // **The defect this exists for, measured on the verb it was almost put under.**
  // `legion dev release plan --json` returns `{"ok": true, "status": "help"}` with
  // exit 0, because `handleReleaseCommand`'s switch ends in `helpResult`. A host
  // whose argv splits wrong would read that as a completed plan. So the workflow
  // verb refuses a missing subject and an unknown one, both with a non-zero exit,
  // and `--help` is the only thing that produces a help screen.
  const { run } = await preparedChange(t);

  const bare = await run("release", "--json");
  assert.equal(bare.exitCode, 1);
  const barePayload = parseJsonOutput(bare);
  assert.equal(barePayload.status, "usage_error");
  assert.match(barePayload.diagnostics[0].message, /legion release requires a subject/);
  assert.match(barePayload.diagnostics[0].message, /Supported subjects: plan/);

  const unknown = await run("release", "observe", "--json");
  assert.equal(unknown.exitCode, 1);
  assert.match(parseJsonOutput(unknown).diagnostics[0].message, /Unknown release subject: legion release observe/);

  // And `--help` reaches the verb's own help rather than the generic workflow
  // list, which it would if the verb were missing from `COMMAND_SPECIFIC_HELP`.
  const help = await run("release", "--help");
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /legion release <subject>/);
  assert.match(help.stdout, /--health-criterion/);
});

test("a plan with no health criterion is refused, and nothing is written", async (t) => {
  // **The writer holding the reader's floor.** `releaseSchema` does not bound
  // `healthCriteria`, so a plan with none parses and would be written — and
  // `release_observation_plan` reads it as `unsatisfied`, so the command would
  // exit 0 and leave ship blocked forever. The same argument covers the rollback
  // criteria, which the schema does bound: a refusal here names the decision, and
  // a schema failure at the write would name a field.
  const { run, changeDir } = await preparedChange(t);

  const noHealth = await run(...PLAN, "--rollback-criterion", TRIGGER, "--json");
  assert.equal(noHealth.exitCode, 1);
  const healthPayload = parseJsonOutput(noHealth);
  assert.equal(healthPayload.status, "blocked");
  assert.equal(healthPayload.diagnostics[0].code, "health_criteria_required");
  assert.match(healthPayload.diagnostics[0].message, /plans a release nothing would be observed against/);
  // Authored, never derived: the refusal says so, because deriving criteria from
  // the task graph would satisfy the gate by the act of running the command.
  assert.match(healthPayload.diagnostics[0].message, /authored, never derived/);

  const noRollback = await run(...PLAN, "--health-criterion", HEALTH, "--json");
  assert.equal(noRollback.exitCode, 1);
  assert.equal(parseJsonOutput(noRollback).diagnostics[0].code, "rollback_criteria_required");

  assert.equal(await exists(path.join(changeDir, "release.json")), false, "a refused plan must write nothing");
});

test("the environment and the rollback strategy have no defaults", async (t) => {
  // The defect: a default environment would make one plan answer for a `local`
  // rollout and a `production` one, which observe different things. A default
  // strategy would put a rollback route in a governance artifact that nobody
  // chose. Both are refused, and an unrecognised value is a usage error against
  // the protocol's own enum rather than a hand-written list.
  const { run } = await preparedChange(t);

  const noEnv = await run(
    "release",
    "plan",
    "--rollback-strategy",
    "revert",
    "--health-criterion",
    HEALTH,
    "--rollback-criterion",
    TRIGGER,
    "--json"
  );
  assert.equal(noEnv.exitCode, 1);
  assert.equal(parseJsonOutput(noEnv).diagnostics[0].code, "environment_required");

  const noStrategy = await run(
    "release",
    "plan",
    "--environment",
    "staging",
    "--health-criterion",
    HEALTH,
    "--rollback-criterion",
    TRIGGER,
    "--json"
  );
  assert.equal(noStrategy.exitCode, 1);
  assert.equal(parseJsonOutput(noStrategy).diagnostics[0].code, "rollback_strategy_required");

  const badEnv = await run(
    "release",
    "plan",
    "--environment",
    "prod",
    "--rollback-strategy",
    "revert",
    "--health-criterion",
    HEALTH,
    "--rollback-criterion",
    TRIGGER,
    "--json"
  );
  assert.equal(badEnv.exitCode, 1);
  assert.match(parseJsonOutput(badEnv).diagnostics[0].message, /Unknown release environment: --environment prod/);

  const badStrategy = await run(...PLAN.slice(0, 4), "--rollback-strategy", "rollback", "--health-criterion", HEALTH, "--rollback-criterion", TRIGGER, "--json");
  assert.equal(badStrategy.exitCode, 1);
  assert.match(
    parseJsonOutput(badStrategy).diagnostics[0].message,
    /Unknown rollback strategy: --rollback-strategy rollback/
  );
});

test("a --covers naming a task this change does not have is refused by name", async (t) => {
  // The defect: claiming to observe a task Legion cannot show you observes
  // nothing, and the gate would report the real tasks uncovered while the payload
  // said the plan covered one. The same diagnostic code `legion attest` uses, so a
  // host routes on one vocabulary rather than two.
  const { run, changeDir } = await preparedChange(t);

  const refused = await run(...PLAN, "--health-criterion", HEALTH, "--rollback-criterion", TRIGGER, "--covers", "tsk_not-in-this-change", "--json");
  assert.equal(refused.exitCode, 1);
  const payload = parseJsonOutput(refused);
  assert.equal(payload.diagnostics[0].code, "task_not_in_change");
  assert.match(payload.diagnostics[0].message, /is not a task of chg_/);
  assert.equal(await exists(path.join(changeDir, "release.json")), false);
});

test("--dry-run reports what would be recorded and writes nothing", async (t) => {
  // The defect: a dry run that writes is a dry run nobody can trust, and a dry run
  // that resolves nothing answers "yes" to a mistyped input — `legion approve`'s
  // recorded fifth defect. Both directions are asserted: the payload is fully
  // resolved, and the file is absent afterwards.
  const { run, changeDir, taskIds } = await preparedChange(t);

  const dry = await run(...PLAN, "--health-criterion", HEALTH, "--rollback-criterion", TRIGGER, "--dry-run", "--json");
  assert.equal(dry.exitCode, 0, dry.stdout + dry.stderr);
  const payload = parseJsonOutput(dry);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.release.action, "record");
  assert.deepEqual(payload.release.covers.slice().sort(), taskIds.slice().sort());
  assert.deepEqual(payload.release.healthCriteria, [HEALTH]);
  assert.equal(payload.release.releaseIntent.path, `.legion/project/changes/${payload.change.changeId}/taskgraph.json`);
  assert.equal(await exists(path.join(changeDir, "release.json")), false, "a dry run must write nothing");
});

test("a recorded plan satisfies the gate end to end, and re-running it records nothing", async (t) => {
  // **The only thing that proves the writer and the reader agree.** Every
  // assertion in tests/release-plan-gate hands the gate a fact set built by hand;
  // this drives the real verb, lets it write a real artifact, and asks `legion
  // ship` — which re-reads that artifact off disk through `readRelease` — whether
  // the gate moved. A writer that recorded something the reader will not accept
  // passes every unit test in the tree and fails here.
  const { run, changeDir, taskIds } = await preparedChange(t);

  const before = parseJsonOutput(await run("ship", "--json"));
  const blocked = before.diagnostics.find((entry) => entry.gate === "release_observation_plan");
  assert.notEqual(blocked, undefined, "the fixture must start from an unmet gate");
  assert.match(blocked.message, /No release plan is recorded for change chg_/);

  const planned = await run(...PLAN, "--health-criterion", HEALTH, "--rollback-criterion", TRIGGER, "--json");
  assert.equal(planned.exitCode, 0, planned.stdout + planned.stderr);
  const payload = parseJsonOutput(planned);
  assert.equal(payload.status, "planned");
  assert.equal(payload.release.action, "record");
  assert.equal(payload.release.status, "requested");
  assert.equal(payload.warnings, undefined, "the change derives the gate and the plan covers it");
  assert.equal(payload.nextAction.command, "legion ship");

  // The artifact on disk, because the gate reads the file rather than the payload.
  const document = JSON.parse(await readFile(path.join(changeDir, "release.json"), "utf8"));
  assert.equal(document.kind, "release");
  assert.equal(document.environment, "staging");
  assert.deepEqual(document.taskRefs.slice().sort(), taskIds.slice().sort());

  const after = parseJsonOutput(await run("ship", "--json"));
  assert.equal(
    after.diagnostics.some((entry) => entry.gate === "release_observation_plan"),
    false,
    `the gate this release closed must be satisfied: ${JSON.stringify(after.diagnostics.map((e) => e.gate))}`
  );

  // **The idempotency claim, and the one this series has paid for four times.**
  // Re-running with the same criteria records nothing — and the answer is computed
  // by calling the gate's own exported predicate, so `unchanged` means the gate is
  // satisfied rather than that a file exists.
  const again = await run(...PLAN, "--health-criterion", HEALTH, "--rollback-criterion", TRIGGER, "--json");
  assert.equal(again.exitCode, 0, again.stdout + again.stderr);
  const againPayload = parseJsonOutput(again);
  assert.equal(againPayload.status, "unchanged");
  assert.equal(againPayload.release.action, "unchanged");

  // And a run with a different criterion is a re-record, not an "unchanged" that
  // silently discards what the operator typed.
  const rewritten = await run(...PLAN, "--health-criterion", "error budget burn stays under 2% for the first hour", "--rollback-criterion", TRIGGER, "--json");
  assert.equal(rewritten.exitCode, 0, rewritten.stdout + rewritten.stderr);
  assert.equal(parseJsonOutput(rewritten).release.action, "re-record");
  const rewrittenDocument = JSON.parse(await readFile(path.join(changeDir, "release.json"), "utf8"));
  assert.deepEqual(rewrittenDocument.healthCriteria, ["error budget burn stays under 2% for the first hour"]);
});

test("a plan that covers half the change warns, and ship reports the gate unsatisfied", async (t) => {
  // **The writer and the reader agreeing about a partial cover.** The command
  // exits 0, says what it left out, and `legion ship` then reports exactly that. A
  // change with one task could not measure this at all, which is why the fixture
  // carries two.
  //
  // **Two warnings rather than one, and the split is the repair of a false
  // sentence.** `release_plan_partial_coverage` used to end "ship will report it
  // unsatisfied while any of those is missing", computed over every task of the
  // change while the gate quantifies over the tasks that *derive* it — so on a
  // mixed-tier task graph the command promised a verdict the gate would not give.
  // The coverage warning now states the coverage fact, and the verdict comes from
  // `release_plan_gate_unmet`, which is the gate's own sentence about this exact
  // document. The two are asserted together here because a prediction and the
  // thing predicted are only worth anything side by side.
  const { run, taskIds } = await preparedChange(t);

  const planned = await run(...PLAN, "--health-criterion", HEALTH, "--rollback-criterion", TRIGGER, "--covers", taskIds[0], "--json");
  assert.equal(planned.exitCode, 0, planned.stdout + planned.stderr);
  const payload = parseJsonOutput(planned);
  assert.equal(payload.status, "planned", "a partial plan is a real governance fact and is still recorded");
  const warning = payload.warnings.find((entry) => entry.code === "release_plan_partial_coverage");
  assert.notEqual(warning, undefined, "the operator has to learn this at the moment they could still act on it");
  assert.match(warning.message, new RegExp(taskIds[1]));
  assert.match(warning.message, /quantifies over the tasks of this change that derive it/);
  assert.doesNotMatch(
    warning.message,
    /ship will report it unsatisfied/,
    "this warning must not predict a verdict it computes over a different set than the gate"
  );

  const shipped = parseJsonOutput(await run("ship", "--json"));
  const row = shipped.diagnostics.find((entry) => entry.gate === "release_observation_plan");
  assert.notEqual(row, undefined, "the warning must be true, or it teaches operators to ignore warnings");
  assert.equal(row.code, "risk_gate_unsatisfied");
  assert.match(row.message, new RegExp(`leaving ${taskIds[1]} uncovered`));

  // And the gate-unmet warning said so before the ship did, in the same words.
  const unmet = payload.warnings.find((entry) => entry.code === "release_plan_gate_unmet");
  assert.notEqual(unmet, undefined, "an exit 0 that leaves ship blocked has to say so");
  assert.match(unmet.message, new RegExp(`leaving ${taskIds[1]} uncovered`));

  // And the advertised repair actually repairs it — this series' first lesson, run
  // rather than reasoned about.
  const repaired = await run(...PLAN, "--health-criterion", HEALTH, "--rollback-criterion", TRIGGER, "--json");
  assert.equal(repaired.exitCode, 0, repaired.stdout + repaired.stderr);
  assert.equal(parseJsonOutput(repaired).release.action, "re-record");
  const afterShip = parseJsonOutput(await run("ship", "--json"));
  assert.equal(
    afterShip.diagnostics.some((entry) => entry.gate === "release_observation_plan"),
    false,
    "advice that exits 0 and leaves the gate blocked is the loop this series exists to close"
  );
});

test("a plan for an environment nothing is released into is recorded, warned about, and blocks", async (t) => {
  // **The route a review measured into a green R3 gate, closed at both ends.**
  // `environment` was read only to be quoted back in the satisfied sentence, so
  // `--environment local` with "someone will probably notice" as its health
  // criterion produced `legion ship` -> `status: "ready"`, ten satisfied gates,
  // `waivedGates: []`, `humanJudgementGates: []` and no warning: a way into an R3
  // gate that needs no named human, no waiver reason and no waiver entry, strictly
  // weaker than the audited `not_applicable` attestation that was supposed to be
  // the only other way in.
  //
  // Recorded rather than refused, on `release_plan_gate_not_derived`'s rule — a
  // local rollout is a true governance fact and refusing would make it
  // unrecordable — but an exit 0 that leaves ship blocked has to say so, in the
  // gate's own words, while the operator can still change the flag they typed.
  const { run, changeDir } = await preparedChange(t);

  const planned = await run(
    "release", "plan", "--environment", "local", "--rollback-strategy", "manual",
    "--health-criterion", "someone will probably notice",
    "--rollback-criterion", "we change our minds",
    "--json"
  );
  assert.equal(planned.exitCode, 0, planned.stdout + planned.stderr);
  const payload = parseJsonOutput(planned);
  assert.equal(payload.status, "planned");
  assert.equal(payload.release.environment, "local");
  const warning = payload.warnings.find((entry) => entry.code === "release_plan_gate_unmet");
  assert.notEqual(warning, undefined, "a plan the gate refuses must not be reported as a silent success");
  assert.match(warning.message, /names local as the environment it observes/);

  const shipped = parseJsonOutput(await run("ship", "--json"));
  const row = shipped.diagnostics.find((entry) => entry.gate === "release_observation_plan");
  assert.notEqual(row, undefined, "the warning must be true, or it teaches operators to ignore warnings");
  assert.equal(row.code, "risk_gate_unsatisfied");
  // The same sentence in both places, because the warning is the gate's own
  // verdict on this exact document rather than a prediction made beside it.
  const quoted = /names local as the environment it observes, and nothing is released into local/;
  assert.match(row.message, quoted);
  assert.match(warning.message, quoted);

  // And the advertised repair repairs it — lesson 1, run rather than reasoned
  // about. `--environment staging` is what the recovery names; re-planning at
  // `local` again would exit 0 and leave the gate exactly where it was.
  const repaired = await run(...PLAN, "--health-criterion", HEALTH, "--rollback-criterion", TRIGGER, "--json");
  assert.equal(repaired.exitCode, 0, repaired.stdout + repaired.stderr);
  const repairedPayload = parseJsonOutput(repaired);
  assert.equal(repairedPayload.release.action, "re-record");
  assert.equal(repairedPayload.warnings, undefined, "a plan the gate accepts warns about nothing");
  const after = parseJsonOutput(await run("ship", "--json"));
  assert.equal(
    after.diagnostics.some((entry) => entry.gate === "release_observation_plan"),
    false,
    "advice that exits 0 and leaves the gate blocked is the loop this series exists to close"
  );
  const document = JSON.parse(await readFile(path.join(changeDir, "release.json"), "utf8"));
  assert.equal(document.environment, "staging");
});

test("a release that failed or was taken back is refused, not re-planned green", async (t) => {
  // **The laundering route, measured end to end by a review of this release.**
  // `release_observation_plan` printed `legion release plan --environment <env>
  // --health-criterion <text>` as the cure for a `rolled_back` release, and
  // `shipGateRecovery` promotes that to `nextAction.command`. Running exactly it
  // exited 0, wrote a fresh `status: "requested"` document, dropped the
  // `rollbackEvidenceRefs` the schema had required for that status, and turned the
  // gate green — with no warning, no `waivedGates` entry and nothing anywhere in
  // the ship payload recording that a taken-back release had been replaced.
  //
  // Both halves are held: the writer refuses here, and the gate stops advertising
  // the command (tests/release-plan-gate, and the R3 milestone asserts
  // `nextAction.command` on the one fixture where this gate is the only unmet
  // one). A refusal alone would leave ship printing advice that fails; a recovery
  // change alone would leave the route open to anyone who typed the command.
  const { run, changeDir } = await preparedChange(t);
  const releasePath = path.join(changeDir, "release.json");

  assert.equal(
    (await run(...PLAN, "--health-criterion", HEALTH, "--rollback-criterion", TRIGGER, "--json")).exitCode,
    0
  );

  for (const negative of [
    { status: "rolled_back", rollbackEvidenceRefs: ["evd_rollback-of-the-failed-cutover"] },
    { status: "failed" }
  ]) {
    const planned = JSON.parse(await readFile(releasePath, "utf8"));
    const taken = `${JSON.stringify({ ...planned, ...negative }, null, 2)}\n`;
    await writeFile(releasePath, taken, "utf8");

    const refused = await run(...PLAN, "--health-criterion", HEALTH, "--rollback-criterion", TRIGGER, "--json");
    assert.equal(refused.exitCode, 1, `${negative.status}: ${refused.stdout}${refused.stderr}`);
    const payload = parseJsonOutput(refused);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.diagnostics[0].code, "release_records_negative");
    assert.match(payload.diagnostics[0].message, new RegExp(`records status "${negative.status}"`));
    assert.match(payload.diagnostics[0].message, /is how a recorded negative gets laundered/);
    assert.equal(payload.nextAction.command, "legion start --intake");
    assert.doesNotMatch(payload.nextAction.command, /release plan/);
    // Byte-for-byte: the refusal writes nothing, so the evidence the schema
    // required for that status is still there to be read.
    assert.equal(await readFile(releasePath, "utf8"), taken, `${negative.status}: nothing may be written`);

    const shipped = parseJsonOutput(await run("ship", "--json"));
    const row = shipped.diagnostics.find((entry) => entry.gate === "release_observation_plan");
    assert.equal(row.code, "risk_gate_unsatisfied", negative.status);
    assert.match(row.message, /recorded negative|taken back or needs a forward fix/);
  }
});

test("replacing a live release plan says which status it replaced", async (t) => {
  // **The warning that guarded the laundering route and had no test at all.** A
  // review disabled both this condition and `release_plan_gate_not_derived` and
  // measured the whole suite green, which meant the only sentence telling an
  // operator that a recorded release status had been replaced could be deleted
  // silently. The four statuses that record a failure or a rollback are now
  // refused outright, so what remains for this warning is the live ones — a
  // release under way, replaced by a fresh plan.
  const { run, changeDir } = await preparedChange(t);
  const releasePath = path.join(changeDir, "release.json");

  assert.equal(
    (await run(...PLAN, "--health-criterion", HEALTH, "--rollback-criterion", TRIGGER, "--json")).exitCode,
    0
  );
  const planned = JSON.parse(await readFile(releasePath, "utf8"));
  await writeFile(releasePath, `${JSON.stringify({ ...planned, status: "deployed" }, null, 2)}\n`, "utf8");

  // Re-planning with different criteria is a write, so the record moves and the
  // warning is true of this run.
  const replaced = await run(
    ...PLAN,
    "--health-criterion", "error budget burn stays under 2% for the first hour",
    "--rollback-criterion", TRIGGER,
    "--json"
  );
  assert.equal(replaced.exitCode, 0, replaced.stdout + replaced.stderr);
  const payload = parseJsonOutput(replaced);
  assert.equal(payload.release.action, "re-record");
  const warning = payload.warnings.find((entry) => entry.code === "release_plan_status_replaced");
  assert.notEqual(warning, undefined, "replacing a recorded release status must not be silent");
  assert.match(warning.message, /records status "deployed"/);
  assert.match(warning.message, /its bytes remain in the artifact's revision chain/);
  assert.equal(JSON.parse(await readFile(releasePath, "utf8")).status, "requested");

  // And a rerun that writes nothing does not claim to have replaced anything: the
  // record is back at `requested`, the criteria match, and the whole run is a
  // no-op. A warning attached to a write that did not happen is the same class of
  // false sentence as a warning that mispredicts the gate.
  const again = await run(
    ...PLAN,
    "--health-criterion", "error budget burn stays under 2% for the first hour",
    "--rollback-criterion", TRIGGER,
    "--json"
  );
  const againPayload = parseJsonOutput(again);
  assert.equal(againPayload.release.action, "unchanged");
  assert.equal(againPayload.warnings, undefined);
});

test("a change no task of which derives the gate is told the plan moves nothing", async (t) => {
  // **The other untested warning.** An R2 operator who runs this verb gets a real
  // artifact and no gate movement; without the warning they are told a plan was
  // recorded and left to believe a gate moved. Refusing instead would make a true
  // governance fact unrecordable, which is `attestation_kind_has_no_reader`'s
  // settled position — so the sentence is the whole mechanism, and it had no test.
  //
  // The tier is the only difference from every other fixture here, and the two
  // assertions at the end are what make it a check rather than a transcription:
  // `legion ship` on this change reports no `release_observation_plan` row at all,
  // because R2 does not derive it.
  const { run, changeId, changeDir } = await preparedChange(t, { tier: "R2", stopAfter: "plan" });

  const planned = await run(...PLAN, "--health-criterion", HEALTH, "--rollback-criterion", TRIGGER, "--json");
  assert.equal(planned.exitCode, 0, planned.stdout + planned.stderr);
  const payload = parseJsonOutput(planned);
  assert.equal(payload.status, "planned");
  const warning = payload.warnings.find((entry) => entry.code === "release_plan_gate_not_derived");
  assert.notEqual(warning, undefined, "an operator told nothing would believe a gate moved");
  assert.match(warning.message, new RegExp(`No task of ${changeId} derives release_observation_plan`));
  assert.match(warning.message, /It is a true governance fact and is preserved/);
  // Preserved, as the sentence says.
  assert.equal(
    JSON.parse(await readFile(path.join(changeDir, "release.json"), "utf8")).kind,
    "release",
    "the plan is written whatever tier the change is"
  );
  // And no gate-unmet warning beside it: the gate this change does not derive is
  // not one this run can promise anything about.
  assert.equal(
    payload.warnings.some((entry) => entry.code === "release_plan_gate_unmet"),
    false
  );

  const shipped = parseJsonOutput(await run("ship", "--json"));
  assert.equal(
    (shipped.diagnostics ?? []).some((entry) => entry.gate === "release_observation_plan"),
    false,
    "R2 derives no release_observation_plan row, which is why the warning is the only signal"
  );
});

test("a release.json that will not read is not overwritten, and ship names the file", async (t) => {
  // The defect: writing over an unread record is the one way to silently replace a
  // failed release with a fresh plan. The verb refuses, and `legion ship` reports
  // it as its own diagnostic rather than as a plane skip — a plane holding one
  // document has no listing, so "N files under this directory were skipped" would
  // be a false sentence about it.
  const { run, changeDir } = await preparedChange(t);

  await writeFile(path.join(changeDir, "release.json"), "{\n", "utf8");

  const refused = await run(...PLAN, "--health-criterion", HEALTH, "--rollback-criterion", TRIGGER, "--json");
  assert.equal(refused.exitCode, 1);
  const payload = parseJsonOutput(refused);
  assert.equal(payload.status, "blocked");
  assert.match(payload.nextAction.reason, /Writing over an unread record/);
  assert.equal(await readFile(path.join(changeDir, "release.json"), "utf8"), "{\n", "the file must be untouched");

  const shipped = parseJsonOutput(await run("ship", "--json"));
  const document = shipped.diagnostics.find((entry) => entry.code === "artifact_document_unreadable");
  assert.notEqual(document, undefined, "the operator has no other way to learn the file is unreadable");
  assert.match(document.message, /release\.json is present and could not be read/);
  const gate = shipped.diagnostics.find((entry) => entry.gate === "release_observation_plan");
  assert.equal(gate.code, "risk_gate_unevaluable");
  assert.match(gate.message, /could not be read as a release plan/);

  // **The advertised repair, run rather than reasoned about.** The verdict's
  // recovery is `legion ship` with "correct or remove the file by hand, then
  // rerun this to confirm" — so the file is removed, a plan is written, and the
  // gate is asked again. Advice that leaves the state where it was is the loop
  // this series exists to close, and this is the only arm whose cure is an edit
  // no verb performs.
  await rm(path.join(changeDir, "release.json"));
  const replanned = await run(...PLAN, "--health-criterion", HEALTH, "--rollback-criterion", TRIGGER, "--json");
  assert.equal(replanned.exitCode, 0, replanned.stdout + replanned.stderr);
  const repaired = parseJsonOutput(await run("ship", "--json"));
  assert.equal(
    repaired.diagnostics.some((entry) => entry.code === "artifact_document_unreadable"),
    false
  );
  assert.equal(
    repaired.diagnostics.some((entry) => entry.gate === "release_observation_plan"),
    false
  );
});

test("the waiver route satisfies the gate and ship echoes it as a waiver", async (t) => {
  // **The other producer, end to end**, and the one arm of this gate that
  // satisfies with nothing falsifiable behind it. A satisfied gate emits no
  // diagnostic at all, so a waiver that did not reach `payload.warnings` and the
  // human render would be the quietest thing in a ready payload.
  //
  // `--verdict pass` on this kind is refused in the same test, because a pass
  // beside the artifact route would be a second, strictly weaker route into the
  // gate: the operator who authors a real plan and the one who writes a sentence
  // would become indistinguishable.
  const { root, run } = await preparedChange(t);

  await mkdir(path.join(root, "docs/decisions"), { recursive: true });
  const basis = "docs/decisions/release-not-applicable.md";
  await writeFile(
    path.join(root, basis),
    "# This change deploys nothing\n\nIt ships a documentation correction and touches no running service.\n",
    "utf8"
  );

  const refusedPass = await run(
    "attest",
    "release-observation",
    "--attested-by",
    "dasbl",
    "--verdict",
    "pass",
    "--source",
    basis,
    "--json"
  );
  assert.equal(refusedPass.exitCode, 1);
  assert.equal(parseJsonOutput(refusedPass).diagnostics[0].code, "kind_has_no_evidence_shape");

  const waived = await run(
    "attest",
    "release-observation",
    "--attested-by",
    "dasbl",
    "--verdict",
    "not_applicable",
    "--waiver-reason",
    "This change ships a documentation correction and deploys nothing at all.",
    "--source",
    basis,
    "--json"
  );
  assert.equal(waived.exitCode, 0, waived.stdout + waived.stderr);

  const shipped = parseJsonOutput(await run("ship", "--json"));
  assert.equal(
    shipped.diagnostics.some((entry) => entry.gate === "release_observation_plan"),
    false,
    "the audited waiver is the route out for a change that deploys nothing"
  );
  const warning = shipped.warnings.find(
    (entry) => entry.code === "risk_gate_waived" && entry.message.includes("release_observation_plan")
  );
  assert.notEqual(warning, undefined, "a gate satisfied with nothing checked must not be the quietest thing here");
  assert.match(warning.message, /was satisfied by an audited waiver rather than by evidence/);
});
