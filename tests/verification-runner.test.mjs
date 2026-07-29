import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createVerificationRunner } from "../packages/cli/dist/workflow/executor/verification-runner.js";

const EMPTY_SHA256 = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

async function tempRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-verify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function request(overrides = {}) {
  return {
    index: 0,
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    expectedExitCode: 0,
    context: {},
    ...overrides
  };
}

test("a passing command records its real exit code and output hashes", async (t) => {
  const runner = createVerificationRunner({ repositoryRoot: await tempRoot(t) });

  const result = await runner(
    request({ args: ["-e", "process.stdout.write('ok'); process.exit(0)"] })
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.expectedExitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.index, 0);
  // Output is hashed, not stored — evidence stays free of bulk logs.
  assert.match(result.stdoutSha256, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(result.stdoutSha256, EMPTY_SHA256);
  assert.equal(result.stderrSha256, EMPTY_SHA256);
});

test("a failing command records the observed non-zero exit code", async (t) => {
  const runner = createVerificationRunner({ repositoryRoot: await tempRoot(t) });

  const result = await runner(request({ args: ["-e", "process.exit(3)"] }));

  // The observed code is recorded verbatim; deciding pass/fail against
  // expectedExitCode is core's job, not the runner's.
  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
});

test("stdout and stderr hash independently", async (t) => {
  const runner = createVerificationRunner({ repositoryRoot: await tempRoot(t) });

  const result = await runner(
    request({ args: ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(0)"] })
  );

  assert.notEqual(result.stdoutSha256, result.stderrSha256);
  assert.notEqual(result.combinedSha256, result.stdoutSha256);
});

test("a command that cannot be spawned fails the verification instead of crashing", async (t) => {
  const runner = createVerificationRunner({ repositoryRoot: await tempRoot(t) });

  const result = await runner(request({ command: "legion-no-such-binary-xyz", args: [] }));

  assert.notEqual(result.exitCode, 0);
  assert.match(result.notes, /could not be started/);
});

test("a hanging command times out and is reported as timed out", async (t) => {
  const runner = createVerificationRunner({ repositoryRoot: await tempRoot(t) });

  const result = await runner(
    request({ args: ["-e", "setTimeout(() => {}, 60_000)"], timeoutMs: 500 })
  );

  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.notes, /timed out/);
});

test("commands run without a shell, so metacharacters are not interpreted", async (t) => {
  const root = await tempRoot(t);
  const runner = createVerificationRunner({ repositoryRoot: root });

  // If this were run through a shell, the `&&` would chain a second command.
  // With shell: false it is just an argument, so the process still exits 0.
  const result = await runner(
    request({ args: ["-e", "process.stdout.write(process.argv[1] ?? '')", "&& echo pwned"] })
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
});

test("commands run in the supplied repository root", async (t) => {
  const root = await tempRoot(t);
  const runner = createVerificationRunner({ repositoryRoot: root });

  const inRoot = await runner(
    request({
      args: ["-e", "const fs=require('node:fs'); fs.writeFileSync('marker.txt','x'); process.exit(0)"]
    })
  );
  assert.equal(inRoot.exitCode, 0);

  const check = await runner(
    request({
      args: ["-e", "const fs=require('node:fs'); process.exit(fs.existsSync('marker.txt') ? 0 : 9)"]
    })
  );
  assert.equal(check.exitCode, 0);
});
