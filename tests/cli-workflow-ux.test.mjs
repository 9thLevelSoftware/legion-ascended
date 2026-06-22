import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

async function tempRepo() {
  return mkdtemp(path.join(tmpdir(), "legion-workflow-ux-"));
}

test("root help leads with workflow commands and hides next namespace", async () => {
  const result = await runCliCapture(["--help"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /legion <command>/);
  assert.match(result.stdout, /start\s+Initialize/);
  assert.match(result.stdout, /plan\s+Plan/);
  assert.match(result.stdout, /build\s+Execute/);
  assert.match(result.stdout, /review\s+Review/);
  assert.match(result.stdout, /dev\s+Advanced/);
  assert.doesNotMatch(result.stdout, /legion next <command>/);
  assert.doesNotMatch(result.stdout, /worker bundle manifest/i);
});

test("legacy next namespace remains a hidden dev compatibility alias", async () => {
  const root = await tempRepo();
  try {
    const result = await runCliCapture(["next", "--repository-root", root, "project", "status", "--json"]);
    assert.equal(result.exitCode, 1);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "not_found");
    assert.deepEqual(payload.warnings, [
      {
        code: "legacy_next_namespace",
        message: "Use legion dev project status. The legion next namespace is a hidden compatibility alias."
      }
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion start initializes a project with friendly flags", async () => {
  const root = await tempRepo();
  try {
    const result = await runCliCapture([
      "--repository-root", root,
      "start",
      "--name", "Asset Mapper",
      "--summary", "Metadata authoring and deterministic asset resolution",
      "--owner", "dasbl",
      "--created-at", "2026-06-22T12:00:00.000Z",
      "--json"
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "initialized");
    assert.equal(payload.project.name, "Asset Mapper");
    assert.equal(payload.nextAction.command, "legion plan 1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion status gives the next workflow action for a new project", async () => {
  const root = await tempRepo();
  try {
    await runCliCapture([
      "--repository-root", root,
      "start",
      "--name", "Asset Mapper",
      "--summary", "Metadata authoring and deterministic asset resolution",
      "--owner", "dasbl",
      "--created-at", "2026-06-22T12:00:00.000Z",
      "--json"
    ]);
    const result = await runCliCapture(["--repository-root", root, "status", "--json"]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.workflowState.stage, "started");
    assert.equal(payload.nextAction.command, "legion plan 1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker authoring is not in user help", async () => {
  const result = await runCliCapture(["--help"]);
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.stdout, /instructionsHash/);
  assert.doesNotMatch(result.stdout, /promptContentContract/);
  assert.doesNotMatch(result.stdout, /bundles\/index\.json/);
});

test("dev help exposes engine commands for operators", async () => {
  const result = await runCliCapture(["dev", "--help"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /legion dev <command>/);
  assert.match(result.stdout, /project\s+Direct project artifact/);
  assert.match(result.stdout, /change\s+Direct change bundle/);
  assert.match(result.stdout, /board\s+Direct operational Kanban/);
  assert.match(result.stdout, /worker\s+Validate and inspect worker bundles/);
});
