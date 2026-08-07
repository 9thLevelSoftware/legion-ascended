#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEGION_BIN = path.join(REPO_ROOT, "bin", "legion.js");
const CODEX_SMOKE_ARTIFACT = ".legion/project/workflow/build/2026-06-23T120000Z-codex-smoke.md";
const INTAKE_FILE = "intake.json";
const APPROVER = "dogfood";
/**
 * The file the declared verification surface pins.
 *
 * Written into the workspace in BOTH modes and committed with the initial
 * fixture, because `legion start --finalize` mints the pin by hashing it and
 * reports `unpinnable_*` for a path it cannot read. Named for the dogfood rather
 * than `ops/compose.integration.yml`, because `--target` mode writes into a
 * clone of a real repository and must not overwrite a file that repository owns.
 */
const SURFACE_PIN = "ops/legion-dogfood-integration.yml";
/**
 * How many gates `DEFAULT_RISK_POLICY` derives at R2.
 *
 * A count, and the harness knows it: `legion ship`'s ready payload carries the
 * three counts and the waived, human-judgement and unevaluable *lists*, and no
 * list of satisfied gate ids. What makes seven mean "every R2 gate" is asserted
 * beside it — one task, tier R2 — the way the R2 milestone test does it.
 */
const R2_GATE_COUNT = 7;
const CREATED_AT = "2026-06-23T12:00:00.000Z";
const LIVE_CODEX_COMMAND_TIMEOUT_MS = 360_000;
const LIVE_CODEX_EXEC_TIMEOUT_MS = 300_000;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.executor === "codex" && !options.liveCodex) {
    throw new DogfoodError("Refusing to run the live Codex executor without --live-codex.");
  }
  if (options.executor === "codex") {
    const codex = runProcess("codex", ["exec", "--help"], { cwd: REPO_ROOT, timeoutMs: 10_000, allowFailure: true });
    if (codex.exitCode !== 0) {
      throw new DogfoodError(`Codex executor is unavailable: ${firstNonEmpty(codex.stderr, codex.stdout, "codex exec --help failed")}`);
    }
    process.env.LEGION_CODEX_EXEC_TIMEOUT_MS ??= String(LIVE_CODEX_EXEC_TIMEOUT_MS);
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), "legion-dogfood-"));
  const workspace = path.join(tempRoot, "workspace");
  let ok = false;
  try {
    if (options.target === undefined) {
      await createSyntheticWorkspace(workspace);
    } else {
      await cloneTarget(options.target, workspace);
    }
    if (options.executor === "codex") {
      await installLegionShim(tempRoot);
    }

    const initialStatus = runLegion(workspace, ["status"], { expectExitCode: 0 });
    assertEqual(initialStatus?.workflowState?.stage, "uninitialized", "initial status should be uninitialized", initialStatus);
    assertEqual(initialStatus?.nextAction?.command, "legion start", "initial next action should be legion start", initialStatus);

    const projectName = options.target === undefined ? "Legion Dogfood" : path.basename(path.resolve(options.target));
    const explore = runLegion(workspace, ["explore", "dogfood workflow guidance", "--executor", options.executor], {
      expectExitCode: 0,
      timeoutMs: options.executor === "codex" ? LIVE_CODEX_COMMAND_TIMEOUT_MS : 120_000
    });
    assertEqual(explore.status, "completed", "explore should complete");
    assertArtifact(workspace, explore.markdownArtifactPath, "explore design artifact");

    // A real intake session, not `legion start --name`.
    //
    // `phaseRiskProfile` hands every planned task a hardcoded R2 when no
    // enforcement tier was recorded, and a phase resolved from a hand-written
    // roadmap carries no requirement, so the plan falls back to a stub with no
    // executable criterion and no declared surface. That combination is why this
    // loop could never prove `protected_oracle` or
    // `integration_or_real_interface_checks`. Recording R2 through the interview
    // bypasses the fallback rather than lowering it — ADR-006 refuses letting
    // implementers lower gates inline, and this changes no gate set at all.
    await writeFile(
      path.join(workspace, INTAKE_FILE),
      JSON.stringify(dogfoodIntakeAnswers(projectName), null, 2),
      "utf8"
    );
    const intake = runLegion(workspace, ["start", "--intake", INTAKE_FILE, "--created-at", CREATED_AT], {
      expectExitCode: 0
    });
    assertEqual(intake.ok, true, "intake should succeed");
    assertEqual(intake.status, "complete", "a fully answered intake file should complete the session", intake.diagnostics);

    // `--force-roadmap` unconditionally, in both modes. `legion start --finalize`
    // leaves a ROADMAP.md it did not write alone and only *warns*, and a warning
    // is invisible to this harness: planning would then read the target's own
    // roadmap, resolve no requirement, and silently produce the stub above. The
    // flag is a no-op where no roadmap exists, so both modes issue identical
    // argv — a flag set only on the path CI never runs is how the comment this
    // rewrite replaces was allowed to rot.
    const start = runLegion(workspace, ["start", "--finalize", "--force-roadmap", "--created-at", CREATED_AT], {
      expectExitCode: 0
    });
    assertEqual(start.ok, true, "finalize should succeed");
    assertEqual(start.status, "finalized", "finalize should finalize the session");
    assertEqual(start.nextAction.command, "legion plan 1", "finalize should route to planning");
    assertEqual(start.roadmap?.written, true, "finalize must write the roadmap plan 1 resolves the requirement through", start.roadmap);
    assertFile(path.join(workspace, ".legion", "project", "project.json"), "project artifact");
    assertFile(path.join(workspace, "ROADMAP.md"), "generated roadmap");

    const mapRefresh = runLegion(workspace, ["map", "--refresh"], { expectExitCode: 0 });
    assertEqual(mapRefresh.status, "completed", "map refresh should complete");
    assertArtifact(workspace, mapRefresh.mapArtifactPath, "codebase map artifact");

    const mapCheck = runLegion(workspace, ["map", "--check"], { expectExitCode: 0 });
    assertEqual(mapCheck.status, "fresh", "map check should report fresh map");

    const advise = runLegion(workspace, ["advise", "dogfood release risk", "--executor", options.executor], {
      expectExitCode: 0,
      timeoutMs: options.executor === "codex" ? LIVE_CODEX_COMMAND_TIMEOUT_MS : 120_000
    });
    assertEqual(advise.status, "completed", "advise should complete");
    assertArtifact(workspace, advise.markdownArtifactPath, "advice artifact");

    const learn = runLegion(workspace, ["learn", "dogfood runs must preserve the human review boundary"], { expectExitCode: 0 });
    assertEqual(learn.status, "completed", "learn should complete");
    assertArtifact(workspace, learn.indexArtifactPath, "learn index artifact");

    // No `--from-roadmap`. `resolvePhaseRequirement` finds the intake
    // requirement only through the `**Requirement:** ...` anchor `renderRoadmap`
    // emits, so planning from a hand-authored roadmap resolves nothing and falls
    // back to a generated stub — the change would still block, and on a gate no
    // assertion here would name.
    const plan = runLegion(workspace, ["plan", "1"], { expectExitCode: 0 });
    assertEqual(plan.status, "planned", "plan should create a typed taskgraph");
    assertEqual(plan.nextAction.command, "legion build", "plan should route to build");
    assertArtifact(workspace, plan.taskgraph.artifactPath, "taskgraph artifact");

    // What the ship report counts, read from the plan rather than inferred from
    // the count. `riskGates.satisfied === 7` is "every R2 gate" only if this
    // change is one R2 task: a silently lowered tier still reports `ready`, and
    // an extra task would make seven-of-seven true for nothing.
    const taskgraph = await readJson(path.join(workspace, ...plan.taskgraph.artifactPath.split("/")));
    assertEqual(taskgraph.tasks.length, 1, "the recipe plans exactly one task, so seven gate rows is seven gates");
    assertEqual(taskgraph.tasks[0].risk.tier, "R2", "the recorded intake tier must reach the task", taskgraph.tasks[0].risk);
    // The operator's own words. `phaseRiskProfile` emits one generic reason on
    // the hardcoded fallback and two — the operator's first — when an
    // enforcement tier was recorded, so this is the only thing visible from
    // outside the process that tells "R2 because the interview said so" apart
    // from "R2 because nobody said". Deleting the intake session and reverting to
    // `legion start --name` would otherwise leave every other assertion green.
    assertEqual(
      taskgraph.tasks[0].risk.reasons.includes(RISK_REASON),
      true,
      "the tier must carry the reason the interview recorded, not the fallback's",
      taskgraph.tasks[0].risk
    );
    assertEqual(
      taskgraph.tasks[0].verification.some((entry) => entry.surface !== undefined && entry.surface.kind !== "unit"),
      true,
      "the planned contract must carry the declared non-unit surface",
      taskgraph.tasks[0].verification
    );

    if (options.executor === "codex") {
      await prepareCodexSmokeTask(workspace, plan.taskgraph.artifactPath);
    }

    const blockedBuild = runLegion(workspace, ["build", "--executor", options.executor], { expectExitCode: 1 });
    assertEqual(blockedBuild.status, "blocked", "dirty build should block");
    assertEqual(blockedBuild.diagnostics[0]?.code, "dirty_worktree", "dirty build should report dirty_worktree", blockedBuild.diagnostics);
    assertEqual(blockedBuild.nextAction.command, "legion build --allow-dirty", "dirty build should route to --allow-dirty");

    // Between planning and building, where the quickstart says approval sits.
    // `approved_delta_spec` reads a live grant pinned to the delta-spec bytes
    // this change still carries; without it the gate is unevaluable and the ship
    // below blocks.
    const approvedSpec = runLegion(workspace, ["approve", "spec", "--approver", APPROVER], { expectExitCode: 0 });
    assertEqual(approvedSpec.status, "approved", "approve spec should grant the delta spec approval", approvedSpec.diagnostics);
    assertEqual(approvedSpec.nextAction.command, "legion build", "a granted spec approval should route back to build");

    const build = runLegion(workspace, ["build", "--executor", options.executor, "--allow-dirty"], {
      expectExitCode: 0,
      timeoutMs: options.executor === "codex" ? LIVE_CODEX_COMMAND_TIMEOUT_MS : 120_000
    });
    assertEqual(build.status, "executed", "build should execute");
    assertEqual(build.nextAction.command, "legion review", "build should route to review");
    assertEqual(Array.isArray(build.taskRuns), true, "build should report task runs");
    assertEqual(build.taskRuns.length > 0, true, "build should produce at least one task run");
    const firstRun = build.taskRuns[0];
    assertArtifact(workspace, firstRun.artifactPath, "task run artifact");
    const runRoot = path.dirname(path.join(workspace, ...firstRun.artifactPath.split("/")));
    assertFile(path.join(runRoot, "context-pack.md"), "context pack");
    assertFile(path.join(runRoot, "executor-result.json"), "executor result");
    if (options.executor === "codex") {
      assertArtifact(workspace, CODEX_SMOKE_ARTIFACT, "Codex smoke output");
    }
    assertArtifact(workspace, build.evidenceIndex.artifactPath, "evidence index");
    const evidenceBeforeReview = await readJson(path.join(workspace, ...build.evidenceIndex.artifactPath.split("/")));
    assertEqual(evidenceBeforeReview.entries.length > 0, true, "evidence index should contain entries");
    assertEqual(evidenceBeforeReview.entries.every((entry) => entry.acceptance.status === "pending"), true, "evidence should start pending");

    const review = runLegion(workspace, ["review", "--executor", options.executor], {
      expectExitCode: 0,
      timeoutMs: options.executor === "codex" ? LIVE_CODEX_COMMAND_TIMEOUT_MS : 120_000
    });
    assertEqual(review.status, "submitted", "review should submit");
    assertEqual(review.nextAction.command, "legion review --accept", "passing review should require manual acceptance");
    const reviewArtifactPath = review.review?.artifactPath ?? review.reviews?.[0]?.artifactPath;
    assertEqual(typeof reviewArtifactPath, "string", "review should report an artifact path");
    assertArtifact(workspace, reviewArtifactPath, "review decision");

    // `--approver`, and it is load-bearing. Without it the accept still exits 0
    // and records `{status: "ready"}`, `whole_change_acceptance_evidence` reports
    // unevaluable, and the only thing that would go red is the ship — one
    // assertion away from this whole recipe regressing in silence.
    const accepted = runLegion(workspace, ["review", "--accept", "--approver", APPROVER], { expectExitCode: 0 });
    assertEqual(accepted.status, "accepted", "review acceptance should succeed");
    assertEqual(accepted.acceptance?.acceptedBy, APPROVER, "the acceptance must record the named approver", accepted.acceptance);
    assertEqual(accepted.nextAction.command, "legion ship", "accepted review should route to ship");

    const finalStatus = runLegion(workspace, ["status"], { expectExitCode: 0 });
    assertEqual(finalStatus.workflowState.stage, "ship_ready", "workflow should reach ship_ready");

    // Ship reports ready, and every gate behind that word was proven by a
    // command this loop actually ran.
    //
    // For the whole of the ship-gate series this harness asserted `blocked` as
    // its success condition, so the dogfood certified that Legion could not
    // certify anything — and an assertion that passes when the tool refuses
    // cannot fail when the tool starts refusing for a new reason.
    const ship = runLegion(workspace, ["ship"], { expectExitCode: 0 });
    assertEqual(ship.status, "ready", "ship should report ready once every R2 gate is proven", ship.diagnostics);
    assertEqual(ship.riskGates.satisfied, R2_GATE_COUNT, "R2 derives seven gates and all seven must be satisfied", ship.riskGates);
    assertEqual(ship.riskGates.unsatisfied, 0, "no gate may be unsatisfied", ship.riskGates);
    assertEqual(ship.riskGates.unevaluable, 0, "no gate may be unevaluable", ship.riskGates);
    // A gate satisfied by a person's decision is still counted in `satisfied`,
    // so the count alone is never the claim. This list is asserted empty *here*
    // and asserted non-empty below, after the pin re-affirmation puts
    // `integration_or_real_interface_checks` into it — which is what makes the
    // empty assertion mean something. Review measured that the earlier version
    // of this pair could not fail: `waivedGates` and `humanJudgementGates` were
    // then written only by the attestation arms, and no gate in
    // `ATTESTATION_GATE_KINDS` is derived at R2, so a real `not_applicable`
    // waiver recorded against this very change moved neither list. An assertion
    // no product change can redden is the shape `shipBlockedGates` was retired
    // for, and two of them had been added in its place.
    //
    // `waivedGates` is not asserted at all, for that reason and stated rather
    // than quietly dropped: an audited waiver is unreachable from an R2 gate
    // set, so this harness cannot hold the claim. `tests/cli-attest.test.mjs`
    // and `tests/change-r3-ordering.test.mjs` hold it where a waiver is
    // reachable.
    assertEqual(
      ship.riskGates.humanJudgementGates.length,
      0,
      "no gate here rests on a person's decision — every pin still matches at this point",
      ship.riskGates.humanJudgementGates
    );
    assertEqual((ship.diagnostics ?? []).length, 0, "a ready ship names nothing", ship.diagnostics);

    // And the gates still bite. Edit the file the declared surface pins — the
    // one thing about this change that is checked at ship time rather than at
    // build time — and `integration_or_real_interface_checks` goes unsatisfied.
    //
    // Without this the harness has become single-outcome: `satisfied: 7,
    // unsatisfied: 0, unevaluable: 0` is also what a report derives when it
    // derives no gate at all, so a change that stopped deriving R2's gates
    // entirely would pass every assertion above. Overwritten rather than
    // deleted, deliberately: `legion approve surface` mints its pin by hashing
    // the file, so it can produce nothing for a path that is not there, and the
    // missing-pin arm correctly offers no recovery to run.
    await writeFile(path.join(workspace, SURFACE_PIN), "# edited out of band\n", "utf8");
    const drifted = runLegion(workspace, ["ship"], { expectExitCode: 1 });
    assertEqual(drifted.status, "blocked", "an edited surface pin must block the ship", drifted.riskGates);
    const driftDiagnostics = (drifted.diagnostics ?? []).filter(
      (entry) => entry.gate === "integration_or_real_interface_checks"
    );
    assertEqual(driftDiagnostics.length, 1, "the drifted pin must name its own gate, exactly once", drifted.diagnostics);
    assertEqual(driftDiagnostics[0].code, "risk_gate_unsatisfied", "a drifted pin is evidence that exists and is negative", driftDiagnostics[0]);
    assertEqual(
      drifted.nextAction?.command,
      "legion approve surface --approver <id>",
      "the blocked ship must name the command that repairs this state",
      drifted.nextAction
    );

    // Run the recovery the payload just printed, and confirm it repairs the
    // state it was printed about. Every unmet verdict in this tree claims to
    // name a cure; this is the only place the claim is executed end to end
    // through the real CLI rather than asserted about a string.
    const reaffirmed = runLegion(workspace, ["approve", "surface", "--approver", APPROVER], { expectExitCode: 0 });
    assertEqual(reaffirmed.status, "approved", "re-affirming the surface should grant an approval", reaffirmed.diagnostics);

    const repaired = runLegion(workspace, ["ship"], { expectExitCode: 0 });
    assertEqual(repaired.status, "ready", "the named recovery must return the ship to ready", repaired.diagnostics);
    assertEqual(repaired.riskGates.satisfied, R2_GATE_COUNT, "the repair must restore every gate, not merely this one", repaired.riskGates);

    // And the recovered `ready` says what it cost. This is the same seven, but
    // it is not the same seven: the integration surface's pinned bytes are the
    // ones this loop edited out of band, the passing integration-surface-check
    // in the evidence ran against the bytes before that edit, and what stands
    // between them is a named human's re-affirmation. A payload reporting the
    // two states identically is a payload an operator cannot read the
    // difference out of — which is exactly what review measured: overwrite the
    // pinned file with prose saying the environment no longer exists,
    // re-affirm, and ship reported seven satisfied and `humanJudgementGates:
    // []`.
    assertEqual(
      repaired.riskGates.humanJudgementGates.join(","),
      "integration_or_real_interface_checks",
      "a re-affirmed pin must be named in the ready payload, not counted silently into satisfied",
      repaired.riskGates
    );
    const judgementWarning = (repaired.warnings ?? []).filter((entry) => entry.code === "risk_gate_human_judgement");
    assertEqual(judgementWarning.length, 1, "the re-affirmation must be echoed as a warning too", repaired.warnings);
    assertEqual(
      judgementWarning[0].message.includes(SURFACE_PIN) && judgementWarning[0].message.includes(APPROVER),
      true,
      "the echo must name the bytes nothing ran against and the human who re-affirmed them",
      judgementWarning[0]
    );

    const retro = runLegion(workspace, ["retro", "--executor", options.executor], {
      expectExitCode: 0,
      timeoutMs: options.executor === "codex" ? LIVE_CODEX_COMMAND_TIMEOUT_MS : 120_000
    });
    // Staged, then saved. The dogfood exercises the loop a real operator walks,
    // and that loop is now two steps: nothing reaches `plan` or `learn --recall`
    // until a human promotes it.
    assertEqual(retro.status, "staged", "retro should stage");
    assertArtifact(workspace, retro.markdownArtifactPath, "retro artifact");

    const savedRetro = runLegion(workspace, ["retro", "--save", retro.runId], { expectExitCode: 0 });
    assertEqual(savedRetro.status, "completed", "retro --save should record the staged run");

    const summary = {
      ok: true,
      executor: options.executor,
      source: options.target === undefined ? "synthetic" : path.resolve(options.target),
      workspace,
      projectId: start.project.id,
      changeId: plan.change.changeId,
      riskTier: taskgraph.tasks[0].risk.tier,
      tasks: taskgraph.tasks.length,
      taskRuns: build.taskRuns.length,
      guidanceRuns: 6,
      finalStage: finalStatus.workflowState.stage,
      shipStatus: ship.status,
      // `shipBlockedGates` is retired rather than reported as 0. A field whose
      // only possible value in a passing run is zero cannot fail, which is the
      // same unfalsifiable shape as the `blocked` assertion this release
      // replaced. Every field that replaced it can come back wrong.
      shipRiskGates: {
        satisfied: ship.riskGates.satisfied,
        unsatisfied: ship.riskGates.unsatisfied,
        unevaluable: ship.riskGates.unevaluable
      },
      gateBlockedOnPinDrift: driftDiagnostics[0].gate,
      shipStatusAfterReaffirm: repaired.status,
      // Reported beside the status, because `ready` after a re-affirmation and
      // `ready` before one are not the same claim and the summary is what a
      // reader of a passing run actually sees.
      humanJudgementGatesAfterReaffirm: repaired.riskGates.humanJudgementGates
    };
    ok = true;
    if (options.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      process.stdout.write([
        "Legion dogfood workflow passed.",
        `Executor: ${summary.executor}`,
        `Source: ${summary.source}`,
        `Final stage: ${summary.finalStage}`,
        `Temp workspace: ${summary.workspace}`
      ].join("\n") + "\n");
    }
  } finally {
    if ((ok || !options.keepTemp) && !options.keepTemp) {
      try {
        await rm(tempRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        process.stderr.write(`Warning: Failed to clean up temp directory ${tempRoot}: ${errorMessage(cleanupError)}\n`);
      }
    } else if (!ok) {
      process.stderr.write(`Dogfood workspace preserved for debugging: ${workspace}\n`);
    }
  }
}

function parseArgs(args) {
  const options = {
    executor: "fake",
    target: undefined,
    liveCodex: false,
    keepTemp: false,
    json: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--target":
        options.target = requiredValue(args, ++index, "--target");
        break;
      case "--executor":
        options.executor = requiredValue(args, ++index, "--executor");
        break;
      case "--live-codex":
        options.liveCodex = true;
        break;
      case "--keep-temp":
        options.keepTemp = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
        process.stdout.write(helpText());
        process.exit(0);
        break;
      default:
        throw new DogfoodError(`Unknown option: ${arg}`);
    }
  }
  if (!["fake", "manual", "codex"].includes(options.executor)) {
    throw new DogfoodError(`Unsupported executor "${options.executor}". Use fake, manual, or codex.`);
  }
  if (options.executor === "manual") {
    throw new DogfoodError("The manual executor intentionally blocks and cannot complete dogfood. Use --executor fake or --executor codex --live-codex.");
  }
  return options;
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new DogfoodError(`Missing required value for ${flag}.`);
  }
  return value;
}

function helpText() {
  return `Usage: pnpm workflow:dogfood -- [--target <repo>] [--executor fake|codex] [--live-codex] [--json] [--keep-temp]\n\nRuns the workflow-first Legion CLI loop in a temporary workspace.\n`;
}

/**
 * The interview this loop answers, and why each answer is load-bearing.
 *
 * `req-1-ac-1-proof: executable` is what makes `legion plan` write a criterion
 * oracle, which is what `protected_oracle` reads. The four `surface` answers are
 * what `integration_or_real_interface_checks` reads. `risk-tier` plus
 * `risk-reason` plus all three budget numbers plus `pref-verification` are what
 * `enforcementPolicy` requires before it returns anything at all — drop any one
 * and the whole policy is `undefined`, planning falls back to the hardcoded R2,
 * and the tier assertion above is the only thing that notices.
 *
 * `pref-verification` is `node --version` and not the milestone fixture's
 * `legion validate`: the project verification command is executed during the
 * build, and `legion` resolves only where the CLI is installed globally. That
 * has been invisible while ship blocked regardless of the verdict; it decides
 * `deterministic_verification` the moment this loop asserts `ready`, and `node`
 * is on PATH by construction wherever this script runs.
 *
 * `req-1-statement` is kept short on purpose: the change id is derived from it,
 * and `.legion/project/changes/<id>/runs/<runId>/...` under a Windows temp
 * directory is where MAX_PATH bites.
 *
 * No `req-1-ac-1-acceptance-paths`. `protected_acceptance_tests` is derived only
 * at R3, so declaring one here would add a workspace file and invite a reader to
 * conclude R2 checks it.
 */
const RISK_REASON = "The dogfood loop plans a reviewable change.";

function dogfoodIntakeAnswers(projectName) {
  return {
    "project-name": projectName,
    "project-summary": "Dogfood validation for the workflow-first Legion CLI",
    "project-owner": APPROVER,
    "problem-statement": "The dogfood loop asserted a blocked ship as its success condition.",
    "problem-users": "Legion maintainers.",
    "problem-success": "The loop reaches ship readiness with every required gate proven.",
    "req-1-statement": "The dogfood loop ships an R2 change",
    "req-1-priority": "must",
    "req-1-category": "behavior",
    "req-1-ac-1-statement": "The loop reaches legion ship with no unproven gate",
    "req-1-ac-1-proof": "executable",
    "req-1-ac-1-detail": "node --version",
    "req-1-ac-1-surface-kind": "real-interface",
    "req-1-ac-1-surface-interface": "legion ship --json",
    "req-1-ac-1-surface-rationale":
      "The loop is driven through the real CLI against a real git worktree, with no in-process stub of the workflow commands.",
    "req-1-ac-1-surface-pins": SURFACE_PIN,
    "req-1-ac-1-more": "false",
    "req-1-more": "false",
    "non-goals": "Publishing or releasing anything",
    constraints: "Temporary workspace only",
    "risk-tier": "R2",
    "risk-reason": RISK_REASON,
    "budget-files": "20",
    "budget-lines": "2000",
    "budget-new-files": "10",
    "pref-verification": "node --version"
  };
}

/**
 * The bytes the declared surface pins.
 *
 * Written in both modes, before the initial commit, because `legion start
 * --finalize` hashes it and refuses a surface it cannot pin. The declaration is
 * a fixture: this file describes the harness's own integration check, and it is
 * discarded with the temp directory. Nothing here has measured a real interface
 * of the target repository, and the dogfood does not claim to.
 */
async function seedSurfaceFixture(workspace) {
  await mkdir(path.join(workspace, path.dirname(SURFACE_PIN)), { recursive: true });
  await writeFile(
    path.join(workspace, SURFACE_PIN),
    "# Legion dogfood verification-surface fixture.\n# Pinned by the intake session so the surface declaration has bytes to hash.\n",
    "utf8"
  );
}

async function createSyntheticWorkspace(workspace) {
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "# Legion Dogfood Fixture\n", "utf8");
  await seedSurfaceFixture(workspace);
  runProcess("git", ["init", "-b", "main", workspace], { cwd: REPO_ROOT });
  runProcess("git", ["-C", workspace, "config", "user.email", "legion-dogfood@example.test"], { cwd: REPO_ROOT });
  runProcess("git", ["-C", workspace, "config", "user.name", "Legion Dogfood"], { cwd: REPO_ROOT });
  runProcess("git", ["-C", workspace, "add", "."], { cwd: REPO_ROOT });
  runProcess("git", ["-C", workspace, "commit", "-m", "initial dogfood fixture"], { cwd: REPO_ROOT });
}

async function installLegionShim(tempRoot) {
  const shimRoot = path.join(tempRoot, "bin");
  await mkdir(shimRoot, { recursive: true });
  if (process.platform === "win32") {
    await writeFile(
      path.join(shimRoot, "legion.cmd"),
      `@echo off\r\n"${process.execPath}" "${LEGION_BIN}" %*\r\n`,
      "utf8"
    );
  } else {
    const shimPath = path.join(shimRoot, "legion");
    await writeFile(
      shimPath,
      `#!/usr/bin/env sh\nexec "${process.execPath}" "${LEGION_BIN}" "$@"\n`,
      "utf8"
    );
    await chmod(shimPath, 0o755);
  }
  process.env.PATH = `${shimRoot}${path.delimiter}${process.env.PATH ?? ""}`;
}

async function cloneTarget(target, workspace) {
  const source = path.resolve(target);
  if (!existsSync(source)) {
    throw new DogfoodError(`Target repository does not exist: ${source}`);
  }
  runProcess("git", ["clone", "--local", "--no-hardlinks", source, workspace], { cwd: REPO_ROOT, timeoutMs: 120_000 });
  runProcess("git", ["-C", workspace, "config", "user.email", "legion-dogfood@example.test"], { cwd: REPO_ROOT });
  runProcess("git", ["-C", workspace, "config", "user.name", "Legion Dogfood"], { cwd: REPO_ROOT });
  // The pin has to exist here too, and be committed, or `--finalize` reports
  // `unpinnable_*` and this mode fails for a reason no assertion names. Nothing
  // in CI exercises `--target`, so this is reasoned rather than measured.
  //
  // `--allow-empty` because the point is a clean worktree, not a commit: if the
  // clone already carries byte-identical contents at this path there is nothing
  // to record, and a `git commit` that exits 1 for having nothing to do would
  // fail the run over a success.
  await seedSurfaceFixture(workspace);
  runProcess("git", ["-C", workspace, "add", SURFACE_PIN], { cwd: REPO_ROOT });
  runProcess("git", ["-C", workspace, "commit", "--allow-empty", "-m", "dogfood verification surface fixture"], {
    cwd: REPO_ROOT
  });
}

async function prepareCodexSmokeTask(workspace, taskgraphArtifactPath) {
  const taskgraphPath = path.join(workspace, ...taskgraphArtifactPath.split("/"));
  const taskgraph = await readJson(taskgraphPath);
  const task = taskgraph.tasks?.[0];
  if (task === undefined) {
    throw new DogfoodError("Planned taskgraph did not contain a task to adapt for live Codex smoke.");
  }
  task.title = "Create Legion dogfood Codex smoke artifact";
  task.objective = [
    `Create or update ${CODEX_SMOKE_ARTIFACT} with one short sentence saying the Legion Codex smoke task ran in this temporary clone.`,
    "Do not edit the taskgraph or any source files.",
    "Run legion validate before reporting."
  ].join(" ");
  task.scope = {
    ...task.scope,
    read: ["ROADMAP.md", ".legion/project/project.json"],
    write: [CODEX_SMOKE_ARTIFACT],
    forbidden: [
      ...new Set([
        ...(Array.isArray(task.scope?.forbidden) ? task.scope.forbidden : []),
        taskgraphArtifactPath,
        ".legion/var/runtime.sqlite"
      ])
    ],
    sequentialFiles: [CODEX_SMOKE_ARTIFACT]
  };
  // Appended, never assigned over. The planned contract's first verification
  // entry carries the declared surface, and it is the run of that entry that
  // writes the `integration-surface-check` evidence item
  // `integration_or_real_interface_checks` reads. Replacing the array would send
  // the live-codex path to a blocked ship for a reason nothing here names — and
  // `pnpm test` never runs this branch, so it would not redden.
  task.verification = [
    ...task.verification,
    {
      command: "legion",
      args: ["validate"],
      expectedExitCode: 0,
      timeoutMs: 120000
    }
  ];
  task.completion = {
    ...task.completion,
    requiredEvidence: ["legion validate verification output"],
    blockedConditions: ["Codex smoke output is missing or legion validate fails."]
  };
  await writeFile(taskgraphPath, `${JSON.stringify(taskgraph, null, 2)}\n`, "utf8");
}

function runLegion(workspace, args, options) {
  const result = runProcess(process.execPath, [
    LEGION_BIN,
    "--repository-root", workspace,
    ...args,
    "--json"
  ], {
    cwd: REPO_ROOT,
    timeoutMs: options.timeoutMs ?? 120_000,
    allowFailure: true
  });
  if (result.exitCode !== options.expectExitCode) {
    throw new DogfoodError([
      `legion ${args.join(" ")} exited ${result.exitCode}; expected ${options.expectExitCode}.`,
      result.stdout.trim(),
      result.stderr.trim()
    ].filter((line) => line.length > 0).join("\n"));
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new DogfoodError(`legion ${args.join(" ")} did not emit JSON: ${error instanceof Error ? error.message : String(error)}\n${result.stdout}`);
  }
}

function runProcess(command, args, options) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const useWindowsShell = process.platform === "win32" && command === "codex";
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: useWindowsShell,
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const timedOut = result.error?.code === "ETIMEDOUT";
  const output = {
    exitCode: timedOut ? 124 : result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
  if (result.error !== undefined) {
    const stderr = firstNonEmpty(
      output.stderr,
      timedOut ? `${command} ${args.join(" ")} timed out after ${timeoutMs}ms.` : result.error.message
    );
    if (options.allowFailure) {
      return {
        ...output,
        stderr
      };
    }
    throw new DogfoodError(stderr);
  }
  if (!options.allowFailure && output.exitCode !== 0) {
    throw new DogfoodError([
      `${command} ${args.join(" ")} exited ${output.exitCode}.`,
      output.stdout.trim(),
      output.stderr.trim()
    ].filter((line) => line.length > 0).join("\n"));
  }
  return output;
}

function assertArtifact(workspace, artifactPath, label) {
  assertFile(path.join(workspace, ...artifactPath.split("/")), label);
}

function assertFile(filePath, label) {
  if (!existsSync(filePath)) {
    throw new DogfoodError(`Missing ${label}: ${filePath}`);
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function assertEqual(actual, expected, message, context) {
  if (actual !== expected) {
    const contextText = context === undefined ? "" : `\nContext: ${JSON.stringify(context, null, 2)}`;
    throw new DogfoodError(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}${contextText}`);
  }
}

function firstNonEmpty(...values) {
  return values.find((value) => value !== undefined && String(value).trim().length > 0) ?? "";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

class DogfoodError extends Error {
  constructor(message) {
    super(message);
    this.name = "DogfoodError";
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
