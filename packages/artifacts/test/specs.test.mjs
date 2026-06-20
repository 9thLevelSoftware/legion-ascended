import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { formatEntityId } from "@legion/protocol";
import {
  createCurrentSpec,
  deprecateCurrentSpec,
  diffCurrentSpecIndexes,
  initProject,
  listCurrentSpecs,
  readCurrentSpec,
  renameCurrentSpec,
  updateCurrentSpec,
  validateCurrentSpecs
} from "../dist/index.js";

const FIXED_TIME = "2026-06-20T00:00:00.000Z";
const OWNER = { kind: "human", id: "dasbl" };

async function withTempRepository(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-current-specs-"));
  try {
    const initialized = await initProject({
      repositoryRoot: root,
      slug: "legion-next",
      name: "Legion Next",
      decisionOwners: [OWNER],
      createdAt: FIXED_TIME
    });
    assert.equal(initialized.ok, true);
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function requirement(slug, overrides = {}) {
  const id = formatEntityId("requirement", slug);
  return {
    schemaVersion: "0.1.0",
    createdAt: FIXED_TIME,
    kind: "requirement",
    id,
    projectId: "prj_legion-next",
    priority: "must",
    category: "behavior",
    status: "accepted",
    statement: `${slug} behavior is deployed and reviewable.`,
    acceptance: {
      language: `${slug} acceptance is deterministic.`,
      criteria: [`${slug} criterion`],
      oracleRefs: []
    },
    traceRefs: [
      {
        path: `.legion/project/specs/${id}.md`,
        anchor: id,
        relation: "defines",
        entity: { kind: "requirement", id }
      }
    ],
    supersedes: [],
    ...overrides
  };
}

function specDocument(primaryRequirementId, overrides = {}) {
  const capabilityId = primaryRequirementId.replace(/^req_/, "");
  return {
    primaryRequirementId,
    capability: {
      id: capabilityId,
      title: `${capabilityId} capability`,
      status: "active"
    },
    requirements: [requirement(capabilityId)],
    sections: {
      purpose: "Defines the deployed workflow behavior for this capability.",
      behaviors: "The workflow tool applies the accepted behavior consistently.",
      constraints: "State ownership remains under .legion/project for committed intent.",
      scenarios: "A maintained project validates the current capability specification.",
      interfaces: "Artifact services expose typed operations for this capability.",
      compatibility: "Legacy migration remains read-only until explicit import.",
      failureModes: "Invalid, duplicate, stale, or unresolved requirements block acceptance.",
      traceIds: [primaryRequirementId]
    },
    ...overrides
  };
}

test("P02-T03 creates, reads, lists, and deterministically indexes current specs", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const requirementId = formatEntityId("requirement", "workflow-control");
    const created = await createCurrentSpec({
      repositoryRoot,
      document: specDocument(requirementId)
    });

    assert.equal(created.ok, true);
    assert.equal(created.status, "created");
    assert.equal(created.document.revision, 1);
    assert.equal(created.artifactPath, ".legion/project/specs/req_workflow-control.md");

    const markdown = await readFile(path.join(repositoryRoot, ".legion", "project", "specs", "req_workflow-control.md"), "utf8");
    assert.match(markdown, /^---\n\{/);
    assert.match(markdown, /^## Purpose/m);
    assert.match(markdown, /^## Trace IDs/m);

    const read = await readCurrentSpec({ repositoryRoot, requirementId });
    assert.equal(read.ok, true);
    assert.equal(read.document.primaryRequirementId, requirementId);
    assert.equal(read.revision.revision, 1);

    const firstList = await listCurrentSpecs({ repositoryRoot });
    const secondList = await listCurrentSpecs({ repositoryRoot });
    assert.equal(firstList.ok, true);
    assert.equal(secondList.ok, true);
    assert.deepEqual(secondList.index, firstList.index);
    assert.equal(firstList.index.entries[0].requirements[0].id, requirementId);
    assert.equal(firstList.indexHash, secondList.indexHash);

    const validation = await validateCurrentSpecs({ repositoryRoot });
    assert.equal(validation.ok, true);
    assert.deepEqual(validation.index, firstList.index);
  });
});

test("P02-T03 ignores non-file .md entries when listing current specs", async () => {
  await withTempRepository(async (repositoryRoot) => {
    await mkdir(path.join(repositoryRoot, ".legion", "project", "specs", "req_directory.md"), { recursive: true });

    const result = await listCurrentSpecs({ repositoryRoot });

    assert.equal(result.ok, true);
    assert.deepEqual(result.index.entries, []);
  });
});

test("P02-T03 rejects duplicate requirement IDs across specs with both source locations", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const sharedRequirement = requirement("shared-contract", {
      traceRefs: [
        {
          path: ".legion/project/specs/req_first-capability.md",
          anchor: "req_shared-contract",
          relation: "defines",
          entity: { kind: "requirement", id: "req_shared-contract" }
        }
      ]
    });

    const first = await createCurrentSpec({
      repositoryRoot,
      document: specDocument(formatEntityId("requirement", "first-capability"), {
        requirements: [requirement("first-capability"), sharedRequirement],
        sections: {
          ...specDocument(formatEntityId("requirement", "first-capability")).sections,
          traceIds: ["req_first-capability", "req_shared-contract"]
        }
      })
    });
    assert.equal(first.ok, true);

    const second = await createCurrentSpec({
      repositoryRoot,
      document: specDocument(formatEntityId("requirement", "second-capability"), {
        requirements: [
          requirement("second-capability"),
          {
            ...requirement("shared-contract"),
            traceRefs: [
              {
                path: ".legion/project/specs/req_second-capability.md",
                anchor: "req_shared-contract",
                relation: "defines",
                entity: { kind: "requirement", id: "req_shared-contract" }
              }
            ]
          }
        ],
        sections: {
          ...specDocument(formatEntityId("requirement", "second-capability")).sections,
          traceIds: ["req_second-capability", "req_shared-contract"]
        }
      })
    });

    assert.equal(second.ok, false);
    assert.equal(second.status, "invalid");
    assert.equal(second.diagnostics[0].code, "duplicate_requirement_id");
    assert.match(second.diagnostics[0].message, /req_shared-contract/);
    assert.match(second.diagnostics[0].message, /req_first-capability\.md/);
    assert.match(second.diagnostics[0].message, /req_second-capability\.md/);

    const missing = await readCurrentSpec({ repositoryRoot, requirementId: "req_second-capability" });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, "not_found");
  });
});

test("P02-T03 classifies semantic spec index diffs", () => {
  const before = {
    schemaVersion: "0.1.0",
    kind: "current-spec-index",
    entries: [
      {
        path: ".legion/project/specs/req_alpha.md",
        revision: 1,
        capability: { id: "alpha", title: "Alpha", status: "active" },
        primaryRequirementId: "req_alpha",
        requirements: [{ id: "req_alpha", contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
        artifact: { path: ".legion/project/specs/req_alpha.md", sha256: "sha256:1111111111111111111111111111111111111111111111111111111111111111", mediaType: "text/markdown" }
      },
      {
        path: ".legion/project/specs/req_removed.md",
        revision: 1,
        capability: { id: "removed", title: "Removed", status: "active" },
        primaryRequirementId: "req_removed",
        requirements: [{ id: "req_removed", contentHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
        artifact: { path: ".legion/project/specs/req_removed.md", sha256: "sha256:2222222222222222222222222222222222222222222222222222222222222222", mediaType: "text/markdown" }
      },
      {
        path: ".legion/project/specs/req_moved.md",
        revision: 1,
        capability: { id: "moved", title: "Moved", status: "active" },
        primaryRequirementId: "req_moved",
        requirements: [{ id: "req_moved", contentHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" }],
        artifact: { path: ".legion/project/specs/req_moved.md", sha256: "sha256:3333333333333333333333333333333333333333333333333333333333333333", mediaType: "text/markdown" }
      }
    ]
  };
  const after = {
    schemaVersion: "0.1.0",
    kind: "current-spec-index",
    entries: [
      {
        ...before.entries[0],
        revision: 2,
        requirements: [{ id: "req_alpha", contentHash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" }]
      },
      {
        path: ".legion/project/specs/req_added.md",
        revision: 1,
        capability: { id: "added", title: "Added", status: "active" },
        primaryRequirementId: "req_added",
        requirements: [{ id: "req_added", contentHash: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }],
        artifact: { path: ".legion/project/specs/req_added.md", sha256: "sha256:4444444444444444444444444444444444444444444444444444444444444444", mediaType: "text/markdown" }
      },
      {
        ...before.entries[2],
        path: ".legion/project/specs/req_moved-new.md",
        artifact: { path: ".legion/project/specs/req_moved-new.md", sha256: "sha256:3333333333333333333333333333333333333333333333333333333333333333", mediaType: "text/markdown" }
      },
      {
        path: ".legion/project/specs/req_moved-modified-new.md",
        revision: 2,
        capability: { id: "moved-modified", title: "Moved Modified", status: "active" },
        primaryRequirementId: "req_moved-modified",
        requirements: [{ id: "req_moved-modified", contentHash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" }],
        artifact: { path: ".legion/project/specs/req_moved-modified-new.md", sha256: "sha256:5555555555555555555555555555555555555555555555555555555555555555", mediaType: "text/markdown" }
      }
    ]
  };
  before.entries.push({
    path: ".legion/project/specs/req_moved-modified.md",
    revision: 1,
    capability: { id: "moved-modified", title: "Moved Modified", status: "active" },
    primaryRequirementId: "req_moved-modified",
    requirements: [{ id: "req_moved-modified", contentHash: "sha256:9999999999999999999999999999999999999999999999999999999999999999" }],
    artifact: { path: ".legion/project/specs/req_moved-modified.md", sha256: "sha256:6666666666666666666666666666666666666666666666666666666666666666", mediaType: "text/markdown" }
  });

  assert.deepEqual(diffCurrentSpecIndexes({ before, after }), {
    added: ["req_added"],
    modified: ["req_alpha", "req_moved-modified"],
    removed: ["req_removed"],
    moved: [
      {
        id: "req_moved",
        from: ".legion/project/specs/req_moved.md",
        to: ".legion/project/specs/req_moved-new.md"
      },
      {
        id: "req_moved-modified",
        from: ".legion/project/specs/req_moved-modified.md",
        to: ".legion/project/specs/req_moved-modified-new.md"
      }
    ]
  });
});

test("P02-T03 blocks stale edits and supports rename and deprecate operations", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const requirementId = formatEntityId("requirement", "stale-edit");
    const created = await createCurrentSpec({
      repositoryRoot,
      document: specDocument(requirementId)
    });
    assert.equal(created.ok, true);

    const renamed = await renameCurrentSpec({
      repositoryRoot,
      requirementId,
      expectedRevision: 1,
      capability: { id: "stale-edit", title: "Renamed stale edit capability" }
    });
    assert.equal(renamed.ok, true);
    assert.equal(renamed.status, "renamed");
    assert.equal(renamed.document.revision, 2);
    assert.equal(renamed.document.capability.title, "Renamed stale edit capability");

    const changedId = await renameCurrentSpec({
      repositoryRoot,
      requirementId,
      expectedRevision: 2,
      capability: { id: "different-capability", title: "Different capability" }
    });
    assert.equal(changedId.ok, false);
    assert.equal(changedId.status, "invalid");
    assert.equal(changedId.diagnostics[0].code, "capability_id_change_blocked");

    const stale = await updateCurrentSpec({
      repositoryRoot,
      expectedRevision: 1,
      document: {
        ...renamed.document,
        sections: {
          ...renamed.document.sections,
          purpose: "A stale write must not replace the accepted current spec."
        }
      }
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.diagnostics[0].code, "stale_spec_revision");

    const afterStale = await readCurrentSpec({ repositoryRoot, requirementId });
    assert.equal(afterStale.ok, true);
    assert.equal(afterStale.document.sections.purpose, renamed.document.sections.purpose);

    const deprecated = await deprecateCurrentSpec({
      repositoryRoot,
      requirementId,
      expectedRevision: 2,
      deprecatedAt: "2026-06-20T01:00:00.000Z",
      reason: "Capability replaced by a later accepted spec."
    });
    assert.equal(deprecated.ok, true);
    assert.equal(deprecated.status, "deprecated");
    assert.equal(deprecated.document.capability.status, "deprecated");
    assert.equal(deprecated.document.requirements[0].status, "archived");
  });
});

test("P02-T03 validation reports unresolved placeholders, contradictory status, and orphan trace IDs", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const requirementId = formatEntityId("requirement", "validation");
    const result = await createCurrentSpec({
      repositoryRoot,
      document: specDocument(requirementId, {
        capability: {
          id: "validation",
          title: "Validation",
          status: "deprecated",
          deprecatedAt: "2026-06-20T01:00:00.000Z",
          deprecationReason: "Testing validation diagnostics."
        },
        requirements: [requirement("validation")],
        sections: {
          ...specDocument(requirementId).sections,
          purpose: "TODO: replace this placeholder.",
          traceIds: [requirementId, "req_missing-trace"]
        }
      })
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.diagnostics.some((diagnostic) => diagnostic.code === "unresolved_placeholder"),
      true
    );
    assert.equal(
      result.diagnostics.some((diagnostic) => diagnostic.code === "contradictory_status"),
      true
    );
    assert.equal(
      result.diagnostics.some((diagnostic) => diagnostic.code === "orphan_trace_id"),
      true
    );
  });
});
