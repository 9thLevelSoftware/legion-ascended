import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createRequire } from "node:module";

import { selectPackReport } from "../scripts/check-package-contents.mjs";

const require = createRequire(import.meta.url);
const { packageManagerExecutable, packageManagerSpawnConfig } = require("../bin/install.js");

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const GROK_FIXTURE_ROOT = path.join(ROOT, "tests", "fixtures", "grok");

function withPlatform(platform, run) {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

test("installer selects npm.cmd for Windows package-manager spawns", () => {
  withPlatform("linux", () => {
    assert.equal(packageManagerExecutable("npm"), "npm");
    assert.equal(packageManagerExecutable("npx"), "npx");
  });
  withPlatform("win32", () => {
    assert.equal(packageManagerExecutable("npm"), "npm.cmd");
    assert.equal(packageManagerExecutable("npx"), "npx.cmd");
  });
});

test("Windows package-manager spawn config disables shell execution", () => {
  const args = ["--version"];
  const options = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  withPlatform("win32", () => {
    const config = packageManagerSpawnConfig("npm", args, options);
    assert.equal(config.executable, "cmd.exe");
    assert.deepEqual(config.args, ["/d", "/s", "/c", "npm.cmd", ...args]);
    assert.equal(config.options.shell, false);
    assert.equal(config.options.windowsHide, true);
    assert.equal(config.options.encoding, "utf8");
    assert.deepEqual(config.options.stdio, ["ignore", "pipe", "pipe"]);
  });
});

const STRUCTURAL_RUNTIME_ASSETS = [
  "dist/web-tree-sitter.wasm",
  "dist/tree-sitter-javascript.wasm",
  "dist/tree-sitter-typescript.wasm",
  "dist/tree-sitter-tsx.wasm",
  "dist/tree-sitter-python.wasm",
  "dist/tree-sitter-json.wasm",
  "dist/tree-sitter-yaml.wasm"
];

function envWithBinDir(env, binDir) {
  const next = { ...env };
  const pathKeys = Object.keys(next).filter((key) => key.toLowerCase() === "path");
  const current = process.platform === "win32"
    ? (pathKeys.length > 0 ? String(next[pathKeys[0]]) : "")
    : `/usr/bin${path.delimiter}/bin`;
  for (const key of pathKeys) delete next[key];
  next[process.platform === "win32" ? "Path" : "PATH"] = `${binDir}${path.delimiter}${current}`;
  return next;
}

async function installPackedFakeGrok(root) {
  const binDir = path.join(root, "fake-grok-bin");
  await mkdir(binDir, { recursive: true });
  const fixture = path.join(GROK_FIXTURE_ROOT, "fake-grok.cjs");
  if (process.platform === "win32") {
    await copyFile(fixture, path.join(binDir, "fake-grok.cjs"));
    await writeFile(
      path.join(binDir, "grok.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0fake-grok.cjs" %*\r\n`,
      "utf8"
    );
  } else {
    const shim = path.join(binDir, "grok");
    await writeFile(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`, "utf8");
    await execFileAsync("chmod", ["+x", shim]);
  }
  return { binDir };
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

async function runPackedCli(binPath, cwd, env, args) {
  return execFileAsync(process.execPath, [binPath, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 20 * 1024 * 1024
  });
}

async function preparePackedWorkflow(binPath, project, env) {
  await mkdir(path.join(project, "src"), { recursive: true });
  await writeFile(path.join(project, "src", "resolve-asset.ts"), "export function resolveAsset() {\n  return 1;\n}\n", "utf8");
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  git(project, ["config", "user.email", "legion@example.com"]);
  git(project, ["config", "user.name", "Legion Test"]);
  const started = await runPackedCli(binPath, project, env, [
    "start",
    "--name", "Asset Mapper",
    "--summary", "Metadata authoring and deterministic asset resolution",
    "--owner", "dasbl",
    "--created-at", "2026-06-22T12:00:00.000Z",
    "--json"
  ]);
  assert.equal(started.stderr, "");
  await writeFile(
    path.join(project, "ROADMAP.md"),
    "# Roadmap\n\n## Phase 1: Editor MVP\n\nBuild the editor surface.\n\n### Acceptance\n- Asset metadata can be edited.\n",
    "utf8"
  );
  git(project, ["add", "-A"]);
  git(project, ["commit", "-m", "initial workflow"]);
  await runPackedCli(binPath, project, env, ["--repository-root", project, "plan", "1", "--from-roadmap", path.join(project, "ROADMAP.md"), "--json"]);
  git(project, ["add", "-A"]);
  git(project, ["commit", "-m", "planned workflow"]);
}

async function executionResults(project) {
  const changesRoot = path.join(project, ".legion", "project", "changes");
  const changeId = (await readdir(changesRoot))[0];
  const runsRoot = path.join(changesRoot, changeId, "runs");
  const runIds = await readdir(runsRoot);
  return Promise.all(runIds.map(async (runId) => ({
    runId,
    result: JSON.parse(await readFile(path.join(runsRoot, runId, "executor-result.json"), "utf8"))
  })));
}

test("npm package dry-run includes workflow CLI and packaged quickstart", async () => {
  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm pack --dry-run --json"]
    : ["pack", "--dry-run", "--json"];
  const pack = await execFileAsync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024
  });
  const payload = selectPackReport(JSON.parse(pack.stdout));
  assert.ok(payload, "npm pack --dry-run --json did not yield a report carrying files[]");
  const files = new Set(payload.files.map((entry) => entry.path));

  assert.equal(files.has("bin/legion.js"), true);
  assert.equal(files.has("dist/legion-cli.mjs"), true);
  assert.equal(files.has("dist/legion-cli.mjs.map"), true);
  assert.equal(files.has("docs/cli/WORKFLOW-QUICKSTART.md"), true);
  assert.equal(files.has("docs/cli/INSTALL-MATRIX.md"), true);
  assert.equal(files.has("docs/site/index.html"), true);
  assert.equal(files.has("docs/site/styles.css"), true);
  assert.equal(files.has("docs/site/main.js"), true);
  assert.equal(files.has("docs/site/assets/legion-ascended-mark.svg"), true);
  assert.equal(files.has("adapters/codex-cli.md"), true);
  assert.equal(files.has("adapters/grok-build.md"), true);
  assert.equal(files.has("bundles/index.json"), true);
  assert.equal(files.has("bundles/explorer.md"), true);
  for (const asset of STRUCTURAL_RUNTIME_ASSETS) {
    assert.equal(files.has(asset), true, `published package is missing ${asset}`);
  }
});

test("published package installs production dependencies and executes a fake Grok build", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "legion-packed-grok-"));
  let tarballPath;
  try {
    const packCommand = process.platform === "win32" ? "cmd.exe" : "npm";
    const packArgs = process.platform === "win32"
      ? ["/d", "/s", "/c", "npm pack --json"]
      : ["pack", "--json"];
    const packed = await execFileAsync(packCommand, packArgs, {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 20 * 1024 * 1024
    });
    const report = selectPackReport(JSON.parse(packed.stdout));
    assert.ok(report, "npm pack --json did not return a package report");
    tarballPath = path.resolve(ROOT, report.filename);

    const extracted = path.join(scratch, "extracted");
    await mkdir(extracted, { recursive: true });
    await execFileAsync("tar", ["-xzf", tarballPath, "-C", extracted], { timeout: 30_000 });
    const packageRoot = path.join(extracted, "package");
    const packedBin = path.join(packageRoot, "bin", "legion.js");
    assert.equal(existsSync(packedBin), true);
    assert.equal(existsSync(path.join(packageRoot, "adapters", "grok-build.md")), true);
    assert.equal(existsSync(path.join(packageRoot, "dist", "legion-cli.mjs")), true);
    for (const asset of STRUCTURAL_RUNTIME_ASSETS) {
      assert.equal(existsSync(path.join(packageRoot, asset)), true, `packed package is missing ${asset}`);
    }

    const npmEnv = {
      ...process.env,
      // Node 26 emits an expected SQLite ExperimentalWarning; keep it out of CLI stderr assertions across Node versions.
      NODE_NO_WARNINGS: "1",
      npm_config_audit: "false",
      npm_config_fund: "false"
    };
    const npmInstallConfig = packageManagerSpawnConfig("npm", ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--prefer-offline"], {
      cwd: packageRoot,
      env: npmEnv,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 20 * 1024 * 1024
    });
    await execFileAsync(npmInstallConfig.executable, npmInstallConfig.args, npmInstallConfig.options);
    const help = await runPackedCli(packedBin, packageRoot, npmEnv, ["--help"]);
    assert.match(help.stdout, /legion <command>/);

    const project = path.join(scratch, "project");
    await mkdir(project, { recursive: true });
    const recordPath = path.join(scratch, "grok-invocations.jsonl");
    const fake = await installPackedFakeGrok(scratch);
    const env = envWithBinDir({
      ...npmEnv,
      HOME: path.join(scratch, "home"),
      USERPROFILE: path.join(scratch, "home"),
      FAKE_GROK_RESPONSE_FILE: path.join(GROK_FIXTURE_ROOT, "json-success.json"),
      FAKE_GROK_RECORD_FILE: recordPath,
      FAKE_GROK_MODE: "success",
      FAKE_GROK_SLEEP_MS: "0",
      NO_COLOR: "1"
    }, fake.binDir);
    delete env.XAI_API_KEY;
    await mkdir(env.HOME, { recursive: true });

    await runPackedCli(packedBin, project, env, ["install", "--target", "grok", "--local"]);
    assert.equal(existsSync(path.join(project, ".grok", "skills", "legion", "SKILL.md")), true);
    await preparePackedWorkflow(packedBin, project, env);

    const explicit = await runPackedCli(packedBin, project, env, ["build", "--executor", "grok", "--allow-dirty", "--json"]);
    assert.equal(JSON.parse(explicit.stdout).executor, "grok");

    const automaticEnv = { ...env };
    delete automaticEnv.GROK_AGENT;
    delete automaticEnv.GROK_SESSION_ID;
    const automatic = await runPackedCli(packedBin, project, automaticEnv, ["build", "--allow-dirty", "--json"]);
    assert.equal(JSON.parse(automatic.stdout).executor, "grok");

    const nestedEnv = { ...env, GROK_AGENT: "1" };
    delete nestedEnv.GROK_SESSION_ID;
    await assert.rejects(
      () => runPackedCli(packedBin, project, nestedEnv, ["build", "--allow-dirty", "--json"]),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(JSON.parse(error.stdout).executor, "manual");
        return true;
      }
    );

    env.FAKE_GROK_RESPONSE_FILE = path.join(GROK_FIXTURE_ROOT, "json-error.json");
    await assert.rejects(
      () => runPackedCli(packedBin, project, env, ["build", "--executor", "grok", "--allow-dirty", "--json"]),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(JSON.parse(error.stdout).executor, "grok");
        return true;
      }
    );

    const results = await executionResults(project);
    assert.equal(results.some(({ result }) => result.status === "succeeded" && result.summary === "Fake Grok completed the resolver task."), true);
    assert.equal(results.some(({ result }) => result.status === "failed" && result.findings.some((finding) => finding.id === "grok-executor-invalid-output")), true);
    const canonicalProject = await realpath(project);
    const records = (await readFile(recordPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const executions = records.filter((record) => record.args[0] === "--prompt-file");
    assert.equal(executions.length, 3);
    for (const record of executions) {
      assert.equal(await realpath(record.cwd), canonicalProject);
      assert.equal(record.stdinLength, 0);
      assert.equal(record.xaiApiKeyPresent, false);
      assert.deepEqual(record.args.slice(-4), ["--output-format", "json", "--permission-mode", "bypassPermissions"]);
    }
    assert.equal(records.some((record) => record.args.length === 1 && record.args[0] === "--version"), true);
  } finally {
    await rm(scratch, { recursive: true, force: true });
    if (tarballPath) await rm(tarballPath, { force: true });
  }
});


test("package entrypoint exposes workflow-first help", async () => {
  const result = await execFileAsync(process.execPath, ["bin/legion.js", "--help"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000
  });

  assert.match(result.stdout, /legion <command>/);
  assert.match(result.stdout, /start\s+Initialize/);
  assert.match(result.stdout, /build\s+Execute approved task contracts/);
  assert.doesNotMatch(result.stdout, /legion next <command>/);
});
