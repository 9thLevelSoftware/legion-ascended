import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { formatEntityId } from "@legion/protocol";
import {
  archiveAcceptedChange,
  createChangeBundle,
  createCurrentSpec,
  createOracleArtifact,
  initProject,
  loadChangeBundle,
  planAcceptedChangeArchive,
  readArchiveRecord,
  readCurrentSpec,
  stableProtocolJson,
  updateCurrentSpec,
  writeEvidenceIndex,
  writeTaskGraph
} from "../dist/index.js";

const FIXED_TIME = "2026-06-20T00:00:00.000Z";
const LATER_TIME = "2026-06-20T01:00:00.000Z";
const OWNER = { kind: "human", id: "dasbl" };
const PROJECT_ID = "prj_legion-next";
const CHANGE_ID = "chg_archive-merge";
const BASE_GIT_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OUTPUT_HASH = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

async function withTempRepository(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-archive-"));
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

function requirement(slug, oracleId, overrides = {}) {
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
    statement: `${slug} behavior is current and archiveable.`,
    acceptance: {
      language: `${slug} acceptance is deterministic.`,
      criteria: [`${slug} criterion`],
      oracleRefs: [oracleId]
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

function specDocument(requirements) {
  return {
    primaryRequirementId: "req_archive-alpha",
    capability: {
      id: "archive-alpha",
      title: "Archive merge capability",
      status: "active"
    },
    requirements,
    sections: {
      purpose: "Defines current requirements used by the archive merge tests.",
      behaviors: "Archive applies accepted deltas only after traceability passes.",
      constraints: "Current truth is updated through compare-and-swap writes.",
      scenarios: "A maintainer archives an accepted change and can retry safely.",
      interfaces: "@legion/artifacts archive services",
      compatibility: "Accepted change artifacts remain immutable review history.",
      failureModes: "Stale bases, missing evidence, and injected write failures block archive.",
      traceIds: requirements.map((entry) => entry.id)
    }
  };
}

function riskProfile() {
  return {
    tier: "R2",
    reasons: ["archive mutates current truth"]
  };
}

function acceptedDecision() {
  return {
    id: "dec_archive-merge",
    status: "accepted",
    title: "Archive accepted deltas explicitly",
    context: "Current truth must update only through accepted archive.",
    alternatives: [
      {
        id: "archive-transaction",
        title: "Archive transaction",
        summary: "Merge accepted deltas after validation.",
        selected: true
      },
      {
        id: "direct-edit",
        title: "Direct edit",
        summary: "Edit current truth before acceptance.",
        selected: false
      }
    ],
    rationale: "Archive transactions preserve review history and current-truth CAS.",
    supersedes: [],
    approver: OWNER,
    decidedAt: LATER_TIME
  };
}

function findRevision(bundle, role) {
  const revision = bundle.artifactRevisions.find((entry) => entry.role === role);
  assert.ok(revision, `missing ${role} revision`);
  return revision;
}

async function markChangeAccepted(repositoryRoot) {
  const proposalPath = path.join(repositoryRoot, ".legion", "project", "changes", CHANGE_ID, "change.yaml");
  const bundle = JSON.parse(await readFile(proposalPath, "utf8"));
  bundle.change.status = "accepted";
  bundle.change.acceptance = {
    status: "accepted",
    acceptedAt: LATER_TIME,
    acceptedBy: OWNER.id,
    reason: "All archive preconditions are satisfied."
  };
  bundle.change.updatedAt = LATER_TIME;
  await writeFile(proposalPath, stableProtocolJson(bundle), "utf8");

  const accepted = await loadChangeBundle({ repositoryRoot, changeId: CHANGE_ID });
  assert.equal(accepted.ok, true);
  return accepted;
}

function oracleDocument(requirementId, oracleId, currentSpec, change) {
  return {
    schemaVersion: "0.1.0",
    createdAt: FIXED_TIME,
    kind: "oracle",
    id: oracleId,
    projectId: PROJECT_ID,
    title: `${requirementId} archive proof`,
    owner: OWNER,
    protectedPaths: [currentSpec.artifactPath],
    sourceArtifacts: [change.reference],
    expected: {
      preconditions: ["The change validates before archive."],
      postconditions: ["The accepted requirement is merged into current truth."],
      evidence: ["Accepted evidence records command output."]
    },
    requirementCoverage: [
      {
        requirementId,
        coverage: "primary",
        criteria: [`${requirementId} has archive coverage.`]
      }
    ],
    traceRefs: [
      {
        path: `.legion/project/changes/${CHANGE_ID}/oracle/${oracleId}.yaml`,
        anchor: oracleId,
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
    }
  };
}

function taskContract(requirementId, oracleId, currentSpec, change, artifactInputs) {
  const slug = requirementId.replace(/^req_/, "");
  return {
    schemaVersion: "0.1.0",
    createdAt: FIXED_TIME,
    kind: "task-contract",
    id: `ctr_${slug}-task`,
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    revision: 1,
    title: `${requirementId} archive task`,
    objective: `Implement and verify ${requirementId}.`,
    requirementIds: [requirementId],
    dependencies: [],
    context: {
      specRefs: [currentSpec.reference],
      designRefs: [findRevision(change.bundle, "design").artifact],
      predecessorArtifacts: artifactInputs.map((entry) => entry.artifact)
    },
    scope: {
      read: [currentSpec.artifactPath],
      write: [".legion/project/changes/chg_archive-merge/taskgraph.json"],
      forbidden: [".legion/var/runtime.sqlite"],
      sequentialFiles: []
    },
    interfaces: {
      consumes: [{ name: "ArchiveInput", description: "Accepted change artifacts." }],
      produces: [{ name: "ArchiveEvidence", description: "Evidence for current truth merge." }]
    },
    oracleRefs: [oracleId],
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
      expectedArtifacts: [change.revision.artifact],
      requiredEvidence: ["validate-next output hash"],
      blockedConditions: ["Accepted evidence is missing."]
    }
  };
}

function evidenceEntry(requirementId, evidenceId, reviewId, acceptance = undefined) {
  const slug = requirementId.replace(/^req_/, "");
  return {
    evidence: {
      schemaVersion: "0.1.0",
      createdAt: FIXED_TIME,
      kind: "evidence",
      id: evidenceId,
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      taskId: `tsk_${slug}`,
      runId: `run_${slug}`,
      sensitivity: "internal",
      retention: { class: "audit" },
      traceRefs: [
        {
          path: `.legion/project/changes/${CHANGE_ID}/evidence-index.json`,
          relation: "verifies",
          entity: { kind: "requirement", id: requirementId }
        }
      ],
      status: "collected",
      items: [
        {
          id: `${slug}-log`,
          classification: "test-report",
          verdict: "pass",
          artifact: {
            path: `docs/next/evidence/P02-T07/${requirementId}.log`,
            sha256: OUTPUT_HASH,
            mediaType: "text/plain"
          },
          command: {
            command: "pnpm",
            args: ["run", "validate:next"],
            exitCode: 0,
            outputHash: OUTPUT_HASH,
            startedAt: FIXED_TIME,
            endedAt: LATER_TIME
          },
          traceRefs: [
            {
              path: `.legion/project/changes/${CHANGE_ID}/evidence-index.json`,
              relation: "verifies",
              entity: { kind: "requirement", id: requirementId }
            }
          ]
        }
      ]
    },
    acceptance: acceptance ?? {
      status: "accepted",
      reviewId,
      acceptedAt: LATER_TIME,
      reason: "Archive evidence was independently reviewed."
    }
  };
}

async function createAcceptedArchiveFixture(repositoryRoot, options = {}) {
  const oracleId = "orc_archive-alpha-proof";
  const currentRequirement = requirement("archive-alpha", oracleId);
  const currentSpec = await createCurrentSpec({
    repositoryRoot,
    document: specDocument([currentRequirement])
  });
  assert.equal(currentSpec.ok, true);

  const proposedRequirement = {
    ...currentRequirement,
    statement: "archive-alpha behavior is merged from an accepted change."
  };
  const createdChange = await createChangeBundle({
    repositoryRoot,
    changeId: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Archive accepted change",
    summary: "Merge an accepted delta into current truth.",
    owners: [OWNER],
    baseGitSha: BASE_GIT_SHA,
    risk: riskProfile(),
    createdAt: FIXED_TIME,
    currentSpecs: [{ requirementId: currentSpec.document.primaryRequirementId, expectedRevision: currentSpec.document.revision }],
    deltaSpecs: [
      {
        operation: "modify",
        requirementId: proposedRequirement.id,
        proposedRequirement,
        sections: {
          ...currentSpec.document.sections,
          purpose: "Defines accepted archive behavior after merge."
        },
        rationale: "The accepted behavior should become current truth."
      }
    ],
    design: {
      title: "Archive merge",
      body: "The archive service validates and merges accepted deltas."
    },
    decisions: [acceptedDecision()]
  });
  assert.equal(createdChange.ok, true);

  const acceptedChange = options.acceptChange === false ? createdChange : await markChangeAccepted(repositoryRoot);
  const oracle = await createOracleArtifact({
    repositoryRoot,
    changeId: CHANGE_ID,
    oracle: oracleDocument(proposedRequirement.id, oracleId, currentSpec, acceptedChange),
    baseGitSha: BASE_GIT_SHA
  });
  assert.equal(oracle.ok, true);

  const artifactInputs = [acceptedChange.revision, oracle.revision];
  const taskgraph = await writeTaskGraph({
    repositoryRoot,
    changeId: CHANGE_ID,
    artifactInputs,
    tasks: [taskContract(proposedRequirement.id, oracleId, currentSpec, acceptedChange, artifactInputs)],
    baseGitSha: BASE_GIT_SHA
  });
  assert.equal(taskgraph.ok, true);

  const evidence = await writeEvidenceIndex({
    repositoryRoot,
    changeId: CHANGE_ID,
    artifactInputs: [acceptedChange.revision, taskgraph.revision, oracle.revision],
    entries: [
      evidenceEntry(
        proposedRequirement.id,
        "evd_archive-alpha-proof",
        "rev_archive-alpha-review",
        options.evidenceAcceptance
      )
    ],
    baseGitSha: BASE_GIT_SHA
  });
  assert.equal(evidence.ok, true);

  return { currentSpec, acceptedChange, proposedRequirement };
}

test("P02-T07 previews and archives an accepted change into current truth", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const { currentSpec, proposedRequirement } = await createAcceptedArchiveFixture(repositoryRoot);

    const preview = await planAcceptedChangeArchive({
      repositoryRoot,
      changeId: CHANGE_ID,
      outputBranch: "codex/archive-test"
    });
    assert.equal(preview.ok, true);
    assert.deepEqual(preview.preview.diff, {
      added: [],
      modified: [proposedRequirement.id],
      removed: [],
      moved: []
    });

    const archived = await archiveAcceptedChange({
      repositoryRoot,
      changeId: CHANGE_ID,
      archivedAt: LATER_TIME,
      archivedBy: OWNER.id,
      outputBranch: "codex/archive-test"
    });
    assert.equal(archived.ok, true);
    assert.equal(archived.status, "archived");
    assert.deepEqual(archived.record.preview.diff, preview.preview.diff);
    assert.equal(archived.record.retainedArtifacts.deltas.length, 1);
    assert.equal(archived.record.retainedArtifacts.design.path, `.legion/project/changes/${CHANGE_ID}/design.md`);
    assert.equal(archived.record.retainedArtifacts.taskgraph.path, `.legion/project/changes/${CHANGE_ID}/taskgraph.json`);
    assert.equal(archived.record.retainedArtifacts.evidenceIndex.path, `.legion/project/changes/${CHANGE_ID}/evidence-index.json`);

    const currentAfterArchive = await readCurrentSpec({
      repositoryRoot,
      requirementId: currentSpec.document.primaryRequirementId
    });
    assert.equal(currentAfterArchive.ok, true);
    assert.equal(currentAfterArchive.document.revision, 2);
    assert.equal(currentAfterArchive.document.requirements[0].statement, proposedRequirement.statement);
    assert.equal(currentAfterArchive.document.sections.purpose, "Defines accepted archive behavior after merge.");

    const loadedArchive = await readArchiveRecord({ repositoryRoot, changeId: CHANGE_ID });
    assert.equal(loadedArchive.ok, true);
    assert.equal(loadedArchive.record.archiveHash, archived.record.archiveHash);
  });
});

test("P02-T07 refuses to archive changes that are not accepted", async () => {
  await withTempRepository(async (repositoryRoot) => {
    await createAcceptedArchiveFixture(repositoryRoot, { acceptChange: false });

    const result = await archiveAcceptedChange({
      repositoryRoot,
      changeId: CHANGE_ID,
      archivedAt: LATER_TIME,
      archivedBy: OWNER.id,
      outputBranch: "codex/archive-test"
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.equal(result.diagnostics[0].code, "change_not_accepted");
  });
});

test("P02-T07 refuses stale current-spec bases before mutating current truth", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const { currentSpec } = await createAcceptedArchiveFixture(repositoryRoot);
    const staleEdit = await updateCurrentSpec({
      repositoryRoot,
      expectedRevision: currentSpec.document.revision,
      document: {
        ...currentSpec.document,
        sections: {
          ...currentSpec.document.sections,
          purpose: "Current truth changed before archive."
        }
      }
    });
    assert.equal(staleEdit.ok, true);

    const result = await archiveAcceptedChange({
      repositoryRoot,
      changeId: CHANGE_ID,
      archivedAt: LATER_TIME,
      archivedBy: OWNER.id,
      outputBranch: "codex/archive-test"
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "stale_change_base"));
  });
});

test("P02-T07 refuses missing accepted evidence", async () => {
  await withTempRepository(async (repositoryRoot) => {
    await createAcceptedArchiveFixture(repositoryRoot, {
      evidenceAcceptance: {
        status: "pending",
        reason: "Evidence still awaits review."
      }
    });

    const result = await archiveAcceptedChange({
      repositoryRoot,
      changeId: CHANGE_ID,
      archivedAt: LATER_TIME,
      archivedBy: OWNER.id,
      outputBranch: "codex/archive-test"
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "missing_accepted_evidence"));
  });
});

test("P02-T07 rolls back current truth when archive metadata write fails", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const { currentSpec } = await createAcceptedArchiveFixture(repositoryRoot);
    const before = await readFile(path.join(repositoryRoot, ".legion", "project", "specs", "req_archive-alpha.md"), "utf8");

    const result = await archiveAcceptedChange({
      repositoryRoot,
      changeId: CHANGE_ID,
      archivedAt: LATER_TIME,
      archivedBy: OWNER.id,
      outputBranch: "codex/archive-test",
      beforeArchiveCommit: () => {
        throw new Error("injected archive write failure");
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "conflict");
    assert.equal(result.diagnostics[0].code, "archive_write_failed");
    const after = await readFile(path.join(repositoryRoot, ".legion", "project", "specs", "req_archive-alpha.md"), "utf8");
    assert.equal(after, before);

    const currentAfterFailure = await readCurrentSpec({
      repositoryRoot,
      requirementId: currentSpec.document.primaryRequirementId
    });
    assert.equal(currentAfterFailure.ok, true);
    assert.equal(currentAfterFailure.document.revision, 1);

    const missingArchive = await readArchiveRecord({ repositoryRoot, changeId: CHANGE_ID });
    assert.equal(missingArchive.ok, false);
    assert.equal(missingArchive.status, "not_found");
  });
});

test("P02-T07 retry after a recorded archive is idempotent", async () => {
  await withTempRepository(async (repositoryRoot) => {
    await createAcceptedArchiveFixture(repositoryRoot);
    const first = await archiveAcceptedChange({
      repositoryRoot,
      changeId: CHANGE_ID,
      archivedAt: LATER_TIME,
      archivedBy: OWNER.id,
      outputBranch: "codex/archive-test"
    });
    assert.equal(first.ok, true);

    const second = await archiveAcceptedChange({
      repositoryRoot,
      changeId: CHANGE_ID,
      archivedAt: LATER_TIME,
      archivedBy: OWNER.id,
      outputBranch: "codex/archive-test"
    });

    assert.equal(second.ok, true);
    assert.equal(second.status, "already_archived");
    assert.equal(second.record.archiveHash, first.record.archiveHash);

    const currentAfterRetry = await readCurrentSpec({ repositoryRoot, requirementId: "req_archive-alpha" });
    assert.equal(currentAfterRetry.ok, true);
    assert.equal(currentAfterRetry.document.revision, 2);
  });
});

test("P02-T07 refuses idempotent archive retry when current truth drifted", async () => {
  await withTempRepository(async (repositoryRoot) => {
    await createAcceptedArchiveFixture(repositoryRoot);
    const first = await archiveAcceptedChange({
      repositoryRoot,
      changeId: CHANGE_ID,
      archivedAt: LATER_TIME,
      archivedBy: OWNER.id,
      outputBranch: "codex/archive-test"
    });
    assert.equal(first.ok, true);

    const currentAfterArchive = await readCurrentSpec({ repositoryRoot, requirementId: "req_archive-alpha" });
    assert.equal(currentAfterArchive.ok, true);
    const drift = await updateCurrentSpec({
      repositoryRoot,
      expectedRevision: currentAfterArchive.document.revision,
      document: {
        ...currentAfterArchive.document,
        requirements: currentAfterArchive.document.requirements.map((entry) => ({
          ...entry,
          statement: "archive-alpha drifted after archive."
        }))
      }
    });
    assert.equal(drift.ok, true);

    const second = await archiveAcceptedChange({
      repositoryRoot,
      changeId: CHANGE_ID,
      archivedAt: LATER_TIME,
      archivedBy: OWNER.id,
      outputBranch: "codex/archive-test"
    });

    assert.equal(second.ok, false);
    assert.equal(second.status, "conflict");
    assert.equal(second.diagnostics[0].code, "archive_current_truth_mismatch");
  });
});
