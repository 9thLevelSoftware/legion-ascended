import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  scanDefaultRuntime,
  V9_DEFAULT_RUNTIME_FILES,
  V9_DEFAULT_RUNTIME_DIRECTORIES,
  GOVERNANCE_DOCUMENTS
} from "../scripts/scan-default-runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function withFixture(files, callback) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-default-runtime-"));
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

test("scanner reports the canonical v9 default runtime surface", () => {
  // The four workflow-common-* packs are the always-load surface today; the
  // reserved bundles/ directory will join once v9 worker bundles ship. The
  // governance documents are scanned separately because they govern the
  // contract rather than inject prompt content themselves.
  assert.deepEqual(V9_DEFAULT_RUNTIME_FILES, [
    "skills/workflow-common-core/SKILL.md",
    "skills/workflow-common-github/SKILL.md",
    "skills/workflow-common-memory/SKILL.md",
    "skills/workflow-common-domains/SKILL.md"
  ]);
  assert.ok(
    Array.isArray(V9_DEFAULT_RUNTIME_DIRECTORIES),
    "scanner must reserve the future bundles/ directory"
  );
  assert.ok(
    GOVERNANCE_DOCUMENTS.length > 0,
    "scanner must declare at least one governance document"
  );
  assert.ok(
    GOVERNANCE_DOCUMENTS.some((entry) => entry.path.endsWith("ADR-002-functional-workers.md")),
    "ADR-002 must be in the governance set"
  );
  assert.ok(
    GOVERNANCE_DOCUMENTS.some((entry) =>
      entry.path.endsWith("LEGACY-PERSONA-MAP.md")
    ),
    "LEGACY-PERSONA-MAP must be in the governance set"
  );
});

test("scanner passes on the current v9 default runtime surface", async () => {
  const result = await scanDefaultRuntime({ root: ROOT });
  assert.equal(result.ok, true, JSON.stringify(result.violations, null, 2));
  assert.ok(result.files.length > 0, "scanner must cover at least one file");
  assert.ok(
    result.files.some((f) => f.endsWith("skills/workflow-common-core/SKILL.md")),
    "scanner must include the always-load core pack"
  );
});

test("scanner flags biography prose injected into a v9 default runtime file", async () => {
  // Negative-case fixture: a v9 prompt-content file with persona prose must
  // be flagged. This is the durable regression guard against re-introducing
  // biography/tone/personality prose into the default runtime path.
  await withFixture(
    {
      "skills/workflow-common-core/SKILL.md":
        "# Workflow Common Core\n\nYou are a Staff Engineer, the senior architect who has seen too many production fires.\n\n"
    },
    async (root) => {
      const result = await scanDefaultRuntime({ root });
      assert.equal(result.ok, false, "scanner must reject persona prose");
      assert.ok(result.violations.length > 0, "scanner must report violations");
      const categories = new Set(result.violations.map((v) => v.category));
      assert.ok(
        categories.has("forbidden-prose"),
        `scanner must flag forbidden-prose; got categories: ${[...categories].join(", ")}`
      );
      assert.ok(
        result.violations.some((v) =>
          v.file.endsWith("skills/workflow-common-core/SKILL.md")
        ),
        "violation must reference the injected core pack"
      );
    }
  );
});

test("scanner flags forbidden headings injected into a v9 default runtime file", async () => {
  await withFixture(
    {
      "skills/workflow-common-core/SKILL.md":
        "# Workflow Common Core\n\n## Personality\n\nYou are warm and empathetic.\n\n## Tone\n\nAlways speak in measured, calm sentences.\n"
    },
    async (root) => {
      const result = await scanDefaultRuntime({ root });
      assert.equal(result.ok, false, "scanner must reject forbidden headings");
      const categories = new Set(result.violations.map((v) => v.category));
      assert.ok(
        categories.has("forbidden-heading"),
        `scanner must flag forbidden-heading; got categories: ${[...categories].join(", ")}`
      );
    }
  );
});

test("scanner flags biography headings injected into a v9 default runtime file", async () => {
  await withFixture(
    {
      "skills/workflow-common-core/SKILL.md":
        "# Workflow Common Core\n\n## Biography\n\nThis worker has a rich personal history.\n"
    },
    async (root) => {
      const result = await scanDefaultRuntime({ root });
      assert.equal(result.ok, false, "scanner must reject biography headings");
      assert.ok(
        result.violations.some((v) => v.category === "forbidden-heading" && /Biography/.test(v.excerpt)),
        JSON.stringify(result.violations, null, 2)
      );
    }
  );
});

test("scanner walks future bundles/ directory and flags persona prose there", async () => {
  await withFixture(
    {
      "bundles/planner.bundle/SKILL.md":
        "# Planner Bundle\n\nYou are a planner, a senior architect with decades of experience.\n"
    },
    async (root) => {
      const result = await scanDefaultRuntime({ root });
      assert.equal(result.ok, false, "scanner must walk future bundles/ directory");
      assert.ok(
        result.violations.some((v) =>
          v.file.endsWith("bundles/planner.bundle/SKILL.md")
        ),
        "violation must reference the injected bundle"
      );
    }
  );
});

test("scanner flags legacy v8 boilerplate re-introduced into v9 surface", async () => {
  await withFixture(
    {
      "skills/workflow-common-core/SKILL.md":
        "# Core\n\nALWAYS read the agent personality file before spawning subagents.\n"
    },
    async (root) => {
      const result = await scanDefaultRuntime({ root });
      assert.equal(result.ok, false, "scanner must reject v8 boilerplate");
      const categories = new Set(result.violations.map((v) => v.category));
      assert.ok(
        categories.has("forbidden-v8-persona-boilerplate"),
        `scanner must flag forbidden-v8-persona-boilerplate; got categories: ${[...categories].join(", ")}`
      );
    }
  );
});

test("scanner reports structured violation rows with file, line, category, excerpt", async () => {
  await withFixture(
    {
      "skills/workflow-common-core/SKILL.md":
        "# Core\n\nYou are a planner, the senior architect in the room.\n"
    },
    async (root) => {
      const result = await scanDefaultRuntime({ root });
      assert.equal(result.ok, false);
      assert.ok(result.violations.length > 0);
      const v = result.violations[0];
      assert.ok(typeof v.file === "string" && v.file.length > 0, "violation.file");
      assert.ok(Number.isInteger(v.line) && v.line > 0, "violation.line");
      assert.ok(typeof v.category === "string" && v.category.length > 0, "violation.category");
      assert.ok(typeof v.excerpt === "string" && v.excerpt.length > 0, "violation.excerpt");
      assert.ok(typeof v.pattern === "string" && v.pattern.length > 0, "violation.pattern");
    }
  );
});

test("scanner also walks declared governance documents and keeps them clean", async () => {
  // Governance documents (ADR-002, LEGACY-PERSONA-MAP) are scanned because
  // they declare the contract. They must remain free of forbidden prose in
  // their body even though they are allowed to reference the contract terms.
  const result = await scanDefaultRuntime({ root: ROOT });
  assert.equal(result.ok, true, JSON.stringify(result.violations, null, 2));
  // Governance docs are in scope for scanning if they exist.
  for (const entry of GOVERNANCE_DOCUMENTS) {
    if (result.files.includes(entry.path)) {
      const governanceViolations = result.violations.filter(
        (v) => v.file === entry.path
      );
      assert.deepEqual(
        governanceViolations,
        [],
        `${entry.path} must stay free of forbidden prose: ` +
          JSON.stringify(governanceViolations)
      );
    }
  }
});
