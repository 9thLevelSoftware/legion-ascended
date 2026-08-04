import assert from "node:assert/strict";
import { test } from "node:test";

import { runDeterministicVerification } from "../dist/index.js";
import { makeFixtureContract } from "./dispatch-fixture.mjs";
import { makeFixtureWorkerContext, makePassingRunner } from "./review-fixture.mjs";

/**
 * Oracles are executed, not merely emitted.
 *
 * An executable oracle carries the command that decides an acceptance
 * criterion. Before this, that command ran only by coincidence: the planner
 * copies the same string into `task.verification`, so it executed as a
 * verification command and nothing tied the result back to the `orc_…` that
 * declared it. An oracle whose command drifted from the contract, or that was
 * never planned in, was never run at all while the task reported verified.
 */

function executableOracle(overrides = {}) {
  return {
    schemaVersion: "0.2.0",
    createdAt: "2026-08-04T00:00:00.000Z",
    kind: "oracle",
    id: "orc_criterion-one",
    projectId: "prj_fixture",
    title: "Criterion one holds",
    owner: { kind: "tool", id: "legion" },
    protectedPaths: ["src/"],
    sourceArtifacts: [".legion/project/changes/chg_x/oracle/orc_criterion-one.yaml"],
    expected: { preconditions: ["the task ran"], postconditions: ["the criterion holds"], evidence: ["exit code"] },
    requirementCoverage: [{ requirementId: "req_one", coverage: "partial" }],
    traceRefs: [{ path: ".legion/project/changes/chg_x/oracle/orc_criterion-one.yaml", anchor: "orc_criterion-one", relation: "verifies", entity: { kind: "requirement", id: "req_one" } }],
    type: "executable",
    execution: { mode: "command", command: "pnpm", args: ["test"], expectedExitCode: 0, timeoutMs: 600_000 },
    ...overrides
  };
}

test("an oracle command runs alongside the contract's own verification", async () => {
  const contract = makeFixtureContract();
  const outcome = await runDeterministicVerification({
    taskContract: contract,
    workerContext: await makeFixtureWorkerContext({ contract }),
    options: { runner: makePassingRunner(), oracles: [executableOracle()] }
  });

  assert.equal(outcome.report.passed, true);
  assert.equal(
    outcome.report.commands.length,
    contract.verification.length + 1,
    "the oracle's command must be executed, not just recorded"
  );
  assert.deepEqual(outcome.oracleAttribution, [
    { index: contract.verification.length, oracleId: "orc_criterion-one", title: "Criterion one holds" }
  ]);
});

test("a failing oracle blocks a task whose own verification passed", async () => {
  const contract = makeFixtureContract();
  const oracleIndex = contract.verification.length;
  const outcome = await runDeterministicVerification({
    taskContract: contract,
    workerContext: await makeFixtureWorkerContext({ contract }),
    options: {
      // Every contract command passes; only the oracle fails. Before oracles
      // executed, this task reported verified.
      runner: makePassingRunner({ perCommand: { [oracleIndex]: { exitCode: 1 } } }),
      oracles: [executableOracle()]
    }
  });

  assert.equal(outcome.report.passed, false);
  assert.deepEqual([...outcome.report.failingIndices], [oracleIndex]);
  const attributed = outcome.oracleAttribution.find((entry) => entry.index === oracleIndex);
  assert.equal(attributed?.oracleId, "orc_criterion-one", "the failure must name the oracle that declared it");
});

test("an oracle no runner can execute is reported, never assumed satisfied", async () => {
  const contract = makeFixtureContract();
  const outcome = await runDeterministicVerification({
    taskContract: contract,
    workerContext: await makeFixtureWorkerContext({ contract }),
    options: {
      runner: makePassingRunner(),
      oracles: [executableOracle({ execution: { mode: "runtime-driver", driver: "eve", operation: "check" } })]
    }
  });

  // `runtime-driver` has no emitter and no executor. Silently skipping it would
  // make "nothing tried to run it" indistinguishable from "it passed".
  const issue = outcome.issues.find((entry) => entry.code === "oracle_not_evaluable");
  assert.ok(issue, `expected an oracle_not_evaluable issue, got ${JSON.stringify(outcome.issues)}`);
  assert.match(issue.message, /orc_criterion-one/);
  assert.equal(outcome.oracleAttribution.length, 0);
});

test("contract command indices are unchanged by the presence of oracles", async () => {
  const contract = makeFixtureContract();
  const withOracles = await runDeterministicVerification({
    taskContract: contract,
    workerContext: await makeFixtureWorkerContext({ contract }),
    options: { runner: makePassingRunner(), oracles: [executableOracle()] }
  });
  const without = await runDeterministicVerification({
    taskContract: contract,
    workerContext: await makeFixtureWorkerContext({ contract }),
    options: { runner: makePassingRunner() }
  });

  // Oracles append. An existing report's indices keep meaning what they meant,
  // so a recorded failingIndices from before this change still points at the
  // same command.
  for (const [index, command] of without.report.commands.entries()) {
    assert.equal(withOracles.report.commands[index].command, command.command);
  }
});
