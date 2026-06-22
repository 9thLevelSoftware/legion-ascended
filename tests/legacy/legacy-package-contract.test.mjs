import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  checkLegacyPackageContents,
  compareChecksumMaps,
  compareInstallerMatrix,
  comparePackagePathSets
} from "../../scripts/check-package-contents.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const V8_PACK_DRY_RUN = join(ROOT, "docs", "next", "evidence", "P01-PREFLIGHT", "v8-npm-pack-dry-run.json");
const LEGACY_CHECKSUMS = join(ROOT, "checksums.sha256");
const INSTALLER = join(ROOT, "bin", "install.js");

test("package contents preserve legacy paths plus the approved root router bundle", async () => {
  const result = await checkLegacyPackageContents({
    root: ROOT,
    baselinePackPath: V8_PACK_DRY_RUN,
    baselineChecksumPath: LEGACY_CHECKSUMS
  });

  assert.deepEqual(result.missingLegacyPaths, []);
  assert.deepEqual(result.missingApprovedPackagePaths, []);
  assert.deepEqual(result.extraPackagePaths, []);
  assert.deepEqual(result.workspacePackagePaths, []);
  assert.deepEqual(result.legacyChecksumMismatches, []);
  assert.equal(result.bin.legion, "bin/legion.js");
});

test("P01-T10 seeded package mutations fail the path contract", () => {
  const comparison = comparePackagePathSets({
    baselinePaths: ["commands/start.md", "skills/legion/SKILL.md"],
    currentPaths: ["skills/legion/SKILL.md", "packages/core/package.json"]
  });

  assert.deepEqual(comparison.missingLegacyPaths, ["commands/start.md"]);
  assert.deepEqual(comparison.workspacePackagePaths, ["packages/core/package.json"]);
});

test("P01-T10 seeded persona checksum mutation fails the checksum contract", () => {
  const comparison = compareChecksumMaps({
    baselineChecksums: new Map([["agents/agents-orchestrator.md", "a".repeat(64)]]),
    currentChecksums: new Map([["agents/agents-orchestrator.md", "b".repeat(64)]]),
    protectedPrefixes: ["agents/"]
  });

  assert.deepEqual(comparison.legacyChecksumMismatches, ["agents/agents-orchestrator.md"]);
});

test("Task 4 router and bundle checksum mutations fail the checksum contract", () => {
  const comparison = compareChecksumMaps({
    baselineChecksums: new Map([
      ["bin/legion.js", "a".repeat(64)],
      ["dist/legion-cli.mjs", "a".repeat(64)]
    ]),
    currentChecksums: new Map([
      ["bin/legion.js", "b".repeat(64)],
      ["dist/legion-cli.mjs", "b".repeat(64)]
    ])
  });

  assert.deepEqual(comparison.legacyChecksumMismatches, [
    "bin/legion.js",
    "dist/legion-cli.mjs"
  ]);
});

test("P01-T10 seeded installer path mutation fails the installer matrix contract", () => {
  const comparison = compareInstallerMatrix({
    expected: new Map([["codex:local:manifest", ".legion/manifest.json"]]),
    actual: new Map([["codex:local:manifest", ".codex/manifest.json"]])
  });

  assert.deepEqual(comparison.changedInstallerPaths, [
    {
      key: "codex:local:manifest",
      expected: ".legion/manifest.json",
      actual: ".codex/manifest.json"
    }
  ]);
});

test("P01-T10 legacy installer supports local Codex install, verify, and uninstall", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "legion-p01-t10-"));
  const home = join(sandbox, "home");
  const project = join(sandbox, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });

  try {
    const install = spawnSync(process.execPath, [INSTALLER, "--codex", "--local", "--verify"], {
      cwd: project,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home
      }
    });

    assert.equal(install.status, 0, `install failed\nstdout:\n${install.stdout}\nstderr:\n${install.stderr}`);
    assert.match(install.stdout, /Integrity verification passed/);
    assert.ok(existsSync(join(project, ".legion", "manifest.json")));
    assert.ok(existsSync(join(project, ".legion", "commands", "legion", "start.md")));
    assert.ok(existsSync(join(project, ".codex", "prompts", "legion-start.md")));
    assert.match(
      readFileSync(join(project, ".agents", "skills", "legion", "SKILL.md"), "utf8"),
      /legacy `\/legion:\*` aliases/
    );

    const uninstall = spawnSync(process.execPath, [INSTALLER, "--codex", "--local", "--uninstall"], {
      cwd: project,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home
      }
    });

    assert.equal(uninstall.status, 0, `uninstall failed\nstdout:\n${uninstall.stdout}\nstderr:\n${uninstall.stderr}`);
    assert.equal(existsSync(join(project, ".legion", "manifest.json")), false);
    assert.equal(existsSync(join(project, ".codex", "prompts", "legion-start.md")), false);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
