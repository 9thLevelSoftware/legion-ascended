import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import test from "node:test";

import { getValidateNextPlan, renderProtocolDocs } from "../scripts/validate-next.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_OSES = ["ubuntu-latest", "macos-latest", "windows-latest"];
const PINNED_ACTION_PATTERN = /^[^@\s]+@[0-9a-f]{40}$/;

async function readWorkflow(relativePath) {
  const contents = await readFile(path.join(ROOT, relativePath), "utf8");
  return parseYaml(contents);
}

function collectActionReferences(workflow) {
  return Object.values(workflow.jobs ?? {}).flatMap((job) =>
    (job.steps ?? []).flatMap((step) => (step.uses === undefined ? [] : [step.uses]))
  );
}

function matrixOses(job) {
  const oses = job?.strategy?.matrix?.os;
  return Array.isArray(oses) ? oses : [];
}

function workflowRunsCommand(workflow, command) {
  return Object.values(workflow.jobs ?? {}).some((job) =>
    (job.steps ?? []).some((step) => typeof step.run === "string" && step.run.includes(command))
  );
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n/g, "\n");
}

function runCommand(command) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, {
      cwd: ROOT,
      env: process.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", rejectCommand);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }

      rejectCommand(
        new Error(
          `Command failed (${signal ?? code}): ${command}\n${Buffer.concat(stdout).toString("utf8")}${Buffer.concat(stderr).toString("utf8")}`
        )
      );
    });
  });
}

test("P01-T11 validate-next plan is the shared CI/local gate order", () => {
  const plan = getValidateNextPlan().map((step) => step.command);

  assert.deepEqual(plan, [
    "pnpm run typecheck",
    "pnpm run check:boundaries",
    "pnpm run check:worker-bundles",
    "node scripts/scan-default-runtime.mjs",
    "pnpm --filter @legion/protocol generate:schemas",
    "pnpm --filter @legion/artifacts generate:schemas",
    "node scripts/validate-next.mjs --generate-protocol-docs",
    "node scripts/validate-next.mjs --check-generated-drift",
    "pnpm run check:package-contents",
    "pnpm run test",
    "npm pack --dry-run --json",
    "pnpm pack --dry-run"
  ]);
});

test("P01-T11 CI workflow blocks Phase 1 gates on all supported platforms", async () => {
  const workflow = await readWorkflow(".github/workflows/ci.yml");
  const phase1Job = workflow.jobs?.phase1;

  assert.deepEqual(matrixOses(phase1Job), REQUIRED_OSES);
  assert.equal(workflowRunsCommand(workflow, "pnpm validate:next"), true);
  assert.equal(workflow.permissions?.contents, "read");
  assert.equal(phase1Job?.strategy?.["fail-fast"], false);

  for (const actionReference of collectActionReferences(workflow)) {
    assert.match(actionReference, PINNED_ACTION_PATTERN, `${actionReference} must be pinned to a full SHA`);
  }
});

test("P01-T11 protocol compatibility workflow uses pinned actions and generated schema checks", async () => {
  const workflow = await readWorkflow(".github/workflows/protocol-compat.yml");
  const compatJob = workflow.jobs?.protocol_compat;

  assert.deepEqual(matrixOses(compatJob), REQUIRED_OSES);
  assert.equal(workflowRunsCommand(workflow, "pnpm --filter @legion/protocol generate:schemas"), true);
  assert.equal(workflowRunsCommand(workflow, "node scripts/validate-next.mjs --check-generated-drift"), true);
  assert.equal(workflow.permissions?.contents, "read");

  for (const actionReference of collectActionReferences(workflow)) {
    assert.match(actionReference, PINNED_ACTION_PATTERN, `${actionReference} must be pinned to a full SHA`);
  }
});

test("P01-T11 generated protocol docs match the current schema and transition sources", async () => {
  await runCommand("pnpm run typecheck");
  const expectedDocs = await renderProtocolDocs({ root: ROOT });

  for (const [relativePath, expectedContents] of Object.entries(expectedDocs)) {
    const actualContents = await readFile(path.join(ROOT, relativePath), "utf8");
    assert.equal(
      normalizeLineEndings(actualContents),
      normalizeLineEndings(expectedContents),
      `${relativePath} is out of date`
    );
  }
});
