import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { formatEntityId } from "@legion/protocol";
import {
  analyzeTraceabilityImpact,
  createChangeBundle,
  createCurrentSpec,
  createOracleArtifact,
  initProject,
  stableProtocolJson,
  updateOracleArtifact,
  validateChangeTraceability,
  writeEvidenceIndex,
  writeTaskGraph
} from "../dist/index.js";

const FIXED_TIME = "2026-06-20T00:00:00.000Z";
const LATER_TIME = "2026-06-20T01:00:00.000Z";
const OWNER = { kind: "human", id: "dasbl" };
const PROJECT_ID = "prj_legion-next";
const CHANGE_ID = "chg_traceability-matrix";
const BASE_GIT_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OUTPUT_HASH = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

async function withTempRepository(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-traceability-"));
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
    statement: `${slug} behavior is deployed and traceable.`,
    acceptance: {
      language: `${slug} acceptance is deterministic.`,
      criteria: [`${slug} criterion`],
      oracleRefs: [oracleId]
    },
    traceRefs: [
      {
        path: ".legion/project/specs/req_alpha.md",
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
    primaryRequirementId: "req_alpha",
    capability: {
      id: "alpha",
      title: "Traceability matrix capability",
      status: "active"
    },
    requirements,
    sections: {
      purpose: "Defines requirements used by the traceability validation matrix.",
      behaviors: "The graph validator follows requirements to oracles, task contracts, evidence, and reviews.",
      constraints: "Traceability validation is a read-only artifact operation.",
      scenarios: "A maintainer can detect missing downstream coverage before archive.",
      interfaces: "@legion/artifacts traceability services",
      compatibility: "Current specs and proposed deltas remain separate.",
      failureModes: "Missing links produce typed diagnostics with exact artifact paths.",
      traceIds: requirements.map((entry) => entry.id)
    }
  };
}

function riskProfile(tier = "R2") {
  return {
    tier,
    reasons: ["traceability validation"]
  };
}

function acceptedDecision() {
  return {
    id: "dec_traceability-policy",
    status: "accepted",
    title: "Validate traceability before archive",
    context: "P02-T06 needs a reviewable policy for requirement to evidence coverage.",
    alternatives: [
      {
        id: "validate-before-archive",
        title: "Validate before archive",
        summary: "Block archive until traceability chains are complete.",
        selected: true
      },
      {
        id: "manual-review-only",
        title: "Manual review only",
        summary: "Rely on reviewers to notice missing links.",
        selected: false
      }
    ],
    rationale: "The graph should identify missing downstream artifacts deterministically.",
    supersedes: [],
    approver: OWNER,
    decidedAt: LATER_TIME
  };
}

async function createTraceabilityProject(repositoryRoot, options = {}) {
  const alpha = requirement("alpha", options.alphaOracleId ?? "orc_alpha-proof", options.alphaOverrides ?? {});
  const beta = requirement("beta", options.betaOracleId ?? "orc_beta-proof", {
    traceRefs: [
      {
        path: ".legion/project/specs/req_alpha.md",
        anchor: "req_beta",
        relation: "defines",
        entity: { kind: "requirement", id: "req_beta" }
      }
    ],
    ...(options.betaOverrides ?? {})
  });
  const extraRequirements = options.extraRequirements ?? [];
  const currentSpec = await createCurrentSpec({
    repositoryRoot,
    document: specDocument([alpha, beta, ...extraRequirements])
  });
  assert.equal(currentSpec.ok, true);

  const updatedAlpha = {
    ...alpha,
    statement: "alpha behavior is proposed with a validated downstream traceability chain.",
    ...(options.updatedAlphaOverrides ?? {})
  };
  const updatedBeta = {
    ...beta,
    statement: "beta behavior is proposed with an independent downstream traceability chain.",
    ...(options.updatedBetaOverrides ?? {})
  };
  const updatedExtraRequirements = extraRequirements.map((entry) => ({
    ...entry,
    statement: `${entry.id} behavior is proposed with downstream traceability.`,
    ...(options.updatedRequirementOverrides?.[entry.id] ?? {})
  }));

  const change = await createChangeBundle({
    repositoryRoot,
    changeId: CHANGE_ID,
    projectId: PROJECT_ID,
    title: "Traceability matrix",
    summary: "Validate requirement coverage and invalidation impact.",
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
    deltaSpecs: [updatedAlpha, updatedBeta, ...updatedExtraRequirements].map((entry) => ({
        operation: "modify",
        requirementId: entry.id,
        proposedRequirement: entry,
        sections: currentSpec.document.sections,
        rationale: `${entry.id} changes need complete coverage.`
      })),
    design: {
      title: "Traceability validation",
      body: "Traceability validation remains a read-only projection over Git artifacts."
    },
    decisions: [acceptedDecision()]
  });
  assert.equal(change.ok, true);

  return { currentSpec, change };
}

function findRevision(bundle, role, pathSuffix) {
  const revision = bundle.artifactRevisions.find((entry) =>
    entry.role === role && (pathSuffix === undefined || entry.artifact.path.endsWith(pathSuffix))
  );
  assert.ok(revision, `missing ${role} revision`);
  return revision;
}

function oracleDocument(requirementIds, oracleId, currentSpec, change) {
  const coveredRequirements = Array.isArray(requirementIds) ? requirementIds : [requirementIds];
  return {
    schemaVersion: "0.1.0",
    createdAt: FIXED_TIME,
    kind: "oracle",
    id: oracleId,
    projectId: PROJECT_ID,
    title: `${coveredRequirements.join(" and ")} acceptance proof`,
    owner: OWNER,
    protectedPaths: [currentSpec.artifactPath],
    sourceArtifacts: [change.reference],
    expected: {
      preconditions: ["The change bundle validates before the oracle is trusted."],
      postconditions: ["The required behavior is verified."],
      evidence: ["Accepted evidence records the command output hash."]
    },
    requirementCoverage: coveredRequirements.map((requirementId) => ({
        requirementId,
        coverage: "primary",
        criteria: [`${requirementId} has primary oracle coverage.`]
      })),
    traceRefs: coveredRequirements.map((requirementId) => ({
        path: `.legion/project/changes/${CHANGE_ID}/oracle/${oracleId}.yaml`,
        anchor: oracleId,
        relation: "verifies",
        entity: { kind: "requirement", id: requirementId }
      })),
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

function taskContract(id, requirementId, oracleId, currentSpec, change, artifactInputs) {
  return {
    schemaVersion: "0.1.0",
    createdAt: FIXED_TIME,
    kind: "task-contract",
    id,
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    revision: 1,
    title: `${requirementId} task`,
    objective: `Implement and verify ${requirementId}.`,
    requirementIds: [requirementId],
    wave: "A",
    agents: ["traceability-planner"],
    dependencies: [],
    context: {
      specRefs: [currentSpec.reference],
      designRefs: [findRevision(change.bundle, "design").artifact],
      predecessorArtifacts: artifactInputs.map((entry) => entry.artifact)
    },
    scope: {
      read: [currentSpec.artifactPath],
      write: [`.legion/project/changes/${CHANGE_ID}/taskgraph.json`],
      forbidden: [".legion/var/runtime.sqlite"],
      sequentialFiles: []
    },
    interfaces: {
      consumes: [
        {
          name: "TraceabilityInput",
          description: "Current specs, change bundle, and oracle artifacts."
        }
      ],
      produces: [
        {
          name: "TraceabilityEvidence",
          description: "Accepted evidence for the requirement chain."
        }
      ]
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

function evidenceEntry(requirementId, evidenceId, reviewId) {
  return {
    evidence: {
      schemaVersion: "0.1.0",
      createdAt: FIXED_TIME,
      kind: "evidence",
      id: evidenceId,
      projectId: PROJECT_ID,
      changeId: CHANGE_ID,
      taskId: `tsk_${requirementId.replace(/^req_/, "")}`,
      runId: `run_${requirementId.replace(/^req_/, "")}`,
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
          id: `${requirementId.replace(/^req_/, "")}-log`,
          classification: "test-report",
          verdict: "pass",
          artifact: {
            path: `docs/next/evidence/P02-T06/${requirementId}.log`,
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
    acceptance: {
      status: "accepted",
      reviewId,
      acceptedAt: LATER_TIME,
      reason: "The evidence was reviewed for traceability coverage."
    }
  };
}

async function createCompleteTraceabilityArtifacts(repositoryRoot, options = {}) {
  const alphaOracleId = options.sharedOracle ? "orc_shared-proof" : "orc_alpha-proof";
  const betaOracleId = options.sharedOracle ? "orc_shared-proof" : "orc_beta-proof";
  const { currentSpec, change } = await createTraceabilityProject(repositoryRoot, {
    alphaOracleId,
    betaOracleId
  });
  const alphaOracle = await createOracleArtifact({
    repositoryRoot,
    changeId: CHANGE_ID,
    oracle: oracleDocument(options.sharedOracle ? ["req_alpha", "req_beta"] : "req_alpha", alphaOracleId, currentSpec, change),
    baseGitSha: BASE_GIT_SHA
  });
  assert.equal(alphaOracle.ok, true);
  let betaOracle = alphaOracle;
  if (!options.sharedOracle) {
    betaOracle = await createOracleArtifact({
      repositoryRoot,
      changeId: CHANGE_ID,
      oracle: oracleDocument("req_beta", betaOracleId, currentSpec, change),
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(betaOracle.ok, true);
  }

  const artifactInputs = options.sharedOracle ? [change.revision, alphaOracle.revision] : [change.revision, alphaOracle.revision, betaOracle.revision];
  const taskgraph = await writeTaskGraph({
    repositoryRoot,
    changeId: CHANGE_ID,
    artifactInputs,
    tasks: [
      taskContract("ctr_alpha-task", "req_alpha", alphaOracleId, currentSpec, change, artifactInputs),
      taskContract("ctr_beta-task", "req_beta", betaOracleId, currentSpec, change, artifactInputs)
    ],
    baseGitSha: BASE_GIT_SHA
  });
  assert.equal(taskgraph.ok, true);

  const evidence = await writeEvidenceIndex({
    repositoryRoot,
    changeId: CHANGE_ID,
    artifactInputs: options.sharedOracle
      ? [change.revision, taskgraph.revision, alphaOracle.revision]
      : [change.revision, taskgraph.revision, alphaOracle.revision, betaOracle.revision],
    entries: options.evidenceEntries ?? [
      evidenceEntry("req_alpha", "evd_alpha-proof", "rev_alpha-review"),
      evidenceEntry("req_beta", "evd_beta-proof", "rev_beta-review")
    ],
    baseGitSha: BASE_GIT_SHA
  });
  assert.equal(evidence.ok, true);

  return { currentSpec, change, alphaOracle, betaOracle, taskgraph, evidence };
}

test("P02-T06 validates many-to-many requirement, oracle, task, evidence, and review coverage deterministically", async () => {
  await withTempRepository(async (repositoryRoot) => {
    await createCompleteTraceabilityArtifacts(repositoryRoot);

    const first = await validateChangeTraceability({ repositoryRoot, changeId: CHANGE_ID });
    const second = await validateChangeTraceability({ repositoryRoot, changeId: CHANGE_ID });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.report.summary.requirements, 2);
    assert.equal(first.report.summary.oracles, 2);
    assert.equal(first.report.summary.tasks, 2);
    assert.equal(first.report.summary.acceptedEvidence, 2);
    assert.equal(stableProtocolJson(first.report), stableProtocolJson(second.report));
  });
});

test("P02-T06 accepts shared oracle coverage without false orphan diagnostics", async () => {
  await withTempRepository(async (repositoryRoot) => {
    await createCompleteTraceabilityArtifacts(repositoryRoot, { sharedOracle: true });

    const result = await validateChangeTraceability({ repositoryRoot, changeId: CHANGE_ID });

    assert.equal(result.ok, true);
    assert.equal(result.report.summary.requirements, 2);
    assert.equal(result.report.summary.oracles, 1);
    assert.equal(result.report.summary.tasks, 2);
    assert.equal(result.report.summary.acceptedEvidence, 2);
  });
});

test("P02-T06 reports calibrated broken traceability chains with exact diagnostics", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const { currentSpec, change } = await createTraceabilityProject(repositoryRoot, {
      betaOracleId: "orc_missing-proof"
    });
    const alphaOracle = await createOracleArtifact({
      repositoryRoot,
      changeId: CHANGE_ID,
      oracle: oracleDocument("req_alpha", "orc_alpha-proof", currentSpec, change),
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(alphaOracle.ok, true);
    const artifactInputs = [change.revision, alphaOracle.revision];
    const taskgraph = await writeTaskGraph({
      repositoryRoot,
      changeId: CHANGE_ID,
      artifactInputs,
      tasks: [taskContract("ctr_alpha-task", "req_alpha", "orc_alpha-proof", currentSpec, change, artifactInputs)],
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(taskgraph.ok, true);
    const evidence = await writeEvidenceIndex({
      repositoryRoot,
      changeId: CHANGE_ID,
      artifactInputs: [change.revision, taskgraph.revision, alphaOracle.revision],
      entries: [evidenceEntry("req_alpha", "evd_alpha-proof", "rev_alpha-review")],
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(evidence.ok, true);

    const result = await validateChangeTraceability({ repositoryRoot, changeId: CHANGE_ID });

    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code).sort();
    assert.deepEqual(codes, [
      "missing_accepted_evidence",
      "missing_oracle_artifact",
      "missing_requirement_task"
    ]);
    assert.equal(result.diagnostics.every((diagnostic) => diagnostic.source.path.includes(".legion/project/")), true);
  });
});

test("P02-T06 applies trace integrity checks to evidence references", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const crossChangeRef = {
      path: ".legion/project/changes/chg_other/evidence-index.json",
      relation: "verifies",
      entity: { kind: "requirement", id: "req_alpha" }
    };
    const alphaEvidence = evidenceEntry("req_alpha", "evd_alpha-proof", "rev_alpha-review");
    await createCompleteTraceabilityArtifacts(repositoryRoot, {
      evidenceEntries: [
        {
          ...alphaEvidence,
          evidence: {
            ...alphaEvidence.evidence,
            traceRefs: [crossChangeRef, crossChangeRef]
          }
        },
        evidenceEntry("req_beta", "evd_beta-proof", "rev_beta-review")
      ]
    });

    const result = await validateChangeTraceability({ repositoryRoot, changeId: CHANGE_ID });

    assert.equal(result.ok, false);
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code).sort();
    assert.ok(codes.includes("cross_change_reference"));
    assert.ok(codes.includes("duplicate_trace_reference"));
  });
});

test("P02-T06 reports stale artifact input revisions after downstream sources change", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const { currentSpec, change, betaOracle } = await createCompleteTraceabilityArtifacts(repositoryRoot);
    const updatedOracle = await updateOracleArtifact({
      repositoryRoot,
      changeId: CHANGE_ID,
      oracle: {
        ...oracleDocument("req_beta", "orc_beta-proof", currentSpec, change),
        title: "req_beta refreshed acceptance proof"
      },
      expectedRevision: betaOracle.artifactDocument.revision,
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(updatedOracle.ok, true);

    const result = await validateChangeTraceability({ repositoryRoot, changeId: CHANGE_ID });

    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "stale_revision_reference"));
  });
});

test("P02-T06 cycle diagnostics name only nodes participating in the cycle", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const upstream = requirement("aardvark", "orc_aardvark-proof");
    const { currentSpec, change } = await createTraceabilityProject(repositoryRoot, {
      updatedAlphaOverrides: {
        traceRefs: [
          {
            path: ".legion/project/specs/req_alpha.md",
            anchor: "req_alpha",
            relation: "refines",
            entity: { kind: "requirement", id: "req_beta" }
          }
        ]
      },
      updatedBetaOverrides: {
        traceRefs: [
          {
            path: ".legion/project/specs/req_alpha.md",
            anchor: "req_beta",
            relation: "refines",
            entity: { kind: "requirement", id: "req_alpha" }
          }
        ]
      },
      updatedRequirementOverrides: {
        req_aardvark: {
          traceRefs: [
            {
              path: ".legion/project/specs/req_alpha.md",
              anchor: "req_aardvark",
              relation: "refines",
              entity: { kind: "requirement", id: "req_alpha" }
            }
          ]
        }
      },
      extraRequirements: [upstream]
    });

    const alphaOracle = await createOracleArtifact({
      repositoryRoot,
      changeId: CHANGE_ID,
      oracle: oracleDocument("req_alpha", "orc_alpha-proof", currentSpec, change),
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(alphaOracle.ok, true);
    const betaOracle = await createOracleArtifact({
      repositoryRoot,
      changeId: CHANGE_ID,
      oracle: oracleDocument("req_beta", "orc_beta-proof", currentSpec, change),
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(betaOracle.ok, true);
    const upstreamOracle = await createOracleArtifact({
      repositoryRoot,
      changeId: CHANGE_ID,
      oracle: oracleDocument("req_aardvark", "orc_aardvark-proof", currentSpec, change),
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(upstreamOracle.ok, true);

    const artifactInputs = [change.revision, upstreamOracle.revision, alphaOracle.revision, betaOracle.revision];
    const taskgraph = await writeTaskGraph({
      repositoryRoot,
      changeId: CHANGE_ID,
      artifactInputs,
      tasks: [
        taskContract("ctr_aardvark-task", "req_aardvark", "orc_aardvark-proof", currentSpec, change, artifactInputs),
        taskContract("ctr_alpha-task", "req_alpha", "orc_alpha-proof", currentSpec, change, artifactInputs),
        taskContract("ctr_beta-task", "req_beta", "orc_beta-proof", currentSpec, change, artifactInputs)
      ],
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(taskgraph.ok, true);

    const evidence = await writeEvidenceIndex({
      repositoryRoot,
      changeId: CHANGE_ID,
      artifactInputs: [change.revision, taskgraph.revision, upstreamOracle.revision, alphaOracle.revision, betaOracle.revision],
      entries: [
        evidenceEntry("req_aardvark", "evd_aardvark-proof", "rev_aardvark-review"),
        evidenceEntry("req_alpha", "evd_alpha-proof", "rev_alpha-review"),
        evidenceEntry("req_beta", "evd_beta-proof", "rev_beta-review")
      ],
      baseGitSha: BASE_GIT_SHA
    });
    assert.equal(evidence.ok, true);

    const result = await validateChangeTraceability({ repositoryRoot, changeId: CHANGE_ID });

    assert.equal(result.ok, false);
    const cycleDiagnostic = result.diagnostics.find((diagnostic) => diagnostic.code === "cyclic_reference");
    assert.ok(cycleDiagnostic);
    assert.match(cycleDiagnostic.message, /requirement:req_alpha/);
    assert.match(cycleDiagnostic.message, /requirement:req_beta/);
    assert.doesNotMatch(cycleDiagnostic.message, /requirement:req_aardvark/);
  });
});

test("P02-T06 impact analysis names only downstream artifacts affected by the changed source", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const { currentSpec } = await createCompleteTraceabilityArtifacts(repositoryRoot);
    const result = await validateChangeTraceability({ repositoryRoot, changeId: CHANGE_ID });
    assert.equal(result.ok, true);

    const impact = analyzeTraceabilityImpact({
      graph: result.report.graph,
      changedArtifactPath: currentSpec.artifactPath,
      changedRequirementIds: ["req_alpha"]
    });

    assert.deepEqual(impact.affectedRequirements, ["req_alpha"]);
    assert.deepEqual(impact.affectedOracles, ["orc_alpha-proof"]);
    assert.deepEqual(impact.affectedTasks, ["ctr_alpha-task"]);
    assert.deepEqual(impact.affectedEvidence, ["evd_alpha-proof"]);
    assert.deepEqual(impact.affectedReviews, ["rev_alpha-review"]);
    assert.deepEqual(impact.affectedArtifacts, [
      ".legion/project/changes/chg_traceability-matrix/delta-specs/req_alpha.md",
      ".legion/project/changes/chg_traceability-matrix/evidence-index.json",
      ".legion/project/changes/chg_traceability-matrix/oracle/orc_alpha-proof.yaml",
      ".legion/project/changes/chg_traceability-matrix/taskgraph.json",
      ".legion/project/specs/req_alpha.md"
    ]);
    assert.equal(impact.affectedTasks.includes("ctr_beta-task"), false);
    assert.equal(impact.affectedEvidence.includes("evd_beta-proof"), false);
  });
});

test("P02-T06 impact analysis carries changed design artifacts through tasks, evidence, and reviews", async () => {
  await withTempRepository(async (repositoryRoot) => {
    const { change } = await createCompleteTraceabilityArtifacts(repositoryRoot);
    const result = await validateChangeTraceability({ repositoryRoot, changeId: CHANGE_ID });
    assert.equal(result.ok, true);

    const impact = analyzeTraceabilityImpact({
      graph: result.report.graph,
      changedArtifactPath: findRevision(change.bundle, "design").artifact.path
    });

    assert.deepEqual(impact.affectedTasks, ["ctr_alpha-task", "ctr_beta-task"]);
    assert.deepEqual(impact.affectedEvidence, ["evd_alpha-proof", "evd_beta-proof"]);
    assert.deepEqual(impact.affectedReviews, ["rev_alpha-review", "rev_beta-review"]);
    assert.deepEqual(impact.affectedArtifacts, [
      ".legion/project/changes/chg_traceability-matrix/design.md",
      ".legion/project/changes/chg_traceability-matrix/evidence-index.json",
      ".legion/project/changes/chg_traceability-matrix/taskgraph.json"
    ]);
  });
});
