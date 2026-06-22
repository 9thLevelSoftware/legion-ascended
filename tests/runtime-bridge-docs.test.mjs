import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RUNTIME_METADATA, RUNTIME_ORDER, installableRuntimeKeys } = require("../bin/runtime-metadata");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const README_PATH = path.join(ROOT, "README.md");
const RUNTIME_AUDIT_PATH = path.join(ROOT, "docs", "runtime-audit.md");
const CERTIFICATION_PATH = path.join(ROOT, "docs", "runtime-certification-checklists.md");

async function readText(filePath) {
  return await readFile(filePath, "utf8");
}

test("runtime bridge docs stay aligned with the runtime metadata matrix", async () => {
  const readme = await readText(README_PATH);
  const runtimeAudit = await readText(RUNTIME_AUDIT_PATH);
  const certification = await readText(CERTIFICATION_PATH);

  assert.equal(
    installableRuntimeKeys().length,
    11,
    "runtime metadata should expose 10 installable CLI runtimes plus the Kilo Code plugin"
  );

  for (const runtimeKey of RUNTIME_ORDER) {
    const runtime = RUNTIME_METADATA[runtimeKey];
    assert.ok(readme.includes(runtime.label), `${runtimeKey}: README should mention ${runtime.label}`);
    assert.ok(runtimeAudit.includes(runtime.label), `${runtimeKey}: runtime audit should mention ${runtime.label}`);
    assert.ok(
      certification.includes(runtime.label.replace(" (formerly Amazon Q Developer CLI)", "")),
      `${runtimeKey}: certification checklist should mention ${runtime.label}`
    );
  }

  assert.match(
    readme,
    /10 installable AI CLI runtimes plus Kilo Code plugin support/,
    "README should describe the installable host bridge matrix"
  );
  assert.match(
    readme,
    /Aider remains manual-only; support tier varies by runtime/,
    "README should call out the manual-only host bridge"
  );
});
