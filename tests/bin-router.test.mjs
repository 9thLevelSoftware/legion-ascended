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
const INSTALLER_BIN = path.join(ROOT, "bin", "install.js");
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

test("root bin preserves -h as workflow help", async () => {
  const result = await execFileAsync(process.execPath, ["bin/legion.js", "-h"], {
    ...EXEC_OPTIONS
  });
  assert.match(result.stdout, /legion <command>/);
  assert.match(result.stdout, /start\s+Initialize/);
  assert.doesNotMatch(result.stdout, /Usage:/);
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

test("legacy version flags route to installer version", async () => {
  for (const flag of ["--version", "-v"]) {
    const result = await execFileAsync(process.execPath, ["bin/legion.js", flag], {
      ...EXEC_OPTIONS
    });
    assert.match(result.stdout, /Legion v9\.0\.0-alpha\.0/);
  }
});

test("workflow and dev commands keep their own flags", async () => {
  const result = await execFileAsync(process.execPath, ["bin/legion.js", "dev", "migrate", "--verify", "--help"], {
    ...EXEC_OPTIONS
  });
  assert.match(result.stdout, /legion dev migrate/);
  assert.doesNotMatch(result.stdout, /Usage:/);
});

test("bundled dev release commands resolve helper scripts from package root", async () => {
  await withTempProject(async ({ env, project }) => {
    await assert.rejects(
      execFileAsync(process.execPath, [
        LEGION_BIN,
        "--repository-root", project,
        "--json",
        "dev", "release", "checklist",
        "--release-version", "1.0.0"
      ], {
        ...EXEC_OPTIONS,
        cwd: project,
        env
      }),
      (error) => {
        assert.equal(error.code, 1);
        const payload = JSON.parse(error.stdout);
        assert.equal(payload.status, "blocked");
        assert.doesNotMatch(JSON.stringify(payload), /MODULE_NOT_FOUND|Cannot find module|scripts[\\/]release[\\/]release-checklist\.mjs'$/);
        return true;
      }
    );
  });
});

test("imported installer main returns failure code instead of exiting process", async () => {
  await withTempProject(async ({ env, project }) => {
    const script = [
      `const installer = require(${JSON.stringify(INSTALLER_BIN)});`,
      "installer.main(['--codex', '--local', '--uninstall']).then((code) => { console.log('code=' + code); });"
    ].join("\n");

    const result = await execFileAsync(process.execPath, ["-e", script], {
      ...EXEC_OPTIONS,
      cwd: project,
      env
    });

    assert.match(result.stdout, /code=1/);
    assert.match(result.stderr, /No Legion manifest found/);
  });
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
