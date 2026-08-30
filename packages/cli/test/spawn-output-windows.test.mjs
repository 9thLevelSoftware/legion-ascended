import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";

import * as adapterModule from "../dist/workflow/executor/adapters.js";

const { adapterForKind, adapterSpawnOptions, hermesReadOnlyBlockedResult, redactAdapterTranscript, windowsCmdSpawnArgs } = adapterModule;
const stdio = ["pipe", "pipe", "pipe"];

test("windows cmd spawn args keep grok flags in one /c string", () => {
  assert.equal(typeof windowsCmdSpawnArgs, "function");
  if (typeof windowsCmdSpawnArgs !== "function") return;
  const args = windowsCmdSpawnArgs("grok", [
    "--prompt-file",
    "C:\\Users\\RUNNER~1\\prompt.md",
    "--cwd",
    "C:\\Users\\RUNNER~1\\project"
  ]);
  assert.deepEqual(args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(args.length, 4);
  assert.match(args[3] ?? "", /^grok --prompt-file /);
  assert.match(args[3] ?? "", /--cwd /);

  const claudeArgs = windowsCmdSpawnArgs("claude", ["--output-format", "json"]);
  assert.deepEqual(claudeArgs.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(claudeArgs.length, 4);
  assert.match(claudeArgs[3] ?? "", /^claude --output-format json$/);

  const codexArgs = windowsCmdSpawnArgs("codex", ["--output-last-message", "C:\\tmp\\last.txt"]);
  assert.deepEqual(codexArgs.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(codexArgs.length, 4);
  assert.match(codexArgs[3] ?? "", /^codex --output-last-message /);
});

test("keeps piped Windows adapter children attached while preserving containment policy", () => {
  assert.equal(typeof adapterSpawnOptions, "function");
  if (typeof adapterSpawnOptions !== "function") return;
  const windows = adapterSpawnOptions({ platform: "win32", stdio });
  assert.equal(windows.windowsHide, true);
  assert.equal(windows.detached, false);

  for (const platform of ["linux", "darwin"]) {
    const posix = adapterSpawnOptions({ platform, stdio });
    assert.equal(posix.windowsHide, true);
    assert.equal(posix.detached, true);
  }

  const android = adapterSpawnOptions({ platform: "android", stdio });
  assert.equal(android.windowsHide, true);
  assert.equal(android.detached, false);
});

test("redactAdapterTranscript preserves unrelated JSON escapes", () => {
  assert.equal(typeof redactAdapterTranscript, "function");
  if (typeof redactAdapterTranscript !== "function") return;
  const input = '{"password":"s3cret","note":"\\"`quoted`\\""}';
  const out = redactAdapterTranscript(input);
  assert.match(out, /REDACTED/);
  assert.doesNotMatch(out, /s3cret/);
  assert.match(out, /\\"/);
});

test("Hermes read-only run writes request.rawLogArtifactPath", async () => {
  assert.equal(typeof adapterForKind, "function");
  assert.equal(typeof hermesReadOnlyBlockedResult, "function");
  if (typeof adapterForKind !== "function" || typeof hermesReadOnlyBlockedResult !== "function") return;

  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "legion-hermes-read-only-"));
  const request = {
    repositoryRoot,
    artifactRepositoryRoot: repositoryRoot,
    changeId: "chg_fixture",
    runId: "run_fixture",
    task: {},
    mode: "review",
    executor: "hermes",
    readOnly: true,
    prompt: "bounded specialist prompt",
    contextPackArtifactPath: ".legion/project/context-pack.json",
    contextPackAbsolutePath: path.join(repositoryRoot, ".legion/project/context-pack.json"),
    promptArtifactPath: ".legion/project/executor-prompt.md",
    promptAbsolutePath: path.join(repositoryRoot, ".legion/project/executor-prompt.md"),
    resultArtifactPath: ".legion/project/executor-result.json",
    resultAbsolutePath: path.join(repositoryRoot, ".legion/project/executor-result.json"),
    rawLogArtifactPath: ".legion/project/executor-raw.log",
    rawLogAbsolutePath: path.join(repositoryRoot, ".legion/project/executor-raw.log"),
    redactedLogArtifactPath: ".legion/project/executor-redacted.log",
    redactedLogAbsolutePath: path.join(repositoryRoot, ".legion/project/executor-redacted.log")
  };
  try {
    const result = await adapterForKind("hermes").run(request);
    assert.equal(result.summary, hermesReadOnlyBlockedResult().summary);
    assert.equal(result.status, "blocked");
    assert.match(await readFile(request.rawLogAbsolutePath, "utf8"), /Hermes Agent cannot guarantee read-only execution/);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
