import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The root `settings.json`, checked at last.
 *
 * It has a published schema at `docs/settings.schema.json`, `settings.json`
 * names that schema via `$schema`, and until this landed nothing in `packages/`
 * read a single one of its keys. The file was documented, frozen, and
 * unenforced.
 *
 * Findings are warnings rather than diagnostics, deliberately. `ok` is computed
 * from diagnostics being empty and `failure` hardcodes exit 1, so a bad enum
 * routed there would turn a fixable typo into a red build — which is precisely
 * the collapse recorded against thinning `commands/validate.md` before a WARN
 * tier exists. Only unparseable JSON fails.
 */

const CREATED_AT = "2026-08-03T12:00:00.000Z";

const ANSWERS = {
  "project-name": "Settings Check",
  "project-summary": "Enforce the settings schema nothing read.",
  "project-owner": "dasbl",
  "problem-statement": "settings.json has a published schema and no enforcement.",
  "problem-users": "Operators configuring a project.",
  "problem-success": "An invalid setting is named before it is relied on.",
  "req-1-statement": "Invalid settings are reported without failing the build",
  "req-1-priority": "must",
  "req-1-category": "behavior",
  "req-1-ac-1-statement": "A bad control_mode warns and exits zero",
  "req-1-ac-1-proof": "executable",
  "req-1-ac-1-detail": "node --test tests/validate-settings.test.mjs",
  "req-1-ac-1-more": "false",
  "req-1-more": "false",
  "non-goals": "Reading settings at runtime",
  constraints: "The published schema stays frozen",
  "risk-tier": "R0",
  "risk-reason": "A read-only check.",
  "budget-files": "6",
  "budget-lines": "400",
  "budget-new-files": "3",
  "pref-verification": "pnpm test"
};

/** A finalized project, so validate has something valid to report on. */
async function scratchRepo(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-settings-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const git = (args) => execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
  git(["init", "--initial-branch=main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "core.autocrlf", "false"]);
  await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  await runCliCapture(["--repository-root", root, "start", "--intake", "intake.json", "--created-at", CREATED_AT]);
  await runCliCapture(["--repository-root", root, "start", "--finalize", "--json", "--created-at", CREATED_AT]);
  return {
    root,
    run: (...args) => runCliCapture(["--repository-root", root, ...args]),
    settings: (value) => writeFile(path.join(root, "settings.json"), typeof value === "string" ? value : JSON.stringify(value, null, 2))
  };
}

test("an absent settings.json is a reported state, not a failure", async (t) => {
  const { run } = await scratchRepo(t);
  const result = await run("validate", "--json");
  assert.equal(result.exitCode, 0, result.stderr);

  // Load-bearing. Most projects will never write this file, and every existing
  // fixture in the suite is a fresh repository without one — treating absence as
  // a finding would make validate red for the default configuration.
  const payload = parseJsonOutput(result);
  assert.equal(payload.settings.status, "absent");
  assert.equal(payload.ok, true);
  assert.equal(Object.hasOwn(payload, "warnings"), false);
});

test("an unparseable settings.json fails", async (t) => {
  const { run, settings } = await scratchRepo(t);
  await settings("{ not json");

  const result = await run("validate", "--json");
  assert.notEqual(result.exitCode, 0);
  const payload = parseJsonOutput(result);
  assert.equal(payload.settings.status, "unparseable");
  assert.ok(payload.diagnostics.some((entry) => entry.code === "settings_unparseable"));
});

test("an invalid value warns and does not fail", async (t) => {
  const { run, settings } = await scratchRepo(t);
  await settings({ control_mode: "yolo" });

  const result = await run("validate", "--json");
  assert.equal(result.exitCode, 0, "a bad enum must not break the build");
  const payload = parseJsonOutput(result);
  assert.equal(payload.ok, true);
  assert.equal(payload.settings.status, "warned");
  assert.ok(payload.warnings.some((warning) => warning.message.includes("control_mode")));
});

test("numeric bounds come from the schema, not from looser prose", async (t) => {
  const { run, settings } = await scratchRepo(t);
  // The command's step 9 asks only for "positive integers". The published schema
  // caps both at 5, and a mirror written from the prose would accept these.
  await settings({ planning: { max_tasks_per_plan: 9 }, review: { max_cycles: 0 } });

  const result = await run("validate", "--json");
  assert.equal(result.exitCode, 0);
  const warnings = parseJsonOutput(result).warnings;
  assert.ok(warnings.some((warning) => warning.message.includes("max_tasks_per_plan")));
  assert.ok(warnings.some((warning) => warning.message.includes("max_cycles")));
});

test("unknown keys warn while documented keys are accepted", async (t) => {
  const { run, settings } = await scratchRepo(t);
  await settings({
    $schema: "./docs/settings.schema.json",
    control_mode: "guarded",
    review: { default_mode: "classic", max_cycles: 3, polish_scope: "changed" },
    nonsense: 1
  });

  const result = await run("validate", "--json");
  assert.equal(result.exitCode, 0);
  const warnings = parseJsonOutput(result).warnings;
  assert.equal(warnings.length, 1, `expected only the unknown key to warn, got ${JSON.stringify(warnings)}`);
  assert.match(warnings[0].message, /nonsense/);
});

test("omitting a block is taking the defaults, not a finding", async (t) => {
  const { run, settings } = await scratchRepo(t);
  // The published schema requires seven top-level blocks. The mirror relaxes
  // that on purpose: a project that omits one is using the documented defaults,
  // and reporting it would make a correct file noisy.
  await settings({ control_mode: "guarded" });

  const result = await run("validate", "--json");
  assert.equal(result.exitCode, 0);
  const payload = parseJsonOutput(result);
  assert.equal(payload.settings.status, "valid");
  assert.equal(Object.hasOwn(payload, "warnings"), false);
});

test("a present block must be complete, because a half-written block is not a defaulted one", async (t) => {
  const { run, settings } = await scratchRepo(t);
  // `{"models": {}}` names a models configuration and supplies none of it. An
  // earlier revision made every member optional and documented only the
  // top-level relaxation, so a block like this passed unvalidated.
  await settings({ models: {} });

  const result = await run("validate", "--json");
  assert.equal(result.exitCode, 0);
  const warnings = parseJsonOutput(result).warnings ?? [];
  for (const required of ["planning", "execution", "check"]) {
    assert.ok(
      warnings.some((warning) => warning.message.includes(required)),
      `expected a warning naming models.${required}, got ${JSON.stringify(warnings)}`
    );
  }
});

test("coverage thresholds are constrained, not merely an object", async (t) => {
  const { run, settings } = await scratchRepo(t);
  await settings({
    review: { default_mode: "classic", max_cycles: 3, coverage_thresholds: { overall: "high", typo: -1 } }
  });

  const result = await run("validate", "--json");
  assert.equal(result.exitCode, 0);
  const warnings = parseJsonOutput(result).warnings ?? [];
  assert.ok(warnings.some((warning) => warning.message.includes("overall")), "a string threshold must be reported");
  assert.ok(warnings.some((warning) => warning.message.includes("typo")), "an unknown threshold must be reported");
});

test("an empty commit prefix is reported", async (t) => {
  const { run, settings } = await scratchRepo(t);
  await settings({
    execution: { auto_commit: true, commit_prefix: "", agent_personality_verbosity: "full" }
  });

  const result = await run("validate", "--json");
  assert.equal(result.exitCode, 0);
  const warnings = parseJsonOutput(result).warnings ?? [];
  assert.ok(warnings.some((warning) => warning.message.includes("commit_prefix")));
});

test("doctor reports every settings finding validate reports", async (t) => {
  const { run, settings } = await scratchRepo(t);
  await settings({ control_mode: "yolo" });

  const validated = parseJsonOutput(await run("validate", "--json"));
  const doctored = parseJsonOutput(await run("doctor", "--json"));

  // Doctor must never report healthy what validate refuses, and must never be
  // silent about what validate warns on. Two validation entrances that disagree
  // teach operators to trust whichever one is currently passing.
  assert.equal(doctored.checks.settings.status, validated.settings.status);
  assert.deepEqual(doctored.warnings, validated.warnings);
});

test("doctor fails wherever validate fails on settings", async (t) => {
  const { run, settings } = await scratchRepo(t);
  await settings("{ not json");

  const validated = await run("validate", "--json");
  const doctored = await run("doctor", "--json");
  assert.notEqual(validated.exitCode, 0);
  assert.notEqual(doctored.exitCode, 0, "doctor is a superset and cannot pass what validate fails");
});

test("a settings warning does not block planning", async (t) => {
  const { run, settings } = await scratchRepo(t);
  await settings({ control_mode: "yolo" });

  // The check must stay out of validateProject, whose diagnostics gate the
  // workflow stage. A settings typo that stopped planning would be a worse
  // outcome than the unenforced schema it replaced.
  const status = await run("status", "--json");
  assert.equal(status.exitCode, 0, status.stderr);
  assert.notEqual(parseJsonOutput(status).workflowState.stage, "blocked");
});

test("settings.json is read from the repository root, not the cwd", async (t) => {
  const { root, settings } = await scratchRepo(t);
  await settings({ control_mode: "yolo" });

  const elsewhere = await mkdtemp(path.join(tmpdir(), "legion-cwd-"));
  t.after(() => rm(elsewhere, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const result = await runCliCapture(["--repository-root", root, "validate", "--json"], { cwd: elsewhere });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(parseJsonOutput(result).settings.status, "warned");
});

test("the executable mirror agrees with the published schema", async () => {
  const published = JSON.parse(await readFile(path.join(ROOT, "docs", "settings.schema.json"), "utf8"));
  const { settingsSchemaAsJsonSchema } = await import("../packages/core/dist/index.js");
  const mirrored = settingsSchemaAsJsonSchema();

  // The published file is frozen by checksums.sha256 and cannot be regenerated
  // without breaking the legacy package contract, so it stays the documentation
  // and this stays the enforcement. What must not happen is the two drifting
  // into different dialects while both claim to describe the same file.
  const publishedProps = Object.keys(published.properties).sort();
  const mirroredProps = Object.keys(mirrored.properties ?? {}).sort();
  assert.deepEqual(mirroredProps, publishedProps, "the mirror must describe exactly the published top-level keys");

  for (const [block, definition] of Object.entries(published.properties)) {
    if (definition.type !== "object" || definition.properties === undefined) continue;
    const mirroredBlock = unwrapOptional(mirrored.properties?.[block]);
    assert.ok(mirroredBlock?.properties, `the mirror is missing the ${block} block`);
    assertObjectMatches(mirroredBlock, definition, block);
  }
});

/**
 * Compare every constraint, not the convenient ones.
 *
 * An earlier revision of this test compared enums and numeric bounds only, and
 * three mirror/schema divergences slipped past it — required members inside a
 * present block, an unconstrained `coverage_thresholds`, and a missing
 * `minLength` on `commit_prefix`. All three were exactly the drift the test
 * claimed to prevent, and it was the strongest claim in the file resting on the
 * weakest assertion in it.
 */
function assertObjectMatches(mirroredBlock, definition, label) {
  assert.deepEqual(
    Object.keys(mirroredBlock.properties ?? {}).sort(),
    Object.keys(definition.properties ?? {}).sort(),
    `the mirror and the published schema disagree on the keys of ${label}`
  );
  assert.deepEqual(
    [...(mirroredBlock.required ?? [])].sort(),
    [...(definition.required ?? [])].sort(),
    `${label}: a member required by the published schema must be required by the mirror`
  );
  assert.equal(
    mirroredBlock.additionalProperties ?? false,
    definition.additionalProperties ?? false,
    `${label}: unknown keys must be treated the same way by both`
  );

  for (const [key, spec] of Object.entries(definition.properties ?? {})) {
    const mirroredKey = unwrapOptional(mirroredBlock.properties[key]);
    for (const bound of ["minimum", "maximum", "minLength", "const"]) {
      if (spec[bound] === undefined) continue;
      assert.equal(mirroredKey?.[bound], spec[bound], `${label}.${key} ${bound} must match the published schema`);
    }
    if (spec.enum !== undefined) {
      assert.deepEqual([...(mirroredKey?.enum ?? [])].sort(), [...spec.enum].sort(), `${label}.${key} enum must match`);
    }
    // Nested objects are where the loosest shortcut hides: `z.object({}).loose()`
    // reads as "an object" and accepts anything at all.
    if (spec.type === "object" && spec.properties !== undefined) {
      assertObjectMatches(mirroredKey ?? {}, spec, `${label}.${key}`);
    }
  }
}

/** Zod emits optional members as themselves or wrapped; read through either. */
function unwrapOptional(node) {
  if (node === undefined) return undefined;
  if (Array.isArray(node.anyOf)) return node.anyOf.find((entry) => entry.type !== "null") ?? node;
  return node;
}
