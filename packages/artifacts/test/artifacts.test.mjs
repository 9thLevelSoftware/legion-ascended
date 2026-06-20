import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { formatEntityId, projectSchema } from "@legion/protocol";
import {
  artifactPathForRole,
  canonicalProjectArtifactPath,
  detectCaseCollisions,
  discoverProjectRoot,
  hashContent,
  readJsonArtifact,
  resolveProjectArtifactPath,
  writeRevisionedArtifact
} from "../dist/index.js";

async function withRepository(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-artifacts-"));
  try {
    await mkdir(path.join(root, ".legion", "project"), { recursive: true });
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("canonical project artifact paths reject ambiguous or escaping input", () => {
  const changeId = formatEntityId("change", "legion-next");
  const requirementId = formatEntityId("requirement", "workflow-contract");
  const oracleId = formatEntityId("oracle", "acceptance-proof");

  assert.equal(artifactPathForRole({ role: "constitution" }), ".legion/project/constitution.md");
  assert.equal(artifactPathForRole({ role: "current-spec", requirementId }), ".legion/project/specs/req_workflow-contract.md");
  assert.equal(artifactPathForRole({ role: "proposal", changeId }), ".legion/project/changes/chg_legion-next/change.yaml");
  assert.equal(
    artifactPathForRole({ role: "delta-spec", changeId, requirementId }),
    ".legion/project/changes/chg_legion-next/delta-specs/req_workflow-contract.md"
  );
  assert.equal(
    artifactPathForRole({ role: "oracle", changeId, oracleId }),
    ".legion/project/changes/chg_legion-next/oracle/orc_acceptance-proof.yaml"
  );
  assert.equal(artifactPathForRole({ role: "taskgraph", changeId }), ".legion/project/changes/chg_legion-next/taskgraph.json");
  assert.equal(
    artifactPathForRole({ role: "evidence-index", changeId }),
    ".legion/project/changes/chg_legion-next/evidence-index.json"
  );

  assert.throws(() => canonicalProjectArtifactPath("../outside.json"), /Invalid artifact path/);
  assert.throws(() => canonicalProjectArtifactPath("C:\\temp\\artifact.json"), /Invalid artifact path/);
  assert.throws(() => canonicalProjectArtifactPath(".legion/project/changes/CHG_alpha/change.yaml"), /lowercase/);
  assert.throws(() => canonicalProjectArtifactPath(".legion/project/specs/caf\u00e9.md"), /Invalid artifact path/);
  assert.throws(() => artifactPathForRole({ role: "proposal", changeId: "LEGION-NEXT" }), /Invalid Change ID/);

  const collisions = detectCaseCollisions([
    ".legion/project/specs/api.md",
    ".legion/project/specs/API.md",
    ".legion/project/changes/chg_alpha/change.yaml"
  ]);
  assert.equal(collisions.length, 1);
  assert.match(collisions[0].message, /case-insensitive collision/);
});

test("repository discovery and path resolution stay beneath the real project root", async (t) => {
  await withRepository(async (repositoryRoot) => {
    const nested = path.join(repositoryRoot, "packages", "tooling");
    await mkdir(nested, { recursive: true });
    assert.equal(await discoverProjectRoot(nested), repositoryRoot);

    const resolved = await resolveProjectArtifactPath({
      repositoryRoot,
      artifactPath: ".legion/project/specs/api.md"
    });
    assert.equal(resolved.repositoryPath, ".legion/project/specs/api.md");
    assert.equal(resolved.absolutePath, path.join(repositoryRoot, ".legion", "project", "specs", "api.md"));

    const outside = await mkdtemp(path.join(tmpdir(), "legion-artifacts-outside-"));
    const symlinkPath = path.join(repositoryRoot, ".legion", "project", "specs");
    try {
      await symlink(outside, symlinkPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      await rm(outside, { recursive: true, force: true });
      t.skip(`symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    try {
      await assert.rejects(
        resolveProjectArtifactPath({ repositoryRoot, artifactPath: ".legion/project/specs/escape.md" }),
        /escapes repository root/
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("JSON artifact reads return protocol validation diagnostics with source paths", async () => {
  await withRepository(async (repositoryRoot) => {
    const artifactPath = ".legion/project/project.json";
    const absolutePath = path.join(repositoryRoot, ".legion", "project", "project.json");
    const constitutionBytes = "# Constitution\n";
    const constitutionHash = hashContent(constitutionBytes);

    await writeFile(
      absolutePath,
      JSON.stringify({
        schemaVersion: "0.1.0",
        createdAt: "2026-06-20T00:00:00.000Z",
        kind: "project",
        id: "prj_legion-next",
        slug: "legion-next",
        name: "Legion Next",
        repository: {
          provider: "git",
          defaultBranch: "main"
        },
        policy: {
          constitution: {
            path: ".legion/project/constitution.md",
            sha256: constitutionHash,
            mediaType: "text/markdown"
          },
          currentSpecRoot: ".legion/project/specs",
          changeRoot: ".legion/project/changes",
          adrRoot: ".legion/project/adr",
          riskPolicyRefs: [],
          oraclePolicyRefs: [],
          decisionOwners: [{ kind: "human", id: "dasbl" }]
        }
      }),
      "utf8"
    );

    const valid = await readJsonArtifact({ repositoryRoot, artifactPath, schema: projectSchema });
    assert.equal(valid.ok, true);
    assert.equal(valid.value.id, "prj_legion-next");
    assert.equal(valid.reference.path, artifactPath);

    await writeFile(absolutePath, "{\n  \"schemaVersion\": 7\n", "utf8");
    const invalidJson = await readJsonArtifact({ repositoryRoot, artifactPath, schema: projectSchema });
    assert.equal(invalidJson.ok, false);
    assert.equal(invalidJson.diagnostics[0].code, "invalid_json");
    assert.equal(invalidJson.diagnostics[0].source.path, artifactPath);

    await writeFile(absolutePath, JSON.stringify({ schemaVersion: "0.1.0", kind: "project" }), "utf8");
    const invalidSchema = await readJsonArtifact({ repositoryRoot, artifactPath, schema: projectSchema });
    assert.equal(invalidSchema.ok, false);
    assert.equal(invalidSchema.diagnostics[0].code, "invalid_schema");
    assert.equal(invalidSchema.diagnostics[0].source.path, artifactPath);
  });
});

test("revisioned writes hash content, enforce CAS, and preserve bytes on interruption", async () => {
  await withRepository(async (repositoryRoot) => {
    const changeId = formatEntityId("change", "legion-next");
    const artifactPath = artifactPathForRole({ role: "taskgraph", changeId });
    const initialContent = "{\n  \"tasks\": []\n}\n";
    const first = await writeRevisionedArtifact({
      repositoryRoot,
      artifactPath,
      role: "taskgraph",
      content: initialContent,
      expectedRevision: 0,
      currentRevision: 0,
      mediaType: "application/json"
    });

    assert.equal(first.revision.revision, 1);
    assert.equal(first.revision.artifact.path, artifactPath);
    assert.equal(first.revision.artifact.sha256, hashContent(initialContent));

    const absolutePath = path.join(repositoryRoot, ...artifactPath.split("/"));
    assert.equal(await readFile(absolutePath, "utf8"), initialContent);

    await assert.rejects(
      writeRevisionedArtifact({
        repositoryRoot,
        artifactPath,
        role: "taskgraph",
        content: "{\"tasks\":[\"stale\"]}\n",
        expectedRevision: 0,
        currentRevision: 1
      }),
      /stale artifact revision/
    );
    assert.equal(await readFile(absolutePath, "utf8"), initialContent);

    await assert.rejects(
      writeRevisionedArtifact({
        repositoryRoot,
        artifactPath,
        role: "taskgraph",
        content: "{\"tasks\":[\"interrupted\"]}\n",
        expectedRevision: 1,
        currentRevision: 1,
        beforeCommit: async () => {
          throw new Error("simulated crash before atomic rename");
        }
      }),
      /simulated crash/
    );

    assert.equal(await readFile(absolutePath, "utf8"), initialContent);
    const parentEntries = await readdir(path.dirname(absolutePath));
    assert.equal(parentEntries.some((entry) => entry.includes(".tmp")), false);
  });
});
