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
  { command: "build", args: ["build", "--phase", "3"], flag: "--phase" },
  { command: "ship", args: ["ship", "--canary"], flag: "--canary" },
  { command: "plan", args: ["plan", "1", "--auto"], flag: "--auto" },
  { command: "polish", args: ["polish", "--dry-run"], flag: "--dry-run" },
  { command: "validate", args: ["validate", "--fix"], flag: "--fix" },
  { command: "validate", args: ["validate", "--ci"], flag: "--ci" },
  // `--phase` is what an operator familiar with `legion review` reaches for
  // first, and `legion approve spec` does not read it: it acts on the latest
  // change. Declared here because `undeclaredOptionError` returns `undefined`
  // for a command with no entry in `DECLARED`, so forgetting the new verb's
  // declaration produces a green tree with the guard disabled on the newest
  // verb — the exact class of defect the declaration boundary exists to close.
  { command: "approve", args: ["approve", "spec", "--phase", "1"], flag: "--phase" },
  // `--approver` is what an operator who has just used `legion approve` reaches
  // for, and `legion attest` spells the same idea `--attested-by`. The entry
  // exists for the reason above: a command with no `DECLARED` entry has
  // `undeclaredOptionError` return `undefined`, so the guard would be silently
  // disabled on the newest verb and the whole tree would still be green.
  { command: "attest", args: ["attest", "security-evaluation", "--approver", "dasbl"], flag: "--approver" }
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

test("legion review --phase resolves a change rather than being refused", async (t) => {
  const { run } = await scratchRepo(t);
  const result = await run("review", "--phase", "3", "--json");

  // `commands/review.md` advertised `--phase N` and the boundary refused it as
  // an unknown option. Declaring it without resolving it would only have moved
  // the failure from "unknown option" to "silently reviewed a different
  // change", so it selects the phase's change through the same derived
  // `chg_phase-<N>-` ID `legion retro --phase` uses.
  assert.notEqual(result.exitCode, 0);
  const message = parseJsonOutput(result).diagnostics[0].message;
  assert.match(message, /phase 3|No change exists/i);
  assert.doesNotMatch(message, /unknown option|does not accept/i);
});

test("legion review --phase validates the whole value", async (t) => {
  const { run } = await scratchRepo(t);
  for (const value of ["1.5", "1foo", "01"]) {
    const result = await run("review", "--phase", value, "--json");
    assert.notEqual(result.exitCode, 0, `--phase ${value} was accepted`);
    assert.match(parseJsonOutput(result).diagnostics[0].message, /positive integer/);
  }
});

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
