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

test('accepts legal protocol and core imports', async () => {
  await withFixture(
    {
      'packages/protocol/src/index.ts': 'export const LEGION_PROTOCOL_VERSION = "0.1.0";\n',
      'packages/core/src/index.ts': 'import { LEGION_PROTOCOL_VERSION } from "@legion/protocol";\nexport const version = LEGION_PROTOCOL_VERSION;\n'
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

test('rejects provider and storage imports in protocol and core', async () => {
  await withFixture(
    {
      'packages/protocol/src/index.ts': 'import { defineAgent } from "eve";\nexport const value = defineAgent;\n',
      'packages/core/src/index.ts': 'import sqlite from "node:sqlite";\nexport const db = sqlite;\n'
    },
    async (root) => {
      const result = await checkPackageBoundaries({ root });

      assert.equal(result.ok, false);
      assert.equal(result.violations.length, 2);
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
      'packages/core/src/persona-loader.ts': 'import persona from "../../../agents/engineering-senior-developer.md";\nexport const senior = persona;\n'
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
