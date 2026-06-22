import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  validateWorkerBundles,
  V9_DEFAULT_WORKER_ROLES,
  REQUIRED_WORKFLOW_COMMON_PACKS
} from "../scripts/validate-worker-bundles.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Real-repo happy path: the v9 default runtime ships exactly one bundle per
// role and every bundle references the always-load workflow-common-core pack.
// ---------------------------------------------------------------------------
test("P04-T05 real-repo worker bundles pass schema, capability, and domain-pack checks", async () => {
  const result = await validateWorkerBundles({ root: ROOT });
  assert.equal(
    result.ok,
    true,
    "real-repo worker bundles must pass all checks; violations: " +
      JSON.stringify(result.violations, null, 2)
  );
  assert.equal(result.checks.schemaValidation.violations.length, 0);
  assert.equal(result.checks.capabilityCompleteness.violations.length, 0);
  assert.equal(result.checks.domainPackIntegrity.violations.length, 0);
});

test("P04-T05 real-repo registry covers every v9 default worker role exactly once", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile(path.join(ROOT, "bundles/index.json"), "utf8"));
  const roles = raw.bundles.map((bundle) => bundle.role).sort();
  assert.deepEqual(roles, [...V9_DEFAULT_WORKER_ROLES].sort());
  assert.equal(raw.bundles.length, V9_DEFAULT_WORKER_ROLES.length);
});

test("P04-T05 real-repo registry marks biography, tone, personality as forbidden on every bundle", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile(path.join(ROOT, "bundles/index.json"), "utf8"));
  for (const bundle of raw.bundles) {
    const forbidden = new Set(bundle.promptContentContract.forbiddenSections);
    assert.ok(forbidden.has("biography"), `${bundle.id} must forbid biography`);
    assert.ok(forbidden.has("tone"), `${bundle.id} must forbid tone`);
    assert.ok(forbidden.has("personality"), `${bundle.id} must forbid personality`);
  }
});

test("P04-T05 bundle prompt hashes are protected from Windows CRLF checkout drift", async () => {
  const { readFile } = await import("node:fs/promises");
  const attributes = await readFile(path.join(ROOT, ".gitattributes"), "utf8");
  assert.match(
    attributes,
    /^bundles\/\*\.md\s+text\s+eol=lf$/m,
    "bundle prompt markdown must check out with LF line endings so promptContentContract.instructionsHash is stable across OSes"
  );
});

// ---------------------------------------------------------------------------
// Negative-path coverage. Build a synthetic fixture, mutate one byte, and
// assert the corresponding check rejects it.
// ---------------------------------------------------------------------------

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const MINIMAL_PROMPT = `# explorer\n\n## role\nexplorer\n\n## domain\ncodebase\n\n## capabilities\n- a\n\n## prompt-content-contract\n- No biography.\n`;

function packFrontmatter(packId, version, status = "extracted") {
  return [
    "---",
    `name: ${packId}`,
    `pack_id: ${packId}`,
    `pack_version: ${version}`,
    `pack_status: ${status}`,
    "---",
    "",
    `# ${packId} pack`,
    ""
  ].join("\n");
}

async function buildValidFixture() {
  const prompt = MINIMAL_PROMPT;
  const promptHash = sha256Hex(prompt);
  return {
    "bundles/index.json": JSON.stringify(
      {
        bundles: [
          {
            id: "explorer",
            version: "1.0.0",
            role: "explorer",
            domain: "codebase",
            capabilities: ["a", "b"],
            promptContentContract: {
              instructionsHash: `sha256:${promptHash}`,
              requiredSections: ["role", "domain", "capabilities", "prompt-content-contract"],
              forbiddenSections: ["biography", "tone", "personality"]
            },
            domainPacks: ["workflow-common-core"],
            promptFile: "explorer.md"
          }
        ]
      },
      null,
      2
    ),
    "bundles/explorer.md": prompt,
    "schemas/entities/worker-bundle.schema.json": await readFixtureSchema(),
    "skills/workflow-common-core/SKILL.md": packFrontmatter("workflow-common-core", "1.0.0")
  };
}

async function readFixtureSchema() {
  const { readFile } = await import("node:fs/promises");
  return readFile(path.join(ROOT, "schemas/entities/worker-bundle.schema.json"), "utf8");
}

async function withFixture(mutator, callback) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-bundles-"));
  try {
    for (const [relativePath, contents] of Object.entries(await buildValidFixture())) {
      const absolute = path.join(root, relativePath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, contents, "utf8");
    }
    await mutator(root);
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function setBundle(root, mutator) {
  const indexPath = path.join(root, "bundles/index.json");
  const { readFile, writeFile } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile(indexPath, "utf8"));
  mutator(raw.bundles[0]);
  await writeFile(indexPath, JSON.stringify(raw, null, 2), "utf8");
}

test("P04-T05 rejects empty capabilities array", async () => {
  await withFixture(
    async (root) => {
      await setBundle(root, (bundle) => {
        bundle.capabilities = [];
      });
    },
    async (root) => {
      const result = await validateWorkerBundles({ root });
      assert.equal(result.ok, false);
      assert.ok(
        result.checks.schemaValidation.violations.some((v) =>
          v.message.includes("capabilities must contain at least 1")
        ),
        "schema check should flag missing minItems"
      );
      assert.ok(
        result.checks.capabilityCompleteness.violations.some((v) =>
          v.message.includes("capabilities array must be non-empty")
        ),
        "capability check should flag empty capabilities"
      );
    }
  );
});

test("P04-T05 rejects unknown role", async () => {
  await withFixture(
    async (root) => {
      await setBundle(root, (bundle) => {
        bundle.role = "wizard";
      });
    },
    async (root) => {
      const result = await validateWorkerBundles({ root });
      assert.equal(result.ok, false);
      assert.ok(
        result.checks.capabilityCompleteness.violations.some((v) =>
          v.message.includes("not in the v9 default worker set")
        )
      );
    }
  );
});

test("P04-T05 rejects duplicate capability within a bundle", async () => {
  await withFixture(
    async (root) => {
      await setBundle(root, (bundle) => {
        bundle.capabilities = ["a", "a"];
      });
    },
    async (root) => {
      const result = await validateWorkerBundles({ root });
      assert.equal(result.ok, false);
      assert.ok(
        result.checks.capabilityCompleteness.violations.some((v) =>
          v.message.includes('duplicate capability "a"')
        )
      );
    }
  );
});

test("P04-T05 rejects mismatched instructionsHash", async () => {
  await withFixture(
    async (root) => {
      await setBundle(root, (bundle) => {
        bundle.promptContentContract.instructionsHash = `sha256:${"0".repeat(64)}`;
      });
    },
    async (root) => {
      const result = await validateWorkerBundles({ root });
      assert.equal(result.ok, false);
      assert.ok(
        result.checks.capabilityCompleteness.violations.some((v) =>
          v.message.includes("instructionsHash mismatch")
        )
      );
    }
  );
});

test("P04-T05 rejects prompt file that renders a forbidden heading", async () => {
  await withFixture(
    async (root) => {
      const promptPath = path.join(root, "bundles/explorer.md");
      const { readFile, writeFile } = await import("node:fs/promises");
      const original = await readFile(promptPath, "utf8");
      const mutated = `${original}\n## Biography\nPast glories.\n`;
      await writeFile(promptPath, mutated, "utf8");
      // refresh the hash so the only failure is the heading scan
      await setBundle(root, (bundle) => {
        bundle.promptContentContract.instructionsHash = `sha256:${sha256Hex(mutated)}`;
      });
    },
    async (root) => {
      const result = await validateWorkerBundles({ root });
      assert.equal(result.ok, false);
      assert.ok(
        result.checks.capabilityCompleteness.violations.some((v) =>
          v.message.includes("renders forbidden heading")
        )
      );
    }
  );
});

test("P04-T05 rejects empty forbiddenSections", async () => {
  await withFixture(
    async (root) => {
      await setBundle(root, (bundle) => {
        bundle.promptContentContract.forbiddenSections = [];
      });
    },
    async (root) => {
      const result = await validateWorkerBundles({ root });
      assert.equal(result.ok, false);
      const messages = result.checks.capabilityCompleteness.violations.map((v) => v.message);
      assert.ok(messages.some((m) => m.includes('forbid the canonical section "biography"')));
      assert.ok(messages.some((m) => m.includes('forbid the canonical section "tone"')));
      assert.ok(messages.some((m) => m.includes('forbid the canonical section "personality"')));
    }
  );
});

test("P04-T05 rejects bundle that omits workflow-common-core pack reference", async () => {
  await withFixture(
    async (root) => {
      await setBundle(root, (bundle) => {
        bundle.domainPacks = ["workflow-common-github"];
      });
      // workflow-common-github must exist for the missing-file ecosystem check
      // to be the only failure; this validates that core is a hard requirement.
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(path.join(root, "skills/workflow-common-github"), { recursive: true });
      await writeFile(
        path.join(root, "skills/workflow-common-github/SKILL.md"),
        packFrontmatter("workflow-common-github", "1.0.0"),
        "utf8"
      );
    },
    async (root) => {
      const result = await validateWorkerBundles({ root });
      assert.equal(result.ok, false);
      assert.ok(
        result.checks.domainPackIntegrity.violations.some((v) =>
          v.message.includes('mandatory "workflow-common-core" pack')
        )
      );
    }
  );
});

test("P04-T05 rejects pack file with pack_version below v1.0.0", async () => {
  await withFixture(
    async (root) => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        path.join(root, "skills/workflow-common-core/SKILL.md"),
        packFrontmatter("workflow-common-core", "0.9.0"),
        "utf8"
      );
    },
    async (root) => {
      const result = await validateWorkerBundles({ root });
      assert.equal(result.ok, false);
      assert.ok(
        result.checks.domainPackIntegrity.violations.some((v) =>
          v.message.includes("below the v1.0.0 floor")
        )
      );
    }
  );
});

test("P04-T05 rejects pack file with pack_status other than extracted", async () => {
  await withFixture(
    async (root) => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        path.join(root, "skills/workflow-common-core/SKILL.md"),
        packFrontmatter("workflow-common-core", "1.0.0", "draft"),
        "utf8"
      );
    },
    async (root) => {
      const result = await validateWorkerBundles({ root });
      assert.equal(result.ok, false);
      assert.ok(
        result.checks.domainPackIntegrity.violations.some((v) =>
          v.message.includes('pack_status "draft" must be "extracted"')
        )
      );
    }
  );
});

test("P04-T05 rejects mandatory workflow-common pack file missing from disk", async () => {
  await withFixture(
    async (root) => {
      const { rm } = await import("node:fs/promises");
      await rm(path.join(root, "skills/workflow-common-core/SKILL.md"), { force: true });
    },
    async (root) => {
      const result = await validateWorkerBundles({ root });
      assert.equal(result.ok, false);
      assert.ok(
        result.checks.domainPackIntegrity.violations.some((v) =>
          v.message.includes('mandatory pack "workflow-common-core" is missing')
        )
      );
    }
  );
});

test("P04-T05 exposes the canonical v9 default role set", () => {
  // Regression guard: if ADR-002 ever changes the canonical role set, both
  // this test and the validator need to be updated together. The test pins
  // the public contract so silent drift is impossible.
  assert.deepEqual(V9_DEFAULT_WORKER_ROLES, [
    "explorer",
    "specifier",
    "oracle-author",
    "architect",
    "planner",
    "implementer",
    "task-reviewer",
    "integration-evaluator",
    "release-controller"
  ]);
});

test("P04-T05 pins the mandatory workflow-common pack set", () => {
  assert.deepEqual(REQUIRED_WORKFLOW_COMMON_PACKS, [
    "workflow-common-core",
    "workflow-common-github",
    "workflow-common-memory",
    "workflow-common-domains"
  ]);
});
