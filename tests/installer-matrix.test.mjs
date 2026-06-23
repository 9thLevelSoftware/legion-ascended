import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  RUNTIME_METADATA,
  SUPPORT_TIERS,
  recommendedRuntimeKeys
} = require("../bin/runtime-metadata");

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const LEGION_BIN = path.join(ROOT, "bin", "legion.js");
const PACKAGE_VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

const EXEC_OPTIONS = {
  encoding: "utf8",
  env: {
    ...process.env,
    NO_COLOR: "1",
    LEGION_TEST_NPM_LATEST: PACKAGE_VERSION
  },
  maxBuffer: 20 * 1024 * 1024,
  timeout: 120_000
};

const FIRST_CLASS_ARTIFACTS = {
  claude: [".claude/skills/legion/SKILL.md"],
  codex: [".codex/prompts/legion.md", ".codex/prompts/legion-start.md", ".agents/skills/legion/SKILL.md"],
  copilot: [".github/skills/legion/SKILL.md", ".github/agents/legion.agent.md"],
  antigravity: [".agents/plugins/legion/plugin.json", ".agents/plugins/legion/commands/legion.md"],
  opencode: [".opencode/commands/legion.md", ".opencode/agent/legion.md"],
  kilocode: [".kilocode/workflows/legion.md", ".kilocode/skills/legion/SKILL.md", ".kilocodemodes"]
};

function manifestPathFor(project, runtimeKey) {
  if (runtimeKey === "claude") return path.join(project, ".claude", "legion", "manifest.json");
  return path.join(project, ".legion", "manifest.json");
}

async function withTempProject(run) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-installer-matrix-"));
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

function artifactExists(project, relativePath) {
  return existsSync(path.join(project, ...relativePath.split("/")));
}

test("runtime registry uses explicit product support tiers", () => {
  assert.deepEqual(SUPPORT_TIERS, ["first-class", "compatible", "legacy", "manual-only", "unsupported"]);
  assert.deepEqual(recommendedRuntimeKeys(), ["claude", "codex", "copilot", "antigravity", "opencode", "kilocode"]);

  for (const runtimeKey of Object.keys(RUNTIME_METADATA)) {
    const runtime = RUNTIME_METADATA[runtimeKey];
    assert.ok(SUPPORT_TIERS.includes(runtime.supportTier), `${runtimeKey}: support tier must be recognized`);
    assert.equal(typeof runtime.lastVerified, "string", `${runtimeKey}: lastVerified is required`);
    assert.ok(runtime.canonicalEntrypoint, `${runtimeKey}: canonicalEntrypoint is required`);
    assert.ok(Array.isArray(runtime.parityGaps), `${runtimeKey}: parityGaps must be explicit`);
    assert.equal(typeof runtime.smokeTestStatus, "string", `${runtimeKey}: smokeTestStatus is required`);
    assert.ok(runtime.installLifecycle, `${runtimeKey}: installLifecycle is required`);
  }

  for (const runtimeKey of recommendedRuntimeKeys()) {
    const runtime = RUNTIME_METADATA[runtimeKey];
    assert.equal(runtime.supportTier, "first-class");
    assert.ok(runtime.evidence.length > 0, `${runtimeKey}: first-class targets require official docs evidence`);
    assert.ok(runtime.canonicalEntrypoint.local || runtime.canonicalEntrypoint.global, `${runtimeKey}: first-class target needs an entrypoint`);
    assert.equal(runtime.smokeTestStatus, "covered", `${runtimeKey}: first-class target needs smoke coverage`);
    assert.equal(runtime.installLifecycle.install, "managed", `${runtimeKey}: first-class install must be managed`);
    assert.equal(runtime.installLifecycle.update, "managed", `${runtimeKey}: first-class update must be managed`);
    assert.equal(runtime.installLifecycle.uninstall, "managed", `${runtimeKey}: first-class uninstall must be managed`);
    assert.equal(runtime.installLifecycle.verify, "managed", `${runtimeKey}: first-class verify must be managed`);
  }
});

test("installer target list hides non-first-class targets by default", async () => {
  const result = await execFileAsync(process.execPath, [LEGION_BIN, "install", "--list-targets"], EXEC_OPTIONS);

  assert.match(result.stdout, /claude\s+first-class/);
  assert.match(result.stdout, /codex\s+first-class/);
  assert.match(result.stdout, /kilocode\s+first-class/);
  assert.doesNotMatch(result.stdout, /cursor\s+compatible/);
  assert.doesNotMatch(result.stdout, /gemini\s+legacy/);
});

test("installer target list can show compatibility, legacy, and manual-only targets", async () => {
  const result = await execFileAsync(process.execPath, [LEGION_BIN, "install", "--list-targets", "--all-targets"], EXEC_OPTIONS);

  assert.match(result.stdout, /cursor\s+compatible/);
  assert.match(result.stdout, /kiro\s+compatible/);
  assert.match(result.stdout, /gemini\s+legacy/);
  assert.match(result.stdout, /aider\s+manual-only/);
});

test("installer explain reports official docs and parity gaps", async () => {
  const result = await execFileAsync(process.execPath, [LEGION_BIN, "install", "--target", "gemini", "--explain"], EXEC_OPTIONS);

  assert.match(result.stdout, /Google Gemini CLI/);
  assert.match(result.stdout, /Tier:\s+legacy/);
  assert.match(result.stdout, /Consumer Gemini CLI traffic moved to Antigravity CLI on June 18, 2026/);
  assert.match(result.stdout, /developers\.googleblog\.com\/an-important-update-transitioning-gemini-cli-to-antigravity-cli/);
});

test("installer detect is read-only and includes first-class targets by default", async () => {
  await withTempProject(async ({ env, project }) => {
    const result = await execFileAsync(process.execPath, [LEGION_BIN, "install", "--detect"], {
      ...EXEC_OPTIONS,
      cwd: project,
      env
    });

    assert.match(result.stdout, /claude\s+(detected|missing)/);
    assert.match(result.stdout, /codex\s+(detected|missing)/);
    assert.doesNotMatch(result.stdout, /gemini\s+(detected|missing)/);
    assert.equal(existsSync(path.join(project, ".legion", "manifest.json")), false);
  });
});

test("installer dry-run writes no project artifacts and warns for compatibility targets", async () => {
  await withTempProject(async ({ env, project }) => {
    const result = await execFileAsync(process.execPath, [LEGION_BIN, "install", "--target", "cursor", "--local", "--dry-run"], {
      ...EXEC_OPTIONS,
      cwd: project,
      env
    });

    assert.match(result.stdout, /WARNING: Cursor is compatible in Legion, not first-class/);
    assert.match(result.stdout, /Dry run only\. No files were written\./);
    assert.equal(existsSync(path.join(project, ".legion", "manifest.json")), false);
    assert.equal(existsSync(path.join(project, ".cursor", "rules", "legion.mdc")), false);
  });
});

test("first-class targets install, update, uninstall, and reinstall in temp projects", async () => {
  for (const runtimeKey of recommendedRuntimeKeys()) {
    await withTempProject(async ({ env, project }) => {
      await execFileAsync(process.execPath, [LEGION_BIN, "install", "--target", runtimeKey, "--local"], {
        ...EXEC_OPTIONS,
        cwd: project,
        env
      });

      const manifestPath = manifestPathFor(project, runtimeKey);
      assert.equal(existsSync(manifestPath), true, `${runtimeKey}: manifest should be written`);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      assert.equal(manifest.runtime, runtimeKey);
      assert.equal(manifest.supportTier, "first-class");
      assert.ok(manifest.canonicalEntrypoint, `${runtimeKey}: manifest should include canonical entrypoint`);

      for (const relativePath of FIRST_CLASS_ARTIFACTS[runtimeKey]) {
        assert.equal(artifactExists(project, relativePath), true, `${runtimeKey}: missing ${relativePath}`);
      }

      await execFileAsync(process.execPath, [LEGION_BIN, "update", "--target", runtimeKey, "--local"], {
        ...EXEC_OPTIONS,
        cwd: project,
        env
      });
      assert.equal(existsSync(manifestPath), true, `${runtimeKey}: update should keep manifest`);

      await execFileAsync(process.execPath, [LEGION_BIN, "uninstall", "--target", runtimeKey, "--local"], {
        ...EXEC_OPTIONS,
        cwd: project,
        env
      });
      assert.equal(existsSync(manifestPath), false, `${runtimeKey}: uninstall should remove manifest`);

      await execFileAsync(process.execPath, [LEGION_BIN, "install", "--target", runtimeKey, "--local"], {
        ...EXEC_OPTIONS,
        cwd: project,
        env
      });
      assert.equal(existsSync(manifestPath), true, `${runtimeKey}: reinstall should write manifest`);
    });
  }
});
