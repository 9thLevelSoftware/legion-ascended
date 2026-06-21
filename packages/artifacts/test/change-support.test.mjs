import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { formatEntityId } from "@legion/protocol";
import {
  createChangeBundle,
  createCurrentSpec,
  createOracleArtifact,
  deriveOracleManifest,
  initProject,
  readEvidenceIndex,
  readOracleArtifact,
  readTaskGraph,
  stableProtocolJson,
  updateOracleArtifact,
  writeEvidenceIndex,
  writeTaskGraph
} from "../dist/index.js";

const FIXED_TIME = "2026-06-20T00:00:00.000Z";
const LATER_TIME = "2026-06-20T01:00:00.000Z";
const OWNER = { kind: "human", id: "dasbl" };
const PROJECT_ID = "prj_legion-next";
const CHANGE_ID = "chg_workflow-delta";
const OTHER_CHANGE_ID = "chg_other-change";
const BASE_GIT_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OUTPUT_HASH = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const STALE_HASH = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

async function withTempRepository(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-change-support-"));
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

function requirement(slug) {
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
    supersedes: []
  };
}

function specDocument(primaryRequirementId, requirements = [requirement("workflow-control")]) {
  return {
    primaryRequirementId,
    capability: {
      id: primaryRequirementId.replace(/^req_/, ""),
      title: "Workflow control capability",
      status: "active"
    },
    requirements,
    sections: {
      purpose: "Keep the workflow artifact model deterministic.",
      behaviors: "Change support artifacts are tracked as reviewable files.",
      constraints: "Mutable execution logs are not committed as truth.",
      scenarios: "A reviewer can inspect oracle, taskgraph, and evidence references.",
      interfaces: "@legion/artifacts",
      compatibility: "Preserve v8 package behavior while v9 artifacts are additive.",
      failureModes: "Invalid provenance fails with typed diagnostics.",
      traceIds: requirements.map((entry) => entry.id)
    }
  };
}

function riskProfile() {
  return {
    tier: "R2",
    reasons: ["artifact service change"]
  };
}

function acceptedDecision(slug) {
  return {
    id: formatEntityId("decision", slug),
    status: "accepted",
    title: `${slug} decision`,
    context: "P02-T05 needs a formal decision reference for the change support artifacts.",
    alternatives: [
      {
        id: "selected",
        title: "Track as Git artifact",
        summary: "Keeps reviewable intent separate from runtime logs.",
        selected: true
      },
      {
        id: "rejected",
        title: "Track in runtime board only",
        summary: "Would hide accepted intent from Git review.",
        selected: false
      }
    ],
    rationale: "The selected option preserves durable artifact review.",
    supersedes: [],
    approver: OWNER,
    decidedAt: FIXED_TIME
  };
}

function changeInput(currentSpec, overrides = {}) {
  const updatedRequirement = {
    ...currentSpec.document.requirements[0],
    statement: "workflow-control behavior is deployed, reviewable, and traceable through P02-T05 artifacts."
  };
  return {
    repositoryRoot: overrides.repositoryRoot,
    changeId: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Workflow delta",
    summary: "Add change support artifacts to the workflow delta.",
    owners: [OWNER],
    baseGitSha: BASE_GIT_SHA,
    risk: riskProfile(),
    createdAt: FIXED_TIME,
    currentSpecs: [
      {
        requirementId: currentSpec.document.primaryRequirementId,
        expectedRevision: currentSpec.document.revision
      }
    ],
    deltaSpecs: [
      {
        operation: "modify",
        requirementId: updatedRequirement.id,
        proposedRequirement: updatedRequirement,
        sections: currentSpec.document.sections,
        rationale: "Change support artifacts are needed before traceability validation."
      }
    ],
    design: {
      title: "Change support artifacts",
      body: "Oracle, taskgraph, and evidence-index artifacts remain Git reviewable while bulk logs stay outside Git."
    },
    decisions: [acceptedDecision("artifact-support")]
  };
}

async function createBaselineChange(repositoryRoot) {
  const requirementDocument = requirement("workflow-control");
  const currentSpec = await createCurrentSpec({
    repositoryRoot,
    document: specDocument(requirementDocument.id, [requirementDocument])
  });
  if (!currentSpec.ok) {
    throw new Error(JSON.stringify(currentSpec.diagnostics));
  }

  const change = await createChangeBundle(changeInput(currentSpec, { repositoryRoot }));
  if (!change.ok) {
    throw new Error(JSON.stringify(change.diagnostics));
  }
  return {
    currentSpec,
    change: {
      ...change,
      bundle: {
        ...change.bundle,
        artifactRevisions: [change.revision, ...change.bundle.artifactRevisions]
      }
    }
  };
}

function findRevision(bundle, role) {
  const revision = bundle.artifactRevisions.find((entry) => entry.role === role);
  assert.ok(revision, `missing ${role} revision`);
  return revision;
}

async function writeProjectJson(repositoryRoot, artifactPath, value) {
  const absolutePath = path.join(repositoryRoot, ...artifactPath.split("/"));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, stableProtocolJson(value), "utf8");
}

function oracleDocument(currentSpec, change, overrides = {}) {
  const requirementId = currentSpec.document.primaryRequirementId;
  return {
    schemaVersion: "0.1.0",
    createdAt: FIXED_TIME,
    kind: "oracle",
    id: "orc_acceptance-proof",
    projectId: PROJECT_ID,
    title: "Acceptance proof",
    owner: OWNER,
    protectedPaths: [currentSpec.artifactPath],
    sourceArtifacts: [change.reference],
    expected: {
      preconditions: ["The change bundle validates before oracle execution."],
      postconditions: ["The acceptance command exits with the expected code."],
      evidence: ["A command output hash is recorded in the evidence index."]
    },
    requirementCoverage: [
      {
        requirementId,
        coverage: "primary",
        criteria: ["The workflow-control requirement is covered by the acceptance proof."]
      }
    ],
    traceRefs: [
      {
        path: `.legion/project/changes/${CHANGE_ID}/oracle/orc_acceptance-proof.yaml`,
        anchor: "orc_acceptance-proof",
        relation: "verifies",
        entity: { kind: "requirement", id: requirementId }
      }
    ],
    type: "executable",
    execution: {
      mode: "command",
      command: "pnpm",
      args: ["run", "validate:next"],
      expectedExitCode: 0,
      timeoutMs: 120000
    },
    ...overrides
  };
}

function taskContract(id, currentSpec, change, oracle, artifactInputs, overrides = {}) {
  return {
    schemaVersion: "0.1.0",
    createdAt: FIXED_TIME,
    kind: "task-contract",
    id,
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    revision: 1,
    title: `${id} task`,
    objective: "Implement deterministic change support artifacts.",
    requirementIds: [currentSpec.document.primaryRequirementId],
    dependencies: [],
    context: {
      specRefs: [currentSpec.reference],
      designRefs: [findRevision(change.bundle, "design").artifact],
      predecessorArtifacts: artifactInputs.map((entry) => entry.artifact)
    },
    scope: {
      read: [currentSpec.artifactPath],
      write: [".legion/project/changes/chg_workflow-delta/taskgraph.json"],
      forbidden: [".legion/var/runtime.sqlite"],
      sequentialFiles: []
    },
    interfaces: {
      consumes: [
        {
          name: "ChangeBundle",
          description: "The current change proposal and delta artifacts."
        }
      ],
      produces: [
        {
          name: "TaskGraph",
          description: "A task contract graph for the change."
        }
      ]
    },
    oracleRefs: [oracle.document.id],
    verification: [
      {
        command: "pnpm",
        args: ["run", "validate:next"],
        expectedExitCode: 0,
        timeoutMs: 120000
      }
    ],
    risk: riskProfile(),
    approvals: [],
    completion: {
      expectedArtifacts: [findRevision(change.bundle, "proposal").artifact],
      requiredEvidence: ["validate-next output hash"],
      blockedConditions: ["Validation output is missing or unverifiable."]
    },
    ...overrides
  };
}

function evidenceBundle(currentSpec, commandOutputHash = OUTPUT_HASH) {
  return {
    schemaVersion: "0.1.0",
    createdAt: FIXED_TIME,
    kind: "evidence",
    id: "evd_validate-next",
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    taskId: "tsk_validate-next",
    runId: "run_validate-next",
    sensitivity: "internal",
    retention: {
      class: "audit"
    },
    traceRefs: [
      {
        path: ".legion/project/changes/chg_workflow-delta/evidence-index.json",
        relation: "verifies",
        entity: { kind: "requirement", id: currentSpec.document.primaryRequirementId }
      }
    ],
    status: "collected",
    items: [
      {
        id: "validate-next-log",
        classification: "test-report",
        verdict: "pass",
        artifact: {
          path: "docs/next/evidence/p02-t05/validate-next.log",
          sha256: commandOutputHash,
          mediaType: "text/plain"
        },
        command: {
          command: "pnpm",
          args: ["run", "validate:next"],
          exitCode: 0,
          outputHash: commandOutputHash,
          startedAt: FIXED_TIME,
          endedAt: LATER_TIME
        },
        traceRefs: [
          {
            path: ".legion/project/changes/chg_workflow-delta/evidence-index.json",
            relation: "verifies",
            entity: { kind: "requirement", id: currentSpec.document.primaryRequirementId }
          }
        ]
      }
    ]
  };
}

test("P02-T05 creates revisioned oracle metadata and manifest hashes change after oracle revision", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const { currentSpec, change } = await createBaselineChange(repositoryRoot);
    const createdOracle = await createOracleArtifact({
      repositoryRoot,
      changeId: CHANGE_ID,
      oracle: oracleDocument(currentSpec, change),
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(createdOracle.ok, true);
    assert.equal(createdOracle.artifactPath, ".legion/project/changes/chg_workflow-delta/oracle/orc_acceptance-proof.yaml");
    assert.equal(createdOracle.revision.revision, 1);

    const initialManifest = await deriveOracleManifest({ repositoryRoot, changeId: CHANGE_ID });
    assert.equal(initialManifest.ok, true);
    assert.equal(initialManifest.manifest.oracles.length, 1);

    const updatedOracle = await updateOracleArtifact({
      repositoryRoot,
      changeId: CHANGE_ID,
      expectedRevision: createdOracle.revision.revision,
      supersedes: createdOracle.reference,
      oracle: {
        ...createdOracle.document,
        updatedAt: LATER_TIME,
        expected: {
          ...createdOracle.document.expected,
          evidence: ["A command output hash and reviewer verdict are recorded."]
        }
      },
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(updatedOracle.ok, true);
    assert.equal(updatedOracle.revision.revision, 2);

    const updatedManifest = await deriveOracleManifest({ repositoryRoot, changeId: CHANGE_ID });
    assert.equal(updatedManifest.ok, true);
    assert.notEqual(updatedManifest.manifest.manifestHash, initialManifest.manifest.manifestHash);

    const staleUpdate = await updateOracleArtifact({
      repositoryRoot,
      changeId: CHANGE_ID,
      expectedRevision: 1,
      supersedes: createdOracle.reference,
      oracle: {
        ...updatedOracle.document,
        updatedAt: "2026-06-20T02:00:00.000Z"
      },
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(staleUpdate.ok, false);
    assert.equal(staleUpdate.status, "conflict");
    assert.equal(staleUpdate.diagnostics[0].code, "revision_conflict");
  });
});

test("P02-T05 oracle manifest reports invalid oracle filenames at their actual artifact path", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const invalidOraclePath = `.legion/project/changes/${CHANGE_ID}/oracle/bad_name.yaml`;
    await writeProjectJson(repositoryRoot, invalidOraclePath, {
      schemaVersion: "0.1.0",
      kind: "oracle-artifact",
      revision: 1,
      oracle: {}
    });

    const manifest = await deriveOracleManifest({ repositoryRoot, changeId: CHANGE_ID });
    assert.equal(manifest.ok, false);
    assert.equal(manifest.status, "invalid");
    assert.equal(manifest.diagnostics[0].code, "invalid_oracle_id");
    assert.equal(manifest.diagnostics[0].source.path, invalidOraclePath);
  });
});

test("P02-T05 oracle reads reject artifacts whose embedded oracle ID disagrees with the requested path", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const { currentSpec, change } = await createBaselineChange(repositoryRoot);
    const createdOracle = await createOracleArtifact({
      repositoryRoot,
      changeId: CHANGE_ID,
      oracle: oracleDocument(currentSpec, change),
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(createdOracle.ok, true);

    await writeProjectJson(repositoryRoot, createdOracle.artifactPath, {
      ...createdOracle.artifactDocument,
      oracle: {
        ...createdOracle.document,
        id: "orc_other-proof",
        traceRefs: [
          {
            path: `.legion/project/changes/${CHANGE_ID}/oracle/orc_other-proof.yaml`,
            anchor: "orc_other-proof",
            relation: "verifies",
            entity: { kind: "requirement", id: currentSpec.document.primaryRequirementId }
          }
        ]
      }
    });

    const read = await readOracleArtifact({
      repositoryRoot,
      changeId: CHANGE_ID,
      oracleId: createdOracle.document.id
    });
    assert.equal(read.ok, false);
    assert.equal(read.status, "invalid");
    assert.equal(read.diagnostics[0].code, "oracle_id_mismatch");

    const manifest = await deriveOracleManifest({ repositoryRoot, changeId: CHANGE_ID });
    assert.equal(manifest.ok, false);
    assert.equal(manifest.status, "invalid");
    assert.equal(manifest.diagnostics[0].code, "oracle_id_mismatch");
  });
});

test("P02-T05 writes taskgraph JSON with exact artifact revisions and byte-stable canonical order", async () => {
  const serializedTaskgraphs = [];

  for (const reverseOrder of [false, true]) {
    await withTempRepository(async (repositoryRoot) => {
      const { currentSpec, change } = await createBaselineChange(repositoryRoot);
      const oracle = await createOracleArtifact({
        repositoryRoot,
        changeId: CHANGE_ID,
        oracle: oracleDocument(currentSpec, change),
        baseGitSha: BASE_GIT_SHA
      });
      assert.equal(oracle.ok, true);
      const artifactInputs = [findRevision(change.bundle, "proposal"), oracle.revision];
      const tasks = [
        taskContract("ctr_plan-change", currentSpec, change, oracle, artifactInputs),
        taskContract("ctr_verify-change", currentSpec, change, oracle, artifactInputs, {
          dependencies: [{ contractId: "ctr_plan-change", revision: 1, reason: "Verification consumes the implementation plan." }]
        })
      ];

      const written = await writeTaskGraph({
        repositoryRoot,
        changeId: CHANGE_ID,
        tasks: reverseOrder ? [...tasks].reverse() : tasks,
        artifactInputs: reverseOrder ? [...artifactInputs].reverse() : artifactInputs,
        baseGitSha: BASE_GIT_SHA
      });
      assert.equal(written.ok, true);
      assert.deepEqual(written.document.tasks.map((task) => task.id), ["ctr_plan-change", "ctr_verify-change"]);
      assert.deepEqual(
        written.document.artifactInputs.map((entry) => `${entry.role}:${entry.artifact.path}`),
        ["oracle:.legion/project/changes/chg_workflow-delta/oracle/orc_acceptance-proof.yaml", "proposal:.legion/project/changes/chg_workflow-delta/change.yaml"]
      );

      const loaded = await readTaskGraph({ repositoryRoot, changeId: CHANGE_ID });
      assert.equal(loaded.ok, true);
      serializedTaskgraphs.push(await readFile(path.join(repositoryRoot, ".legion", "project", "changes", "chg_workflow-delta", "taskgraph.json"), "utf8"));
    });
  }

  assert.equal(serializedTaskgraphs[0], serializedTaskgraphs[1]);
});

test("P02-T05 taskgraph rejects empty or duplicate artifact inputs with diagnostics", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const { currentSpec, change } = await createBaselineChange(repositoryRoot);
    const oracle = await createOracleArtifact({
      repositoryRoot,
      changeId: CHANGE_ID,
      oracle: oracleDocument(currentSpec, change),
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(oracle.ok, true);
    const proposal = findRevision(change.bundle, "proposal");
    const tasks = [taskContract("ctr_plan-change", currentSpec, change, oracle, [proposal])];

    const emptyInputs = await writeTaskGraph({
      repositoryRoot,
      changeId: CHANGE_ID,
      tasks,
      artifactInputs: [],
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(emptyInputs.ok, false);
    assert.equal(emptyInputs.status, "invalid");
    assert.equal(emptyInputs.diagnostics[0].code, "invalid_artifact_inputs");

    const duplicateInputs = await writeTaskGraph({
      repositoryRoot,
      changeId: CHANGE_ID,
      tasks,
      artifactInputs: [proposal, { ...proposal, revision: proposal.revision + 1 }],
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(duplicateInputs.ok, false);
    assert.equal(duplicateInputs.status, "invalid");
    assert.equal(duplicateInputs.diagnostics[0].code, "duplicate_artifact_input");
  });
});

test("P02-T05 taskgraph rejects copied identities and stale manifest hashes on read", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const { currentSpec, change } = await createBaselineChange(repositoryRoot);
    const oracle = await createOracleArtifact({
      repositoryRoot,
      changeId: CHANGE_ID,
      oracle: oracleDocument(currentSpec, change),
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(oracle.ok, true);
    const artifactInputs = [findRevision(change.bundle, "proposal"), oracle.revision];
    const taskgraph = await writeTaskGraph({
      repositoryRoot,
      changeId: CHANGE_ID,
      tasks: [taskContract("ctr_plan-change", currentSpec, change, oracle, artifactInputs)],
      artifactInputs,
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(taskgraph.ok, true);

    await writeProjectJson(repositoryRoot, `.legion/project/changes/${OTHER_CHANGE_ID}/taskgraph.json`, taskgraph.document);
    const copied = await readTaskGraph({ repositoryRoot, changeId: OTHER_CHANGE_ID });
    assert.equal(copied.ok, false);
    assert.equal(copied.status, "invalid");
    assert.equal(copied.diagnostics[0].code, "taskgraph_change_mismatch");

    await writeProjectJson(repositoryRoot, `.legion/project/changes/${CHANGE_ID}/taskgraph.json`, {
      ...taskgraph.document,
      artifactManifest: {
        ...taskgraph.document.artifactManifest,
        manifestHash: STALE_HASH
      }
    });
    const staleHash = await readTaskGraph({ repositoryRoot, changeId: CHANGE_ID });
    assert.equal(staleHash.ok, false);
    assert.equal(staleHash.status, "invalid");
    assert.equal(staleHash.diagnostics[0].code, "manifest_hash_mismatch");

    await writeProjectJson(repositoryRoot, `.legion/project/changes/${CHANGE_ID}/taskgraph.json`, {
      ...taskgraph.document,
      artifactInputs: [artifactInputs[0]]
    });
    const mismatchedInputs = await readTaskGraph({ repositoryRoot, changeId: CHANGE_ID });
    assert.equal(mismatchedInputs.ok, false);
    assert.equal(mismatchedInputs.status, "invalid");
    assert.equal(mismatchedInputs.diagnostics[0].code, "taskgraph_manifest_inputs_mismatch");
  });
});

test("P02-T05 evidence index rejects incomplete provenance and records accepted evidence references", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const { currentSpec, change } = await createBaselineChange(repositoryRoot);
    const oracle = await createOracleArtifact({
      repositoryRoot,
      changeId: CHANGE_ID,
      oracle: oracleDocument(currentSpec, change),
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(oracle.ok, true);

    const missingRun = await writeEvidenceIndex({
      repositoryRoot,
      changeId: CHANGE_ID,
      entries: [
        {
          evidence: {
            ...evidenceBundle(currentSpec),
            runId: undefined
          },
          acceptance: {
            status: "accepted",
            reviewId: "rev_acceptance",
            acceptedAt: LATER_TIME,
            reason: "Validation output was reviewed."
          }
        }
      ],
      artifactInputs: [findRevision(change.bundle, "proposal"), oracle.revision],
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(missingRun.ok, false);
    assert.equal(missingRun.status, "invalid");
    assert.equal(missingRun.diagnostics[0].code, "missing_evidence_run");

    const missingReview = await writeEvidenceIndex({
      repositoryRoot,
      changeId: CHANGE_ID,
      entries: [
        {
          evidence: evidenceBundle(currentSpec),
          acceptance: {
            status: "accepted",
            acceptedAt: LATER_TIME,
            reason: "Validation output was reviewed."
          }
        }
      ],
      artifactInputs: [findRevision(change.bundle, "proposal"), oracle.revision],
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(missingReview.ok, false);
    assert.equal(missingReview.diagnostics[0].code, "missing_review_id");

    const missingAcceptedAt = await writeEvidenceIndex({
      repositoryRoot,
      changeId: CHANGE_ID,
      entries: [
        {
          evidence: evidenceBundle(currentSpec),
          acceptance: {
            status: "accepted",
            reviewId: "rev_acceptance",
            reason: "Validation output was reviewed."
          }
        }
      ],
      artifactInputs: [findRevision(change.bundle, "proposal"), oracle.revision],
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(missingAcceptedAt.ok, false);
    assert.equal(missingAcceptedAt.diagnostics[0].code, "missing_accepted_at");

    const missingRejectionReason = await writeEvidenceIndex({
      repositoryRoot,
      changeId: CHANGE_ID,
      entries: [
        {
          evidence: evidenceBundle(currentSpec),
          acceptance: {
            status: "rejected"
          }
        }
      ],
      artifactInputs: [findRevision(change.bundle, "proposal"), oracle.revision],
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(missingRejectionReason.ok, false);
    assert.equal(missingRejectionReason.diagnostics[0].code, "missing_rejection_reason");

    const missingHash = await writeEvidenceIndex({
      repositoryRoot,
      changeId: CHANGE_ID,
      entries: [
        {
          evidence: {
            ...evidenceBundle(currentSpec),
            items: [
              {
                id: "manual-note",
                classification: "manual-observation",
                verdict: "pass",
                traceRefs: []
              }
            ]
          },
          acceptance: {
            status: "accepted",
            reviewId: "rev_acceptance",
            acceptedAt: LATER_TIME,
            reason: "Validation output was reviewed."
          }
        }
      ],
      artifactInputs: [findRevision(change.bundle, "proposal"), oracle.revision],
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(missingHash.ok, false);
    assert.equal(missingHash.diagnostics[0].code, "missing_evidence_hash");

    const written = await writeEvidenceIndex({
      repositoryRoot,
      changeId: CHANGE_ID,
      entries: [
        {
          evidence: evidenceBundle(currentSpec),
          acceptance: {
            status: "accepted",
            reviewId: "rev_acceptance",
            acceptedAt: LATER_TIME,
            reason: "Validation output was reviewed."
          }
        }
      ],
      artifactInputs: [findRevision(change.bundle, "proposal"), oracle.revision],
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(written.ok, true);
    assert.equal(written.document.entries[0].evidence.sensitivity, "internal");
    assert.equal(written.document.entries[0].acceptance.reviewId, "rev_acceptance");
    assert.equal(written.document.artifactManifest.inputs.length, 2);
    assert.equal(written.document.artifactManifest.evidenceRefs.length, 1);

    const loaded = await readEvidenceIndex({ repositoryRoot, changeId: CHANGE_ID });
    assert.equal(loaded.ok, true);
    assert.equal(stableProtocolJson(loaded.document), stableProtocolJson(written.document));
  });
});

test("P02-T05 evidence index rejects empty inputs, copied identities, and stale manifest hashes", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const { currentSpec, change } = await createBaselineChange(repositoryRoot);
    const oracle = await createOracleArtifact({
      repositoryRoot,
      changeId: CHANGE_ID,
      oracle: oracleDocument(currentSpec, change),
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(oracle.ok, true);
    const proposal = findRevision(change.bundle, "proposal");
    const entry = {
      evidence: evidenceBundle(currentSpec),
      acceptance: {
        status: "accepted",
        reviewId: "rev_acceptance",
        acceptedAt: LATER_TIME,
        reason: "Validation output was reviewed."
      }
    };

    const emptyInputs = await writeEvidenceIndex({
      repositoryRoot,
      changeId: CHANGE_ID,
      entries: [entry],
      artifactInputs: [],
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(emptyInputs.ok, false);
    assert.equal(emptyInputs.status, "invalid");
    assert.equal(emptyInputs.diagnostics[0].code, "invalid_artifact_inputs");

    const written = await writeEvidenceIndex({
      repositoryRoot,
      changeId: CHANGE_ID,
      entries: [entry],
      artifactInputs: [proposal, oracle.revision],
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(written.ok, true);

    await writeProjectJson(repositoryRoot, `.legion/project/changes/${OTHER_CHANGE_ID}/evidence-index.json`, written.document);
    const copied = await readEvidenceIndex({ repositoryRoot, changeId: OTHER_CHANGE_ID });
    assert.equal(copied.ok, false);
    assert.equal(copied.status, "invalid");
    assert.equal(copied.diagnostics[0].code, "evidence_index_change_mismatch");

    await writeProjectJson(repositoryRoot, `.legion/project/changes/${CHANGE_ID}/evidence-index.json`, {
      ...written.document,
      artifactManifest: {
        ...written.document.artifactManifest,
        manifestHash: STALE_HASH
      }
    });
    const staleHash = await readEvidenceIndex({ repositoryRoot, changeId: CHANGE_ID });
    assert.equal(staleHash.ok, false);
    assert.equal(staleHash.status, "invalid");
    assert.equal(staleHash.diagnostics[0].code, "manifest_hash_mismatch");

    const { runId: _runId, ...evidenceWithoutRun } = entry.evidence;
    await writeProjectJson(repositoryRoot, `.legion/project/changes/${CHANGE_ID}/evidence-index.json`, {
      ...written.document,
      entries: [
        {
          ...entry,
          evidence: evidenceWithoutRun
        }
      ]
    });
    const missingRun = await readEvidenceIndex({ repositoryRoot, changeId: CHANGE_ID });
    assert.equal(missingRun.ok, false);
    assert.equal(missingRun.status, "invalid");
    assert.equal(missingRun.diagnostics[0].code, "missing_evidence_run");

    const { artifact: _artifact, command: _command, ...itemWithoutSource } = entry.evidence.items[0];
    await writeProjectJson(repositoryRoot, `.legion/project/changes/${CHANGE_ID}/evidence-index.json`, {
      ...written.document,
      entries: [
        {
          ...entry,
          evidence: {
            ...entry.evidence,
            items: [itemWithoutSource]
          }
        }
      ]
    });
    const missingSource = await readEvidenceIndex({ repositoryRoot, changeId: CHANGE_ID });
    assert.equal(missingSource.ok, false);
    assert.equal(missingSource.status, "invalid");
    assert.equal(missingSource.diagnostics[0].code, "missing_evidence_hash");
  });
});
