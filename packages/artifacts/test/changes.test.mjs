import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { formatEntityId } from "@legion/protocol";
import {
  createChangeBundle,
  createCurrentSpec,
  diffChangeBundle,
  initProject,
  loadChangeBundle,
  readCurrentSpec,
  updateCurrentSpec,
  validateChangeBundle
} from "../dist/index.js";

const FIXED_TIME = "2026-06-20T00:00:00.000Z";
const LATER_TIME = "2026-06-20T01:00:00.000Z";
const OWNER = { kind: "human", id: "dasbl" };
const PROJECT_ID = "prj_legion-next";
const BASE_GIT_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function withTempRepository(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-change-bundles-"));
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
    projectId: PROJECT_ID,
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

function acceptedDecision(slug) {
  return {
    id: formatEntityId("decision", slug),
    status: "accepted",
    title: "Keep proposed behavior separate from current truth",
    context: "The change needs reviewable proposed behavior before archive can update current specs.",
    alternatives: [
      {
        id: "separate-delta",
        title: "Separate delta artifacts",
        summary: "Keep proposed behavior in change-scoped delta specs.",
        selected: true
      },
      {
        id: "direct-current-edit",
        title: "Direct current spec edit",
        summary: "Edit current specs immediately while work is still proposed.",
        selected: false
      }
    ],
    rationale: "Separate delta artifacts preserve current truth and make archive explicit.",
    supersedes: [],
    approver: OWNER,
    decidedAt: LATER_TIME
  };
}

async function createBaselineSpec(repositoryRoot, slug = "workflow-control") {
  const requirementId = formatEntityId("requirement", slug);
  const created = await createCurrentSpec({
    repositoryRoot,
    document: specDocument(requirementId)
  });
  assert.equal(created.ok, true);
  return created;
}

function changeInput(currentSpec, overrides = {}) {
  const requirementId = currentSpec.document.primaryRequirementId;
  const updatedRequirement = {
    ...currentSpec.document.requirements[0],
    statement: "workflow-control behavior records proposed deltas without mutating current truth.",
    acceptance: {
      ...currentSpec.document.requirements[0].acceptance,
      language: "A proposed change bundle can be validated without editing the current spec."
    }
  };

  return {
    repositoryRoot: overrides.repositoryRoot,
    changeId: formatEntityId("change", "workflow-delta"),
    projectId: PROJECT_ID,
    title: "Add reviewable workflow delta",
    summary: "Keep proposed behavior separate from deployed current specs until archive.",
    owners: [OWNER],
    baseGitSha: BASE_GIT_SHA,
    risk: { tier: "R2", reasons: ["Changes committed workflow intent"] },
    createdAt: FIXED_TIME,
    currentSpecs: [{ requirementId, expectedRevision: currentSpec.document.revision }],
    deltaSpecs: [
      {
        operation: "modify",
        requirementId,
        proposedRequirement: updatedRequirement,
        sections: {
          ...currentSpec.document.sections,
          purpose: "Defines proposed workflow behavior for review before archive."
        },
        rationale: "The proposed behavior should be reviewable before it becomes current truth."
      }
    ],
    design: {
      title: "Reviewable change bundle",
      body: "The change bundle stores proposal metadata, delta specs, design notes, and decisions together."
    },
    decisions: [acceptedDecision("workflow-delta-separation")],
    ...overrides
  };
}

test("P02-T04 creates, loads, validates, and diffs a complete change bundle", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const currentSpec = await createBaselineSpec(repositoryRoot);

    const created = await createChangeBundle(changeInput(currentSpec, { repositoryRoot }));

    assert.equal(created.ok, true);
    assert.equal(created.status, "created");
    assert.equal(created.bundle.change.id, "chg_workflow-delta");
    assert.equal(created.bundle.change.status, "draft");
    assert.equal(created.bundle.change.currentTruth.specRefs[0].path, currentSpec.reference.path);
    assert.equal(created.bundle.change.proposedTruth.deltaSpecRefs.length, 1);
    assert.equal(created.deltaSpecs[0].operation, "modify");
    assert.equal(created.design.title, "Reviewable change bundle");
    assert.equal(created.decisions[0].id, "dec_workflow-delta-separation");

    const currentAfterCreate = await readCurrentSpec({
      repositoryRoot,
      requirementId: currentSpec.document.primaryRequirementId
    });
    assert.equal(currentAfterCreate.ok, true);
    assert.equal(currentAfterCreate.document.sections.purpose, currentSpec.document.sections.purpose);

    const changeFile = await readFile(path.join(repositoryRoot, ".legion", "project", "changes", "chg_workflow-delta", "change.yaml"), "utf8");
    assert.match(changeFile, /"kind":"change-bundle"/);

    const loaded = await loadChangeBundle({ repositoryRoot, changeId: "chg_workflow-delta" });
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.bundle, created.bundle);
    assert.equal(loaded.deltaSpecs[0].proposedRequirement.statement, created.deltaSpecs[0].proposedRequirement.statement);

    const validation = await validateChangeBundle({ repositoryRoot, changeId: "chg_workflow-delta" });
    assert.equal(validation.ok, true);

    assert.deepEqual(diffChangeBundle(created.bundle), {
      added: [],
      modified: [currentSpec.document.primaryRequirementId],
      removed: []
    });
  });
});

test("P02-T04 rejects conflicting delta operations before writing a bundle", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const currentSpec = await createBaselineSpec(repositoryRoot);
    const baseInput = changeInput(currentSpec, { repositoryRoot });
    const result = await createChangeBundle({
      ...baseInput,
      deltaSpecs: [
        baseInput.deltaSpecs[0],
        {
          operation: "remove",
          requirementId: currentSpec.document.primaryRequirementId,
          rationale: "A second operation for the same requirement is ambiguous."
        }
      ]
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.equal(result.diagnostics[0].code, "conflicting_delta_operations");

    const missing = await loadChangeBundle({ repositoryRoot, changeId: "chg_workflow-delta" });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, "not_found");
  });
});

test("P02-T04 detects stale current-spec bases during change validation", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const currentSpec = await createBaselineSpec(repositoryRoot);
    const created = await createChangeBundle(changeInput(currentSpec, { repositoryRoot }));
    assert.equal(created.ok, true);

    const updatedCurrent = await updateCurrentSpec({
      repositoryRoot,
      expectedRevision: currentSpec.document.revision,
      document: {
        ...currentSpec.document,
        sections: {
          ...currentSpec.document.sections,
          purpose: "Current truth changed after the proposed change bundle was created."
        }
      }
    });
    assert.equal(updatedCurrent.ok, true);

    const validation = await validateChangeBundle({ repositoryRoot, changeId: "chg_workflow-delta" });
    assert.equal(validation.ok, false);
    assert.equal(validation.status, "invalid");
    assert.equal(validation.diagnostics[0].code, "stale_change_base");
  });
});

test("P02-T04 returns typed diagnostics for invalid change bundle inputs", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const currentSpec = await createBaselineSpec(repositoryRoot);
    const result = await createChangeBundle({
      ...changeInput(currentSpec, { repositoryRoot }),
      createdAt: "2026-06-20"
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.equal(result.diagnostics[0].code, "invalid_created_at");
  });
});
