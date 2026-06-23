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

async function readText(filePath) {
  return await readFile(filePath, "utf8");
}

test("runtime bridge docs stay aligned with the runtime metadata matrix", async () => {
  const readme = await readText(README_PATH);
  const runtimeAudit = await readText(RUNTIME_AUDIT_PATH);
  const certification = await readText(CERTIFICATION_PATH);
  const installMatrix = await readText(INSTALL_MATRIX_PATH);

  assert.deepEqual(
    recommendedRuntimeKeys(),
    ["claude", "codex", "copilot", "antigravity", "opencode", "kilocode"],
    "recommended runtime metadata should expose only first-class targets"
  );

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
});
