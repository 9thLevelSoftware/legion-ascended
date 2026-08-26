import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RUNTIME_METADATA, RUNTIME_ORDER, recommendedRuntimeKeys } = require("../bin/runtime-metadata");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const README_PATH = path.join(ROOT, "README.md");
const RUNTIME_AUDIT_PATH = path.join(ROOT, "docs", "runtime-audit.md");
const CERTIFICATION_PATH = path.join(ROOT, "docs", "runtime-certification-checklists.md");
const INSTALL_MATRIX_PATH = path.join(ROOT, "docs", "cli", "INSTALL-MATRIX.md");
const SITE_PATH = path.join(ROOT, "docs", "site", "index.html");
const EXPLORE_COMMAND_PATH = path.join(ROOT, "commands", "explore.md");
const GROK_ADAPTER_PATH = path.join(ROOT, "adapters", "grok-build.md");

async function readText(filePath) {
  return await readFile(filePath, "utf8");
}

test("runtime bridge docs stay aligned with the runtime metadata matrix", async () => {
  const readme = await readText(README_PATH);
  const runtimeAudit = await readText(RUNTIME_AUDIT_PATH);
  const certification = await readText(CERTIFICATION_PATH);
  const installMatrix = await readText(INSTALL_MATRIX_PATH);
  const site = await readText(SITE_PATH);
  const exploreCommand = await readText(EXPLORE_COMMAND_PATH);

  assert.deepEqual(
    recommendedRuntimeKeys(),
    ["claude", "codex", "copilot", "antigravity", "opencode", "hermes", "grok", "kilocode"],
    "recommended runtime metadata should expose only first-class targets"
  );

  // Every runtime in metadata, including Grok, must be represented in the
  // user-facing runtime documents. Tier caveats belong in the wording, not in
  // an exclusion that lets a new first-class target drift silently.
  for (const runtimeKey of RUNTIME_ORDER) {
    const runtime = RUNTIME_METADATA[runtimeKey];
    assert.ok(readme.includes(runtime.label), `${runtimeKey}: README should mention ${runtime.label}`);
    assert.ok(runtimeAudit.includes(runtime.label), `${runtimeKey}: runtime audit should mention ${runtime.label}`);
    assert.ok(installMatrix.includes(runtime.label), `${runtimeKey}: install matrix should mention ${runtime.label}`);
    assert.ok(
      certification.includes(runtime.label.replace(" (formerly Amazon Q Developer CLI)", "")),
      `${runtimeKey}: certification checklist should mention ${runtime.label}`
    );
  }

  assert.match(
    readme,
    /Recommended first-class targets/,
    "README should describe the first-class target set"
  );
  assert.match(
    readme,
    /Compatibility, legacy, and manual-only targets/,
    "README should call out lower-tier host bridges"
  );
  assert.match(
    installMatrix,
    /claude-desktop/,
    "install matrix should document Claude Desktop separately from Claude Code"
  );
  assert.match(
    installMatrix,
    /Consumer Gemini CLI moved to Antigravity on June 18, 2026/,
    "install matrix should explain Gemini legacy status"
  );

  assert.match(
    runtimeAudit,
    /\| Grok Build \| First-class \| Native skill plus bounded headless JSON executor \| Yes \| Yes \|/,
    "runtime audit should distinguish first-class Legion support from upstream parity"
  );
  for (const sourceUrl of [
    "https://docs.x.ai/build/overview",
    "https://docs.x.ai/build/cli/reference",
    "https://docs.x.ai/build/cli/headless-scripting",
    "https://docs.x.ai/build/features/skills-plugins-marketplaces"
  ]) {
    assert.ok(runtimeAudit.includes(sourceUrl), `runtime audit should cite ${sourceUrl}`);
  }
  assert.match(runtimeAudit, /upstream .*alpha|CLI .*alpha/i);

  assert.match(
    certification,
    /## Grok Build[\s\S]*\$PROJECT\/\.grok\/skills\/legion\/SKILL\.md[\s\S]*\$GROK_HOME\/skills\/legion\/SKILL\.md[\s\S]*<home>\/\.grok/,
    "Grok certification should pin project, override, and fallback skill paths"
  );
  assert.match(
    certification,
    /grok --prompt-file <path> --cwd <repo> --output-format json --permission-mode bypassPermissions/,
    "Grok certification should pin the exact argv contract"
  );
  assert.match(certification, /Grok owns .*authentication/i);
  assert.match(certification, /XAI_API_KEY/);
  assert.match(certification, /sequential/i);
  assert.match(certification, /alpha/i);
  assert.match(certification, /packed-install smoke/i);

  assert.match(site, /<div class="num">6<\/div><div class="label">Executors<\/div>/);
  assert.match(site, /<div class="num">8<\/div><div class="label">First-Class Targets<\/div>/);
  assert.match(site, /Grok Build is a first-class Legion target/);
  assert.match(
    site,
    /grok --prompt-file &lt;path&gt; --cwd &lt;repo&gt; --output-format json --permission-mode bypassPermissions/,
    "site should pin the exact Grok argv contract"
  );
  assert.match(site, /\$GROK_HOME/);
  assert.match(site, /fallback[\s\S]*&lt;home&gt;\/.grok/i);
  assert.match(site, /Grok owns .*authentication/i);
  assert.match(site, /XAI_API_KEY/);
  assert.match(site, /sequential/i);
  assert.match(site, /alpha/i);
  assert.match(site, /streaming-json/);
  assert.match(site, /ACP/);

  assert.match(exploreCommand, /Grok is a\s+first-class Legion target/);
  assert.doesNotMatch(exploreCommand, /compatible Legion target, not a first-class parity claim/);
  assert.match(exploreCommand, /alpha/i);
  assert.match(exploreCommand, /sequentially/);
  assert.match(exploreCommand, /native surface does not provide\s+parallel subagents/);

  const grokAdapter = await readText(GROK_ADAPTER_PATH);
  assert.match(grokAdapter, /^cli_display_name:\s*["']?Grok Build/m);
  assert.match(grokAdapter, /grok --version/);
  assert.match(grokAdapter, /\.grok\/skills\/legion\/SKILL\.md/);
  assert.match(grokAdapter, /GROK_HOME/);
});
