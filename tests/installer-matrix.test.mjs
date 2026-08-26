import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  LEGION_CLI_COMMANDS,
  RUNTIME_METADATA,
  SUPPORT_TIERS,
  recommendedRuntimeKeys
} = require("../bin/runtime-metadata");

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const LEGION_BIN = path.join(ROOT, "bin", "legion.js");
const PACKAGE_VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const START_GUIDANCE_SURFACES = {
  claude: [".claude/skills/legion/SKILL.md"],
  codex: [".codex/prompts/legion.md", ".codex/prompts/legion-start.md", ".agents/skills/legion/SKILL.md"],
  copilot: [".github/skills/legion/SKILL.md", ".github/skills/legion-start/SKILL.md", ".github/agents/legion.agent.md"],
  antigravity: [".agents/plugins/legion/commands/legion.md", ".agents/plugins/legion/commands/start.md"],
  opencode: [".opencode/commands/legion.md", ".opencode/commands/legion-start.md", ".opencode/agent/legion.md"],
  hermes: [".hermes/skills/workflow/legion/SKILL.md"],
  grok: [".grok/skills/legion/SKILL.md"],
  kilocode: [
    ".kilocode/workflows/legion.md", ".kilocode/workflows/legion-start.md", ".kilocode/skills/legion/SKILL.md",
    ".kilo/commands/legion.md", ".kilo/commands/legion-start.md", ".kilo/skills/legion/SKILL.md", ".kilocodemodes"
  ]
};

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
  hermes: [".hermes/skills/workflow/legion/SKILL.md"],
  grok: [".grok/skills/legion/SKILL.md"],
  kilocode: [".kilocode/workflows/legion.md", ".kilocode/skills/legion/SKILL.md", ".kilocodemodes"]
};

function manifestPathFor(project, runtimeKey) {
  if (runtimeKey === "claude") return path.join(project, ".claude", "legion", "manifest.json");
  if (runtimeKey === "hermes") return path.join(project, ".hermes", "skills", "workflow", "legion", "manifest.json");
  if (runtimeKey === "grok") return path.join(project, ".grok", "legion", "manifest.json");
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
      grokHome: path.join(root, "custom-grok-home"),
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

async function createFakePackageManagers(root, repositoryRoot) {
  const managerDir = path.join(root, "package-managers");
  const recordFile = path.join(managerDir, "invocations.jsonl");
  const fakeManager = path.join(managerDir, "fake-package-manager.cjs");
  await mkdir(managerDir, { recursive: true });
  await writeFile(recordFile, "");
  await writeFile(fakeManager, `
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");

const tool = process.argv[2];
const args = process.argv.slice(3);
appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ tool, args }) + "\\n");

if (tool === "npx") {
  const installIndex = args.indexOf("install");
  const result = spawnSync(
    process.execPath,
    [${JSON.stringify(path.join(repositoryRoot, "bin", "legion.js"))}, ...args.slice(installIndex)],
    { stdio: "inherit", env: process.env }
  );
  process.exit(result.status ?? 1);
}

if (tool === "npm" && args[0] === "root" && args[1] === "--global") {
  process.stdout.write(process.env.LEGION_TEST_NPM_ROOT ?? "");
}
`);

  if (process.platform === "win32") {
    const wrapper = `@echo off\n"${process.execPath}" "%~dp0fake-package-manager.cjs" %~n0 %*\nexit /b %errorlevel%\n`;
    await writeFile(path.join(managerDir, "npm.cmd"), wrapper);
    await writeFile(path.join(managerDir, "npx.cmd"), wrapper);
  } else {
    const wrapper = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeManager)} "$(basename "$0")" "$@"\n`;
    await writeFile(path.join(managerDir, "npm"), wrapper);
    await writeFile(path.join(managerDir, "npx"), wrapper);
    await chmod(path.join(managerDir, "npm"), 0o755);
    await chmod(path.join(managerDir, "npx"), 0o755);
  }

  return { managerDir, recordFile };
}

async function createFakeGrokExecutable(root) {
  const binDir = path.join(root, "grok-bin");
  const recordFile = path.join(binDir, "invocations.jsonl");
  const implementation = path.join(binDir, "grok.cjs");
  await mkdir(binDir, { recursive: true });
  await writeFile(recordFile, "");
  await writeFile(implementation, `
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.GROK_TEST_MODE === "invalid") {
  process.stdout.write("grok unknown\\n");
  process.exit(0);
}
if (process.env.GROK_TEST_MODE === "failing") {
  process.stderr.write("fake grok failure\\n");
  process.exit(7);
}
process.stdout.write("grok 1.2.3 (fake)\\n");
`);

  const executable = path.join(binDir, process.platform === "win32" ? "grok.cmd" : "grok");
  if (process.platform === "win32") {
    await writeFile(executable, `@echo off\r\n"${process.execPath}" "${implementation}" %*\r\nexit /b %errorlevel%\r\n`);
  } else {
    await writeFile(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(implementation)} "$@"\n`);
    await chmod(executable, 0o755);
  }
  return { binDir, recordFile };
}

test("runtime registry uses explicit product support tiers", () => {
  assert.deepEqual(SUPPORT_TIERS, ["first-class", "compatible", "legacy", "manual-only", "unsupported"]);
  assert.deepEqual(recommendedRuntimeKeys(), ["claude", "codex", "copilot", "antigravity", "opencode", "hermes", "grok", "kilocode"]);

  for (const runtimeKey of Object.keys(RUNTIME_METADATA)) {
    const runtime = RUNTIME_METADATA[runtimeKey];
    assert.ok(SUPPORT_TIERS.includes(runtime.supportTier), `${runtimeKey}: support tier must be recognized`);
    assert.equal(typeof runtime.lastVerified, "string", `${runtimeKey}: lastVerified is required`);
    assert.ok(runtime.canonicalEntrypoint, `${runtimeKey}: canonicalEntrypoint is required`);
    assert.ok(Array.isArray(runtime.parityGaps), `${runtimeKey}: parityGaps must be explicit`);
    assert.equal(typeof runtime.smokeTestStatus, "string", `${runtimeKey}: smokeTestStatus is required`);
    assert.ok(runtime.installLifecycle, `${runtimeKey}: installLifecycle is required`);
  }

  assert.equal(RUNTIME_METADATA.grok.supportTier, "first-class");
  assert.equal(RUNTIME_METADATA.grok.disposition, "headless-cli-with-native-skill");
  assert.equal(RUNTIME_METADATA.grok.smokeTestStatus, "covered");
  assert.deepEqual(RUNTIME_METADATA.grok.canonicalEntrypoint, { local: "/legion", global: "/legion" });
  assert.deepEqual(RUNTIME_METADATA.grok.scopeSupport, { local: true, global: true });
  assert.deepEqual(RUNTIME_METADATA.grok.nativeSurfaces, [{
    key: "grok-skill",
    type: "grok-skill",
    pathKind: "file",
    localPath: "$PROJECT/.grok/skills/legion/SKILL.md",
    globalPath: "$GROK_HOME/skills/legion/SKILL.md"
  }]);
  assert.deepEqual(
    RUNTIME_METADATA.grok.evidence.map(({ url }) => url),
    [
      "https://docs.x.ai/build/overview",
      "https://docs.x.ai/build/cli/reference",
      "https://docs.x.ai/build/cli/headless-scripting",
      "https://docs.x.ai/build/features/skills-plugins-marketplaces"
    ]
  );

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
  assert.match(result.stdout, /grok\s+first-class/);
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
  assert.match(result.stdout, /grok\s+first-class/);
});

test("installer help groups Grok with first-class targets and preserves its alpha caveat", async () => {
  const result = await execFileAsync(process.execPath, [LEGION_BIN, "install", "--help"], EXEC_OPTIONS);
  const firstClassSection = result.stdout.split("Compatibility, legacy, and manual-only targets:")[0];
  const lowerTierSection = result.stdout.split("Compatibility, legacy, and manual-only targets:")[1];

  assert.match(firstClassSection, /^\s+--grok\s+Grok Build \(first-class Legion skill; upstream CLI alpha\)$/m);
  assert.doesNotMatch(lowerTierSection, /^\s+--grok\b/m);
});

test("installer rejects unknown and missing target values", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [LEGION_BIN, "install", "--target", "not-a-runtime", "--local"], EXEC_OPTIONS),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unknown target: not-a-runtime/);
      return true;
    }
  );

  await assert.rejects(
    execFileAsync(process.execPath, [LEGION_BIN, "install", "--target", "--local"], EXEC_OPTIONS),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unknown target: --local/);
      return true;
    }
  );
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

test("claude dry-run ignores an invalid relative GROK_HOME", async () => {
  await withTempProject(async ({ env, project }) => {
    env.GROK_HOME = "relative-grok-home";
    const result = await execFileAsync(process.execPath, [LEGION_BIN, "install", "--target", "claude", "--local", "--dry-run"], {
      ...EXEC_OPTIONS,
      cwd: project,
      env
    });

    assert.match(result.stdout, /Claude Code/);
    assert.match(result.stdout, /Dry run only\. No files were written\./);
    assert.equal(existsSync(path.join(project, ".claude", "skills", "legion", "SKILL.md")), false);
  });
});

test("Grok detection executes a bounded --version probe and rejects invalid output", async () => {
  await withTempProject(async ({ env, home }) => {
    const { binDir, recordFile } = await createFakeGrokExecutable(path.dirname(home));
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = [binDir, env[pathKey]].filter(Boolean).join(path.delimiter);

    const detected = await execFileAsync(process.execPath, [LEGION_BIN, "install", "--detect", "--all-targets"], {
      ...EXEC_OPTIONS,
      env
    });
    assert.match(detected.stdout, /grok\s+detected\s+grok/);
    assert.deepEqual(
      (await readFile(recordFile, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line)),
      [["--version"]]
    );

    env.GROK_TEST_MODE = "invalid";
    const invalid = await execFileAsync(process.execPath, [LEGION_BIN, "install", "--detect", "--all-targets"], {
      ...EXEC_OPTIONS,
      env
    });
    assert.match(invalid.stdout, /grok\s+missing\s+grok/);

    env.GROK_TEST_MODE = "failing";
    const failing = await execFileAsync(process.execPath, [LEGION_BIN, "install", "--detect", "--all-targets"], {
      ...EXEC_OPTIONS,
      env
    });
    assert.match(failing.stdout, /grok\s+missing\s+grok/);
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

test("Grok Build dry-run and native skill lifecycle are safe and managed", async () => {
  await withTempProject(async ({ env, grokHome, home, project }) => {
    const skillPath = path.join(project, ".grok", "skills", "legion", "SKILL.md");
    const skillDir = path.dirname(skillPath);
    const originalSkill = "---\nname: legion\ndescription: user-owned skill\n---\n\nKeep this content.\n";
    await mkdir(skillDir, { recursive: true });
    await writeFile(skillPath, originalSkill, "utf8");

    await assert.rejects(
      execFileAsync(process.execPath, [LEGION_BIN, "install", "--target", "grok", "--local", "--legacy-prompts"], {
        ...EXEC_OPTIONS,
        cwd: project,
        env
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /native skill surface.*legacy-prompts.*out of scope/i);
        return true;
      }
    );
    assert.equal(existsSync(path.join(project, ".grok", "commands")), false);

    const dryRun = await execFileAsync(process.execPath, [LEGION_BIN, "install", "--target", "grok", "--local", "--dry-run"], {
      ...EXEC_OPTIONS,
      cwd: project,
      env
    });
    assert.match(dryRun.stdout, /Grok Build/);
    assert.match(dryRun.stdout, /grok-skill/);
    assert.match(dryRun.stdout, /Dry run only\. No files were written\./);
    assert.equal(existsSync(manifestPathFor(project, "grok")), false);
    assert.equal(readFileSync(skillPath, "utf8"), originalSkill);

    await execFileAsync(process.execPath, [LEGION_BIN, "install", "--target", "grok", "--local"], {
      ...EXEC_OPTIONS,
      cwd: project,
      env
    });
    const installed = readFileSync(skillPath, "utf8");
    assert.match(installed, /^name: legion$/m);
    assert.match(installed, /Grok Build/);
    assert.match(installed, /legion status --json/);
    assert.match(installed, /legion install --target grok --local/);
    assert.doesNotMatch(installed, /legion install --legacy-prompts/);
    assert.equal(readFileSync(`${skillPath}.bak`, "utf8"), originalSkill);
    assert.equal(existsSync(path.join(project, ".grok", "commands")), false);
    assert.equal(existsSync(path.join(project, ".grok", "plugins")), false);

    const manifest = JSON.parse(readFileSync(manifestPathFor(project, "grok"), "utf8"));
    const resolvedSkillPath = await realpath(skillPath);
    assert.equal(manifest.runtime, "grok");
    assert.equal(manifest.supportTier, "first-class");
    assert.equal(manifest.paths.native["grok-skill"], resolvedSkillPath.replaceAll("\\", "/"));
    assert.ok(manifest.nativeArtifacts.some((artifact) => artifact.path === resolvedSkillPath.replaceAll("\\", "/") && artifact.backupCreated === true));

    const nativeSkillBeforeInvalidUpdate = readFileSync(skillPath, "utf8");
    const manifestBeforeInvalidUpdate = readFileSync(manifestPathFor(project, "grok"), "utf8");
    env.LEGION_TEST_NPM_LATEST = "999.0.0";
    await assert.rejects(
      execFileAsync(process.execPath, [LEGION_BIN, "update", "--target", "grok", "--local", "--legacy-prompts"], {
        ...EXEC_OPTIONS,
        cwd: project,
        env
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /native skill surface.*legacy-prompts.*out of scope/i);
        return true;
      }
    );
    assert.equal(readFileSync(skillPath, "utf8"), nativeSkillBeforeInvalidUpdate);
    assert.equal(readFileSync(manifestPathFor(project, "grok"), "utf8"), manifestBeforeInvalidUpdate);

    await execFileAsync(process.execPath, [LEGION_BIN, "update", "--target", "grok", "--local"], {
      ...EXEC_OPTIONS,
      cwd: project,
      env
    });
    const updatedManifest = JSON.parse(readFileSync(manifestPathFor(project, "grok"), "utf8"));
    assert.equal(updatedManifest.runtime, "grok");
    assert.equal(updatedManifest.version, "999.0.0");

    await execFileAsync(process.execPath, [LEGION_BIN, "uninstall", "--target", "grok", "--local"], {
      ...EXEC_OPTIONS,
      cwd: project,
      env
    });
    assert.equal(existsSync(manifestPathFor(project, "grok")), false);
    assert.equal(readFileSync(resolvedSkillPath, "utf8"), originalSkill);
    assert.equal(existsSync(`${resolvedSkillPath}.bak`), false);

    env.GROK_HOME = grokHome;
    await execFileAsync(process.execPath, [LEGION_BIN, "install", "--target", "grok", "--global"], {
      ...EXEC_OPTIONS,
      cwd: project,
      env
    });
    const globalSkillPath = path.join(grokHome, "skills", "legion", "SKILL.md");
    const globalManifestPath = path.join(grokHome, "legion", "manifest.json");
    assert.equal(existsSync(globalSkillPath), true);
    assert.equal(existsSync(globalManifestPath), true);
    assert.equal(existsSync(path.join(home, ".grok", "skills", "legion", "SKILL.md")), false);
    const globalManifest = JSON.parse(readFileSync(globalManifestPath, "utf8"));
    assert.equal(globalManifest.paths.native["grok-skill"], globalSkillPath.replaceAll("\\", "/"));

    await execFileAsync(process.execPath, [LEGION_BIN, "uninstall", "--target", "grok", "--global"], {
      ...EXEC_OPTIONS,
      cwd: project,
      env
    });
    assert.equal(existsSync(globalSkillPath), false);
    assert.equal(existsSync(globalManifestPath), false);

    delete env.GROK_HOME;
    await execFileAsync(process.execPath, [LEGION_BIN, "install", "--target", "grok", "--global"], {
      ...EXEC_OPTIONS,
      cwd: project,
      env
    });
    const fallbackSkillPath = path.join(home, ".grok", "skills", "legion", "SKILL.md");
    assert.equal(existsSync(fallbackSkillPath), true);
    assert.equal(existsSync(path.join(grokHome, "skills", "legion", "SKILL.md")), false);
    await execFileAsync(process.execPath, [LEGION_BIN, "uninstall", "--target", "grok", "--global"], {
      ...EXEC_OPTIONS,
      cwd: project,
      env
    });
    assert.equal(existsSync(fallbackSkillPath), false);
  });
});

test("generated first-class runtime surfaces carry the same CLI-owned start preparation loop", async (t) => {
  for (const runtimeKey of recommendedRuntimeKeys()) {
    await t.test(runtimeKey, async () => {
      await withTempProject(async ({ env, project }) => {
        await execFileAsync(process.execPath, [LEGION_BIN, "install", "--target", runtimeKey, "--local"], {
          ...EXEC_OPTIONS,
          cwd: project,
          env
        });

        for (const relativePath of START_GUIDANCE_SURFACES[runtimeKey]) {
          assert.equal(artifactExists(project, relativePath), true, `${runtimeKey}: missing ${relativePath}`);
          const body = readFileSync(path.join(project, ...relativePath.split("/")), "utf8");
          assert.match(body, /CLI-owned preflight/i, `${runtimeKey}: CLI must own preparation transitions`);
          assert.match(body, /legion map --refresh --scope \./u, `${runtimeKey}: brownfield mapping must be full-project`);
          assert.match(body, /--map-failed/u, `${runtimeKey}: map failures must enter degraded review through the CLI`);
          assert.match(body, /README.*manifests.*entry points.*configuration.*tests.*CI/is, `${runtimeKey}: review sources must be complete`);
          assert.match(body, /stage-draft/u, `${runtimeKey}: the host must stage a protocol draft`);
          assert.match(body, /staging never accepts/u, `${runtimeKey}: staging must remain distinct from acceptance`);
          assert.match(body, /display the complete grouped review.*requirements.*criteria and proofs.*evidence\/confidence.*unresolved/is, `${runtimeKey}: complete human review payload is required`);
          assert.match(body, /for\s+revise.*new ID.*stage/is, `${runtimeKey}: revision must return through CLI staging`);
          assert.match(body, /--discard-draft/u, `${runtimeKey}: discard must use the durable CLI transition`);
          assert.match(body, /--accept-draft(?!\s+<id>)/u, `${runtimeKey}: active-draft acceptance must be the canonical action`);
          assert.match(body, /never infer acceptance/is, `${runtimeKey}: acceptance must require an explicit decision`);
          assert.match(body, /explicit.*exploration.*repository inference/is, `${runtimeKey}: initiative precedence must be explicit`);
          assert.match(body, /non-goal.*constraint.*unresolved/is, `${runtimeKey}: absence must not be inferred as none`);
          const ordered = [
            /CLI-owned preflight/i,
            /map_refresh_required/i,
            /DEGRADED COVERAGE/i,
            /stage-draft/i,
            /draft_review/i,
            /explicit human/i,
            /accept-draft/i,
            /discard-draft/i,
            /legion start --json/i
          ];
          let cursor = -1;
          for (const marker of ordered) {
            const match = marker.exec(body.slice(cursor + 1));
            assert.ok(match, `${runtimeKey}:${relativePath} missing ordered ${marker}`);
            cursor += match.index + 1;
          }
        }
      });
    });
  }
});

test("generated start guidance sequence is executable through CLI-owned states", async () => {
  await withTempProject(async ({ env, project }) => {
    await execFileAsync(process.execPath, [LEGION_BIN, "install", "--target", "claude", "--local"], {
      ...EXEC_OPTIONS, cwd: project, env
    });
    const guidance = readFileSync(path.join(project, ".claude/skills/legion/SKILL.md"), "utf8");
    assert.match(guidance, /stage-draft.*draft_review.*display the complete grouped review.*explicit human.*accept-draft.*discard-draft.*legion start --json/is);
    assert.match(guidance, /human_decision.*pause.*human/is);

    const { parseJsonOutput, runCliCapture } = await import("./helpers/cli-runner.mjs");
    const run = (...args) => runCliCapture(["--repository-root", project, ...args]);
    const initial = parseJsonOutput(await run("start", "--json", "--created-at", "2026-08-08T12:00:00.000Z"));
    assert.equal(initial.preparation.status, "initiative_required");
    const prepared = parseJsonOutput(await run("start", "--goal", "Ship a small tool", "--json", "--created-at", "2026-08-08T12:00:00.000Z"));
    assert.equal(prepared.preparation.status, "repository_review_required");
    const draft = {
      schemaVersion: "0.3.0", createdAt: "2026-08-08T12:00:00.000Z", kind: "intake-draft",
      id: "itd_generated-guidance", status: "draft", graphVersion: "1.2.0",
      projectMode: prepared.preflight.projectMode, initiative: "Ship a small tool", explorationRefs: [], proposedAnswers: [],
      injectedQuestions: [], unresolvedNodes: [], diagnostics: []
    };
    await writeFile(path.join(project, "draft.json"), JSON.stringify(draft), "utf8");
    const staged = parseJsonOutput(await run("start", "--stage-draft", "draft.json", "--json", "--created-at", "2026-08-08T12:00:00.000Z"));
    assert.equal(staged.status, "draft_review");
    assert.equal(staged.nextAction.type, "human_decision");
    assert.notEqual(staged.nextAction.command, "legion start");
    assert.equal(staged.draft.id, "itd_generated-guidance");
    assert.equal(staged.actions.accept.command, "legion start --accept-draft");
    assert.equal(staged.actions.discard.command, "legion start --discard-draft");
    const discarded = parseJsonOutput(await run("start", "--discard-draft", "--json", "--created-at", "2026-08-08T12:00:00.000Z"));
    assert.equal(discarded.discardedDraft.status, "discarded");

    draft.id = "itd_generated-accepted";
    await writeFile(path.join(project, "draft-accepted.json"), JSON.stringify(draft), "utf8");
    const restaged = parseJsonOutput(await run("start", "--stage-draft", "draft-accepted.json", "--json", "--created-at", "2026-08-08T12:00:00.000Z"));
    assert.equal(restaged.status, "draft_review");
    const accepted = parseJsonOutput(await run("start", "--accept-draft", "--json", "--created-at", "2026-08-08T12:00:00.000Z"));
    assert.equal(accepted.status, "interview");
    const next = parseJsonOutput(await run("start", "--json"));
    assert.equal(next.status, "question");
  });
});

test("default install writes no v8 prompt bundle", async () => {
  await withTempProject(async ({ env, project }) => {
    await execFileAsync(process.execPath, [LEGION_BIN, "install", "--target", "claude", "--local"], {
      ...EXEC_OPTIONS,
      cwd: project,
      env
    });

    // The four legacy source directories, at their Claude install locations.
    for (const relativePath of [".claude/agents", ".claude/commands", ".claude/legion/skills", ".claude/legion/adapters"]) {
      assert.equal(artifactExists(project, relativePath), false, `${relativePath} must not be installed by default`);
    }

    // Only the entry point and the manifest.
    assert.deepEqual(readdirSync(path.join(project, ".claude")).sort(), ["legion", "skills"]);
    assert.equal(artifactExists(project, ".claude/skills/legion/SKILL.md"), true);

    const manifest = JSON.parse(readFileSync(manifestPathFor(project, "claude"), "utf8"));
    assert.equal(manifest.legacyPrompts, false);
  });
});

test("the default entry point dispatches to the CLI, not to markdown", async () => {
  await withTempProject(async ({ env, project }) => {
    await execFileAsync(process.execPath, [LEGION_BIN, "install", "--target", "claude", "--local"], {
      ...EXEC_OPTIONS,
      cwd: project,
      env
    });

    const skill = readFileSync(path.join(project, ".claude", "skills", "legion", "SKILL.md"), "utf8");
    assert.match(skill, /legion status --json/);
    assert.match(skill, /legion build --json/);
    // The router must not send the host looking for files this install never wrote.
    assert.doesNotMatch(skill, /Read only the matching command file/);
    assert.doesNotMatch(skill, /commands[/\\]legion/);
  });
});

test("--legacy-prompts restores the v8 bundle and routes the entry point back to it", async () => {
  await withTempProject(async ({ env, project }) => {
    await execFileAsync(process.execPath, [LEGION_BIN, "install", "--target", "claude", "--local", "--legacy-prompts"], {
      ...EXEC_OPTIONS,
      cwd: project,
      env
    });

    for (const relativePath of [
      ".claude/agents/polymath.md",
      ".claude/commands/legion/build.md",
      ".claude/legion/skills/wave-executor/SKILL.md",
      ".claude/legion/adapters/codex-cli.md"
    ]) {
      assert.equal(artifactExists(project, relativePath), true, `--legacy-prompts must install ${relativePath}`);
    }

    const skill = readFileSync(path.join(project, ".claude", "skills", "legion", "SKILL.md"), "utf8");
    assert.match(skill, /Read only the matching command file/);

    const manifest = JSON.parse(readFileSync(manifestPathFor(project, "claude"), "utf8"));
    assert.equal(manifest.legacyPrompts, true);
  });
});

test("update preserves the surface the install chose", async () => {
  for (const [flags, expected] of [[[], false], [["--legacy-prompts"], true]]) {
    await withTempProject(async ({ env, project }) => {
      const run = (args) => execFileAsync(process.execPath, [LEGION_BIN, ...args], { ...EXEC_OPTIONS, cwd: project, env });
      await run(["install", "--target", "claude", "--local", ...flags]);
      await run(["update", "--target", "claude", "--local"]);

      const manifest = JSON.parse(readFileSync(manifestPathFor(project, "claude"), "utf8"));
      assert.equal(manifest.legacyPrompts, expected, `update after install ${flags.join(" ") || "(default)"}`);
      assert.equal(artifactExists(project, ".claude/agents"), expected);
    });
  }
});

test("update hands installation to the registry target package", async () => {
  await withTempProject(async ({ env, home, project }) => {
    const root = path.dirname(await realpath(home));
    const packageManagers = await createFakePackageManagers(root, ROOT);
    const globalRoot = path.join(root, "global", "node_modules");
    const globalPackage = path.join(globalRoot, "legion-ascended");
    await mkdir(path.join(globalPackage, "bin"), { recursive: true });
    for (const file of ["install.js", "legion.js", "runtime-metadata.js"]) {
      await writeFile(
        path.join(globalPackage, "bin", file),
        await readFile(path.join(ROOT, "bin", file), "utf8")
      );
    }
    await writeFile(
      path.join(globalPackage, "package.json"),
      JSON.stringify({ name: "legion-ascended", version: PACKAGE_VERSION })
    );
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = [packageManagers.managerDir, env[pathKey]].filter(Boolean).join(path.delimiter);
    env.LEGION_TEST_NPM_LATEST = "9.2.2";
    env.LEGION_TEST_NPM_ROOT = globalRoot;

    const run = (args) => execFileAsync(process.execPath, [LEGION_BIN, ...args], { ...EXEC_OPTIONS, cwd: project, env });
    await run(["install", "--target", "claude", "--local"]);
    await execFileAsync(
      process.execPath,
      [path.join(globalPackage, "bin", "legion.js"), "update", "--target", "claude", "--local"],
      { ...EXEC_OPTIONS, cwd: project, env }
    );

    const invocations = await readFile(packageManagers.recordFile, "utf8");
    const records = invocations.trim() === ""
      ? []
      : invocations.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(records, [
      { tool: "npm", args: ["root", "--global"] },
      { tool: "npm", args: ["install", "--global", "legion-ascended@9.2.2"] },
      { tool: "npx", args: ["--yes", "legion-ascended@9.2.2", "install", "--target", "claude", "--local"] }
    ]);
  });
});

test("update preserves legacy prompts in a pre-v9 manifest without the flag", async () => {
  await withTempProject(async ({ env, project }) => {
    const run = (args) => execFileAsync(process.execPath, [LEGION_BIN, ...args], { ...EXEC_OPTIONS, cwd: project, env });
    await run(["install", "--target", "claude", "--local", "--legacy-prompts"]);

    const manifestPath = manifestPathFor(project, "claude");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.version = "8.9.9";
    delete manifest.legacyPrompts;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await run(["update", "--target", "claude", "--local"]);

    const updated = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(updated.legacyPrompts, true);
    assert.equal(artifactExists(project, ".claude/agents"), true);
  });
});

test("every mapped CLI command is a verb the CLI actually has", async () => {
  const help = await execFileAsync(process.execPath, [LEGION_BIN, "--help"], EXEC_OPTIONS);
  const verbs = new Set(
    help.stdout
      .split(/\r?\n/)
      .map((line) => /^\s{2}([a-z-]+)\s{2,}\S/u.exec(line))
      .filter(Boolean)
      .map((match) => match[1])
  );
  // Routed to the installer by bin/legion.js rather than to the workflow CLI,
  // so it never appears in the workflow help.
  verbs.add("update");

  assert.ok(verbs.has("status"), "help parsing produced no verbs");
  for (const entry of LEGION_CLI_COMMANDS) {
    const head = entry.invoke.split(" ")[0];
    assert.equal(verbs.has(head), true, `${entry.name} maps to "${entry.invoke}", but "${head}" is not a CLI verb`);
  }
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
