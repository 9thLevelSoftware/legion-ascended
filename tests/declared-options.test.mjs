import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * Each workflow command declares what it reads, and the runtime refuses the rest.
 *
 * `parseCliArgs` accepts any option, so a flag no handler read was silently
 * ignored — and the caller got a confident answer to a question they had not
 * asked. An adversarial sweep found twenty-six instances of that mechanism, and
 * three changed which artifact was acted on: `review --phase N` reviewed and
 * could accept a change other than the one named, `build --phase N` built the
 * latest taskgraph, and `start --session <id> --from-exploration <run>`
 * discarded the exploration. None of them failed.
 */

async function scratchRepo(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-declared-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  execFileSync("git", ["-C", root, "init", "--initial-branch=main"], { stdio: ["ignore", "pipe", "ignore"] });
  return { root, run: (...args) => runCliCapture(["--repository-root", root, ...args]) };
}

const IGNORED = [
  { command: "review", args: ["review", "--phase", "3"], flag: "--phase" },
  { command: "build", args: ["build", "--phase", "3"], flag: "--phase" },
  { command: "ship", args: ["ship", "--canary"], flag: "--canary" },
  { command: "plan", args: ["plan", "1", "--auto"], flag: "--auto" },
  { command: "polish", args: ["polish", "--dry-run"], flag: "--dry-run" },
  { command: "validate", args: ["validate", "--fix"], flag: "--fix" },
  { command: "validate", args: ["validate", "--ci"], flag: "--ci" }
];

for (const entry of IGNORED) {
  test(`legion ${entry.command} refuses ${entry.flag} rather than ignoring it`, async (t) => {
    const { run } = await scratchRepo(t);
    const result = await run(...entry.args, "--json");
    assert.notEqual(result.exitCode, 0, `${entry.flag} was accepted and ignored`);
    const payload = parseJsonOutput(result);
    assert.equal(payload.status, "usage_error");
    assert.match(payload.diagnostics[0].message, new RegExp(entry.flag.replace(/^--/, "--")));
  });
}

test("declared options are still accepted", async (t) => {
  const { run } = await scratchRepo(t);
  // The refusal must not be a blanket one: a command's own options still work.
  const result = await run("map", "--check", "--json");
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(parseJsonOutput(result).mode, "check");
});

test("global options are accepted everywhere", async (t) => {
  const { run } = await scratchRepo(t);
  for (const command of ["status", "validate", "doctor"]) {
    const result = await run(command, "--json");
    assert.notEqual(parseJsonOutput(result).status, "usage_error", `${command} rejected a global option`);
  }
});

test("retro's scope flags reach the handler rather than the option boundary", async (t) => {
  const { run } = await scratchRepo(t);
  const result = await run("retro", "--phase", "3", "--json");
  assert.notEqual(result.exitCode, 0);
  // Declared, so the handler answers. Which answer it gives is the handler's
  // business — here, that no change exists for phase 3. What this pins is that
  // the caller is told about their phase, not that `--phase` is unreadable.
  const message = parseJsonOutput(result).diagnostics[0].message;
  assert.match(message, /phase 3|Phase 3/);
  assert.doesNotMatch(message, /unknown option|does not accept/i);
});
