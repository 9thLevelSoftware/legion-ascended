import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("P02-T04 validates secondary-requirement deltas against the recorded base spec path", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const primaryRequirementId = formatEntityId("requirement", "workflow-control");
    const secondaryRequirementId = formatEntityId("requirement", "secondary-behavior");
    const secondaryRequirement = requirement("secondary-behavior", {
      traceRefs: [
        {
          path: `.legion/project/specs/${primaryRequirementId}.md`,
          anchor: secondaryRequirementId,
          relation: "defines",
          entity: { kind: "requirement", id: secondaryRequirementId }
        }
      ]
    });
    const createdSpec = await createCurrentSpec({
      repositoryRoot,
      document: specDocument(primaryRequirementId, {
        requirements: [requirement("workflow-control"), secondaryRequirement],
        sections: {
          ...specDocument(primaryRequirementId).sections,
          traceIds: [primaryRequirementId, secondaryRequirementId]
        }
      })
    });
    assert.equal(createdSpec.ok, true);

    const updatedSecondary = {
      ...createdSpec.document.requirements[1],
      statement: "secondary-behavior deltas validate against their recorded base spec artifact."
    };
    const created = await createChangeBundle({
      ...changeInput(createdSpec, { repositoryRoot }),
      deltaSpecs: [
        {
          operation: "modify",
          requirementId: secondaryRequirementId,
          proposedRequirement: updatedSecondary,
          sections: createdSpec.document.sections,
          rationale: "Secondary requirements live inside the primary capability spec."
        }
      ]
    });
    assert.equal(created.ok, true);

    const validation = await validateChangeBundle({ repositoryRoot, changeId: "chg_workflow-delta" });
    assert.equal(validation.ok, true);
  });
});

test("P02-T04 rejects proposed requirement IDs that differ from the delta target", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const currentSpec = await createBaselineSpec(repositoryRoot);
    const baseInput = changeInput(currentSpec, { repositoryRoot });
    const result = await createChangeBundle({
      ...baseInput,
      deltaSpecs: [
        {
          ...baseInput.deltaSpecs[0],
          proposedRequirement: requirement("different-target")
        }
      ]
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.equal(result.diagnostics[0].code, "invalid_delta_spec");
  });
});

test("P02-T04 preflights bundle artifact paths before writing partial deltas", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const currentSpec = await createBaselineSpec(repositoryRoot);
    const changeRoot = path.join(repositoryRoot, ".legion", "project", "changes", "chg_workflow-delta");
    await mkdir(changeRoot, { recursive: true });
    await writeFile(path.join(changeRoot, "design.md"), "pre-existing design", "utf8");

    const result = await createChangeBundle(changeInput(currentSpec, { repositoryRoot }));

    assert.equal(result.ok, false);
    assert.equal(result.status, "conflict");
    assert.equal(result.diagnostics[0].code, "artifact_already_exists");
    await assert.rejects(
      readFile(path.join(changeRoot, "delta-specs", "req_workflow-control.md"), "utf8"),
      /ENOENT/
    );
  });
});

test("P02-T04 validates add deltas against current truth", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const currentSpec = await createBaselineSpec(repositoryRoot);
    const addedRequirement = requirement("new-capability", {
      traceRefs: [
        {
          path: ".legion/project/specs/req_new-capability.md",
          anchor: "req_new-capability",
          relation: "defines",
          entity: { kind: "requirement", id: "req_new-capability" }
        }
      ]
    });
    const created = await createChangeBundle({
      ...changeInput(currentSpec, { repositoryRoot }),
      deltaSpecs: [
        {
          operation: "add",
          requirementId: addedRequirement.id,
          proposedRequirement: addedRequirement,
          sections: {
            ...currentSpec.document.sections,
            traceIds: [addedRequirement.id]
          },
          rationale: "Propose a new requirement before it exists in current truth."
        }
      ]
    });
    assert.equal(created.ok, true);

    const currentTruthCollision = await createCurrentSpec({
      repositoryRoot,
      document: specDocument(addedRequirement.id, {
        requirements: [addedRequirement],
        sections: {
          ...specDocument(addedRequirement.id).sections,
          traceIds: [addedRequirement.id]
        }
      })
    });
    assert.equal(currentTruthCollision.ok, true);

    const validation = await validateChangeBundle({ repositoryRoot, changeId: "chg_workflow-delta" });
    assert.equal(validation.ok, false);
    assert.equal(validation.status, "invalid");
    assert.equal(validation.diagnostics[0].code, "add_delta_targets_existing_requirement");
  });
});

test("P02-T04 rejects loaded bundles whose identity no longer matches their path", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const currentSpec = await createBaselineSpec(repositoryRoot);
    const created = await createChangeBundle(changeInput(currentSpec, { repositoryRoot }));
    assert.equal(created.ok, true);

    const proposalPath = path.join(repositoryRoot, ".legion", "project", "changes", "chg_workflow-delta", "change.yaml");
    const bundle = JSON.parse(await readFile(proposalPath, "utf8"));
    bundle.change.id = "chg_other-delta";
    await writeFile(proposalPath, JSON.stringify(bundle), "utf8");

    const loaded = await loadChangeBundle({ repositoryRoot, changeId: "chg_workflow-delta" });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.status, "invalid");
    assert.equal(loaded.diagnostics[0].code, "change_bundle_identity_mismatch");
  });
});

test("P02-T04 rejects delta frontmatter that disagrees with the bundle entry", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const currentSpec = await createBaselineSpec(repositoryRoot);
    const created = await createChangeBundle(changeInput(currentSpec, { repositoryRoot }));
    assert.equal(created.ok, true);

    const deltaPath = path.join(
      repositoryRoot,
      ".legion",
      "project",
      "changes",
      "chg_workflow-delta",
      "delta-specs",
      "req_workflow-control.md"
    );
    const deltaMarkdown = await readFile(deltaPath, "utf8");
    await writeFile(deltaPath, deltaMarkdown.replace('"baseCurrentSpecRevision":1', '"baseCurrentSpecRevision":2'), "utf8");

    const loaded = await loadChangeBundle({ repositoryRoot, changeId: "chg_workflow-delta" });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.status, "invalid");
    assert.equal(loaded.diagnostics[0].code, "delta_artifact_mismatch");
    assert.equal(loaded.diagnostics[1].code, "delta_frontmatter_mismatch");
  });
});

test("P02-T04 returns typed diagnostics for invalid change bundle inputs", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const currentSpec = await createBaselineSpec(repositoryRoot);
    const invalidTimestamp = await createChangeBundle({
      ...changeInput(currentSpec, { repositoryRoot }),
      createdAt: "2026-06-20"
    });

    assert.equal(invalidTimestamp.ok, false);
    assert.equal(invalidTimestamp.status, "invalid");
    assert.equal(invalidTimestamp.diagnostics[0].code, "invalid_created_at");

    const noOwners = await createChangeBundle({
      ...changeInput(currentSpec, { repositoryRoot }),
      owners: []
    });
    assert.equal(noOwners.ok, false);
    assert.equal(noOwners.status, "invalid");
    assert.equal(noOwners.diagnostics[0].code, "invalid_owners");

    const noDeltas = await createChangeBundle({
      ...changeInput(currentSpec, { repositoryRoot }),
      deltaSpecs: []
    });
    assert.equal(noDeltas.ok, false);
    assert.equal(noDeltas.status, "invalid");
    assert.equal(noDeltas.diagnostics[0].code, "invalid_delta_specs");

    const invalidBaseGitSha = await createChangeBundle({
      ...changeInput(currentSpec, { repositoryRoot }),
      baseGitSha: "not-a-git-sha"
    });
    assert.equal(invalidBaseGitSha.ok, false);
    assert.equal(invalidBaseGitSha.status, "invalid");
    assert.equal(invalidBaseGitSha.diagnostics[0].code, "invalid_base_git_sha");
  });
});
