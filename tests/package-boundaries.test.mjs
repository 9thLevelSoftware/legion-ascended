import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkPackageBoundaries } from '../scripts/check-package-boundaries.mjs';

async function withFixture(files, callback) {
  const root = await mkdtemp(path.join(tmpdir(), 'legion-boundaries-'));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath = path.join(root, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents, 'utf8');
    }
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('accepts legal protocol, core, artifacts, board, store, and legacy bridge imports', async () => {
  await withFixture(
    {
      'packages/protocol/src/index.ts': 'export const LEGION_PROTOCOL_VERSION = "0.1.0";\n',
      'packages/core/src/index.ts': 'import { LEGION_PROTOCOL_VERSION } from "@legion/protocol";\nexport const version = LEGION_PROTOCOL_VERSION;\n',
      'packages/artifacts/src/index.ts': 'import { stableStateStringify } from "@legion/core";\nimport { artifactPathSchema } from "@legion/protocol";\nexport const value = stableStateStringify(artifactPathSchema.parse("a.txt"));\n',
      'packages/board-store/src/index.ts': 'import type { TaskId } from "@legion/protocol";\nexport type BoardTaskId = TaskId;\n',
      'packages/store-sqlite/src/index.ts': 'import { DatabaseSync } from "node:sqlite";\nimport { BOARD_SCHEMA_VERSION } from "@legion/board-store";\nexport const value = [DatabaseSync, BOARD_SCHEMA_VERSION];\n',
      'packages/board/src/index.ts': 'import { BOARD_SCHEMA_VERSION } from "@legion/board-store";\nexport const version = BOARD_SCHEMA_VERSION;\n',
      'packages/legacy-bridge/src/index.ts': 'import { PROJECT_ARTIFACT_PATHS } from "@legion/artifacts";\nimport { LEGION_PROTOCOL_VERSION } from "@legion/protocol";\nexport const value = [PROJECT_ARTIFACT_PATHS.projectManifest, LEGION_PROTOCOL_VERSION];\n'
    },
    async (root) => {
      const result = await checkPackageBoundaries({ root });

      assert.equal(result.ok, true);
      assert.deepEqual(result.violations, []);
    }
  );
});

test('rejects protocol imports from core', async () => {
  await withFixture(
    {
      'packages/protocol/src/index.ts': 'import { LEGION_CORE_VERSION } from "@legion/core";\nexport const version = LEGION_CORE_VERSION;\n',
      'packages/core/src/index.ts': 'export const LEGION_CORE_VERSION = "0.1.0";\n'
    },
    async (root) => {
      const result = await checkPackageBoundaries({ root });

      assert.equal(result.ok, false);
      assert.match(result.violations[0].message, /@legion\/protocol cannot import @legion\/core/);
    }
  );
});

test('rejects deep imports across workspace package exports', async () => {
  await withFixture(
    {
      'packages/protocol/src/internal.ts': 'export const internal = true;\n',
      'packages/core/src/index.ts': 'import { internal } from "@legion/protocol/src/internal";\nexport const value = internal;\n'
    },
    async (root) => {
      const result = await checkPackageBoundaries({ root });

      assert.equal(result.ok, false);
      assert.match(result.violations[0].message, /deep import/);
    }
  );
});

test('rejects provider and storage imports outside the SQLite provider package', async () => {
  await withFixture(
    {
      'packages/protocol/src/index.ts': 'import { defineAgent } from "eve";\nexport const value = defineAgent;\n',
      'packages/core/src/index.ts': 'import sqlite from "node:sqlite";\nexport const db = sqlite;\n',
      'packages/artifacts/src/storage.ts': 'import sqlite from "node:sqlite";\nexport const db = sqlite;\n',
      'packages/board-store/src/storage.ts': 'import sqlite from "node:sqlite";\nexport const db = sqlite;\n',
      'packages/board/src/storage.ts': 'import sqlite from "node:sqlite";\nexport const db = sqlite;\n',
      'packages/store-sqlite/src/index.ts': 'import { DatabaseSync } from "node:sqlite";\nexport const db = DatabaseSync;\n'
    },
    async (root) => {
      const result = await checkPackageBoundaries({ root });

      assert.equal(result.ok, false);
      assert.equal(result.violations.length, 5);
      assert.ok(result.violations.every((violation) => /forbidden provider or storage import/.test(violation.message)));
    }
  );
});

test('rejects workspace package imports of legacy prompt assets', async () => {
  await withFixture(
    {
      'commands/start.md': '# legacy start command\n',
      'agents/engineering-senior-developer.md': '# legacy persona\n',
      'packages/protocol/src/index.ts': 'export const LEGION_PROTOCOL_VERSION = "0.1.0";\n',
      'packages/core/src/command-loader.ts': 'import startCommand from "../../../commands/start.md";\nexport const command = startCommand;\n',
      'packages/core/src/persona-loader.ts': 'import persona from "../../../agents/engineering-senior-developer.md";\nexport const senior = persona;\n',
      'packages/artifacts/src/legacy-loader.ts': 'import startCommand from "../../../commands/start.md";\nexport const command = startCommand;\n'
    },
    async (root) => {
      const result = await checkPackageBoundaries({ root });
      assert.equal(result.ok, false);
      assert.ok(
        result.violations.some((violation) => violation.message.includes('cannot import legacy prompt asset')),
        'expected legacy prompt import violation'
      );
    }
  );
});
