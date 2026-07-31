import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * `legion dev migrate --from-planning` accepting its `--project` input.
 *
 * The file was read as arbitrary JSON and passed straight through, so a shape
 * mismatch surfaced as an unhandled `TypeError: Cannot read properties of
 * undefined (reading 'map')` from deep inside `initProject`. The file most
 * likely to be pointed at — `.legion/project/project.json`, the only project
 * JSON a repository contains — was exactly the one that crashed, because a
 * manifest keeps its owners under `project.policy.decisionOwners` rather than at
 * the top level.
 */

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

async function legacyRepo(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-migrate-"));
  const staging = await mkdtemp(path.join(tmpdir(), "legion-staging-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  t.after(() => rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);

  await mkdir(path.join(root, ".planning"), { recursive: true });
  await writeFile(
    path.join(root, ".planning/PROJECT.md"),
    "# Legacy Project\n\n## Requirements\n\n- [ ] R1: The resolver reports a missing asset by path\n- [x] R2: Renaming updates dependent manifests\n",
    "utf8"
  );
  await writeFile(
    path.join(root, ".planning/ROADMAP.md"),
    "# Roadmap\n\n| Phase | Name | Requirements | Status |\n|-------|------|--------------|--------|\n| 1 | Foundation | R1 | Pending |\n",
    "utf8"
  );
  await writeFile(path.join(root, ".planning/STATE.md"), "# State\n\nCurrent phase: 1\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "legacy"]);

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  return { root, staging, run };
}

const dryRun = (run, staging, project) => [
  "dev", "migrate", "--from-planning", "--dry-run",
  "--planning-root", ".planning",
  "--staging-root", staging,
  "--run-id", "run_import-1",
  "--project", project,
  "--json"
];

test("the project manifest is accepted as --project input", async (t) => {
  const { root, staging, run } = await legacyRepo(t);
  await run("start", "--name", "Legacy Project", "--owner", "dasbl");

  // `.legion/project/project.json` is the only project JSON a repository has, so
  // it is what an operator will reach for. It previously crashed: a manifest
  // nests the project and keeps owners under `policy.decisionOwners`.
  const imported = await run(...dryRun(run, staging, ".legion/project/project.json"));

  assert.doesNotMatch(imported.stderr, /Cannot read properties of undefined/);
  assert.equal(imported.exitCode, 0, imported.stdout + imported.stderr);
  const payload = parseJsonOutput(imported);
  assert.equal(payload.ok, true);
  assert.ok(payload.report.mappings.length > 0, "the legacy requirements should map");
});

test("a JSON file that is not a project is refused with a usage error", async (t) => {
  const { root, staging, run } = await legacyRepo(t);
  await writeFile(path.join(root, "wrong.json"), JSON.stringify({ hello: "world" }), "utf8");

  const imported = await run(...dryRun(run, staging, "wrong.json"));

  // A shape mismatch is the operator pointing at the wrong file, which is a
  // usage error with a fixable message — not a stack trace from inside
  // `initProject`.
  assert.equal(imported.exitCode, 1);
  assert.doesNotMatch(imported.stderr, /Cannot read properties of undefined/);
  const payload = parseJsonOutput(imported);
  assert.equal(payload.status, "usage_error");
  assert.match(payload.diagnostics[0].message, /slug|name|decisionOwners/i);
});

test("an explicit project input still works", async (t) => {
  const { root, staging, run } = await legacyRepo(t);

  // The documented shape keeps working; accepting the manifest is an addition.
  await writeFile(
    path.join(root, "explicit.json"),
    JSON.stringify({
      slug: "legacy-project",
      name: "Legacy Project",
      decisionOwners: [{ kind: "human", id: "dasbl", displayName: "dasbl" }]
    }),
    "utf8"
  );

  const imported = await run(...dryRun(run, staging, "explicit.json"));
  assert.equal(imported.exitCode, 0, imported.stdout + imported.stderr);
  assert.equal(parseJsonOutput(imported).ok, true);
});

test("imported requirements are flagged as unproven rather than invented", async (t) => {
  const { root, staging, run } = await legacyRepo(t);
  await run("start", "--name", "Legacy Project", "--owner", "dasbl");
  const imported = await run(...dryRun(run, staging, ".legion/project/project.json"));
  assert.equal(imported.exitCode, 0, imported.stderr);

  // A legacy checklist has no acceptance criteria. Restating the requirement as
  // its own proof would manufacture the appearance of one, so the import records
  // a manual criterion that says why it is unproven.
  const specs = parseJsonOutput(imported).report.mappings
    .filter((mapping) => mapping.targetPath?.includes("/specs/"))
    .map((mapping) => mapping.targetPath);
  assert.ok(specs.length > 0, "requirements should map to current specs");

  const spec = await readFile(path.join(staging, ...specs[0].split("/")), "utf8");
  assert.match(spec, /no acceptance criterion was defined at the source/i);
});
