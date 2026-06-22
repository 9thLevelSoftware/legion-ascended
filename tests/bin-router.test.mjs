import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const LEGION_BIN = path.join(ROOT, "bin", "legion.js");
const EXEC_OPTIONS = {
  encoding: "utf8",
  env: { ...process.env, NO_COLOR: "1" },
  maxBuffer: 5 * 1024 * 1024
};

async function withTempProject(run) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-bin-router-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });

  try {
    return await run({
      home,
      project,
      env: {
        ...EXEC_OPTIONS.env,
        HOME: home,
        USERPROFILE: home
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("root bin shows workflow help", async () => {
  const result = await execFileAsync(process.execPath, ["bin/legion.js", "--help"], {
    ...EXEC_OPTIONS
  });
  assert.match(result.stdout, /legion <command>/);
  assert.match(result.stdout, /start\s+Initialize/);
  assert.doesNotMatch(result.stdout, /legion next <command>/);
});

test("root bin routes install help to the installer", async () => {
  const result = await execFileAsync(process.execPath, ["bin/legion.js", "install", "--help"], {
    ...EXEC_OPTIONS
  });
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--codex/);
});

test("legacy installer flags still route to installer help", async () => {
  const result = await execFileAsync(process.execPath, ["bin/legion.js", "--codex", "--help"], {
    ...EXEC_OPTIONS
  });
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--codex/);
});

test("root bin translates uninstall subcommand to installer uninstall action", async () => {
  await withTempProject(async ({ env, project }) => {
    const manifestPath = path.join(project, ".legion", "manifest.json");

    await execFileAsync(process.execPath, [LEGION_BIN, "install", "--codex", "--local"], {
      ...EXEC_OPTIONS,
      cwd: project,
      env
    });
    assert.equal(existsSync(manifestPath), true);

    await execFileAsync(process.execPath, [LEGION_BIN, "uninstall", "--codex", "--local"], {
      ...EXEC_OPTIONS,
      cwd: project,
      env
    });
    assert.equal(existsSync(manifestPath), false);
  });
});

test("root bin translates update subcommand to installer update action", async () => {
  await withTempProject(async ({ env, project }) => {
    const manifestPath = path.join(project, ".legion", "manifest.json");

    await assert.rejects(
      execFileAsync(process.execPath, [LEGION_BIN, "update", "--codex", "--local"], {
        ...EXEC_OPTIONS,
        cwd: project,
        env
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Legion is not installed/);
        return true;
      }
    );
    assert.equal(existsSync(manifestPath), false);
  });
});
