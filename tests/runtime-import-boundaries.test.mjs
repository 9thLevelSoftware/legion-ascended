import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RUNTIME_IMPORT_BOUNDARY_RULES,
  scanRuntimeImportBoundaries
} from "../scripts/scan-runtime-import-boundaries.mjs";

async function withFixture(files, callback) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-runtime-ib-"));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath = path.join(root, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents, "utf8");
    }
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("passes when the runtime module only imports @legion/protocol and core barrel re-exports it", async () => {
  await withFixture(
    {
      "packages/protocol/src/index.ts": "export const X = 1;\n",
      "packages/core/src/index.ts":
        "export * from \"./transition.js\";\nexport * from \"./runtime/index.js\";\n",
      "packages/core/src/runtime/contract.ts":
        'import type { RunId } from "@legion/protocol";\nexport type Driver = { start(id: RunId): Promise<void> };\n',
      "packages/core/src/runtime/local-driver.ts":
        'import type { RunId } from "@legion/protocol";\nimport { RUNTIME_LOCAL_DRIVER_ID } from "./contract.js";\nexport const id = RUNTIME_LOCAL_DRIVER_ID;\n'
    },
    async (root) => {
      const result = await scanRuntimeImportBoundaries({ root });
      assert.equal(result.ok, true, JSON.stringify(result.violations, null, 2));
      assert.deepEqual(result.violations, []);
      assert.equal(result.runtimeFilesScanned, 2);
    }
  );
});

test("rejects eve import inside the runtime module", async () => {
  await withFixture(
    {
      "packages/core/src/runtime/eve-shim.ts":
        'import { defineAgent } from "eve";\nexport const agent = defineAgent;\n'
    },
    async (root) => {
      const result = await scanRuntimeImportBoundaries({ root });
      assert.equal(result.ok, false);
      assert.ok(
        result.violations.some((v) => v.rule === "forbidden_provider_or_storage_import" && v.specifier === "eve"),
        "expected eve import violation"
      );
    }
  );
});

test("rejects sqlite storage import inside the runtime module", async () => {
  await withFixture(
    {
      "packages/core/src/runtime/db.ts":
        'import sqlite from "node:sqlite";\nexport const db = sqlite;\n'
    },
    async (root) => {
      const result = await scanRuntimeImportBoundaries({ root });
      assert.equal(result.ok, false);
      assert.ok(
        result.violations.some((v) => v.rule === "forbidden_provider_or_storage_import" && v.specifier === "node:sqlite"),
        "expected node:sqlite violation"
      );
    }
  );
});

test("rejects host CLI imports inside the runtime module", async () => {
  await withFixture(
    {
      "packages/core/src/runtime/host.ts":
        'import { spawn } from "claude-code";\nexport const start = spawn;\n'
    },
    async (root) => {
      const result = await scanRuntimeImportBoundaries({ root });
      assert.equal(result.ok, false);
      assert.ok(
        result.violations.some((v) => v.rule === "forbidden_host_cli_import" && v.specifier === "claude-code"),
        "expected host-cli violation"
      );
    }
  );
});

test("rejects non-protocol workspace imports inside the runtime module", async () => {
  await withFixture(
    {
      "packages/core/src/runtime/bad.ts":
        'import { someArtifact } from "@legion/artifacts";\nexport const x = someArtifact;\n'
    },
    async (root) => {
      const result = await scanRuntimeImportBoundaries({ root });
      assert.equal(result.ok, false);
      assert.ok(
        result.violations.some((v) => v.rule === "disallowed_workspace_import" && v.specifier === "@legion/artifacts"),
        "expected disallowed workspace import violation"
      );
    }
  );
});

test("rejects deep workspace imports inside the runtime module", async () => {
  await withFixture(
    {
      "packages/core/src/runtime/deep.ts":
        'import { x } from "@legion/protocol/src/internal";\nexport const v = x;\n'
    },
    async (root) => {
      const result = await scanRuntimeImportBoundaries({ root });
      assert.equal(result.ok, false);
      assert.ok(
        result.violations.some((v) => v.rule === "deep_workspace_import"),
        "expected deep workspace import violation"
      );
    }
  );
});

test("rejects runtime imports from non-barrel core sources", async () => {
  await withFixture(
    {
      "packages/core/src/runtime/index.ts": "export const driver = null;\n",
      "packages/core/src/state-machines/uses-driver.ts":
        'import { driver } from "../runtime/index.js";\nexport const d = driver;\n'
    },
    async (root) => {
      const result = await scanRuntimeImportBoundaries({ root });
      assert.equal(result.ok, false);
      assert.ok(
        result.violations.some((v) => v.rule === "core_module_must_not_depend_on_runtime"),
        "expected core-side runtime import violation"
      );
    }
  );
});

test("allows the canonical barrel re-export from packages/core/src/index.ts", async () => {
  await withFixture(
    {
      "packages/protocol/src/index.ts": "export const X = 1;\n",
      "packages/core/src/index.ts": "export * from \"./runtime/index.js\";\n",
      "packages/core/src/runtime/index.ts": "export const driver = null;\n"
    },
    async (root) => {
      const result = await scanRuntimeImportBoundaries({ root });
      assert.equal(result.ok, true, JSON.stringify(result.violations, null, 2));
    }
  );
});

test("rejects legacy prompt asset imports inside the runtime module", async () => {
  await withFixture(
    {
      "agents/persona.md": "# legacy persona\n",
      "packages/core/src/runtime/legacy.ts":
        'import persona from "../../../../agents/persona.md";\nexport const p = persona;\n'
    },
    async (root) => {
      const result = await scanRuntimeImportBoundaries({ root });
      assert.equal(result.ok, false);
      assert.ok(
        result.violations.some((v) => v.rule === "legacy_prompt_asset_import"),
        "expected legacy prompt asset violation"
      );
    }
  );
});

test("exposes the rule catalog for documentation consumers", () => {
  assert.ok(RUNTIME_IMPORT_BOUNDARY_RULES.allowedWorkspaceImportsForRuntime.has("@legion/protocol"));
  assert.ok(RUNTIME_IMPORT_BOUNDARY_RULES.forbiddenProviderOrStorageImports.has("eve"));
  assert.ok(RUNTIME_IMPORT_BOUNDARY_RULES.forbiddenHostCliImports.has("claude-code"));
  assert.ok(RUNTIME_IMPORT_BOUNDARY_RULES.legacyPromptRoots.includes("adapters"));
});
