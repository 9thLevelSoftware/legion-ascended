import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  approvalSchema,
  evidenceBundleSchema,
  lifecycleFixtureCorpusSchema,
  lifecycleJsonSchemas,
  observationSchema,
  releaseSchema,
  reviewDecisionSchema,
  taskContractSchema,
  preflightTaskContract,
  taskRunSchema,
  taskSchema
} from "../dist/index.js";

async function readLifecycleFixture(name) {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const fixtureDirectory = join(testDirectory, "..", "..", "..", "schemas", "entities", "fixtures");
  return JSON.parse(await readFile(join(fixtureDirectory, name), "utf8"));
}

function hasJsonSchemaVariantRequiring(schema, status, requiredFields) {
  if (schema && typeof schema === "object") {
    const properties = schema.properties;
    const required = Array.isArray(schema.required) ? schema.required : [];
    const statusSchema = properties?.status;

    if (statusSchema?.const === status && requiredFields.every((field) => required.includes(field))) {
      return true;
    }

    return Object.values(schema).some((value) => hasJsonSchemaVariantRequiring(value, status, requiredFields));
  }

  return false;
}

test("P01-T05 valid lifecycle fixture corpus parses and serializes identically", async () => {
  const valid = await readLifecycleFixture("lifecycle-valid.json");

  assert.deepEqual(lifecycleFixtureCorpusSchema.parse(valid), valid);
});

test("P01-T05 keeps task contract, operational task, and run attempt separate", async () => {
  const valid = await readLifecycleFixture("lifecycle-valid.json");

  assert.equal(taskContractSchema.safeParse(valid.taskContract).success, true);
  assert.equal(taskSchema.safeParse(valid.task).success, true);
  assert.equal(taskRunSchema.safeParse(valid.taskRun).success, true);

  assert.equal(valid.taskContract.wave, "A");
  assert.deepEqual(valid.taskContract.agents, ["protocol-planner"]);
  assert.equal(taskContractSchema.safeParse({ ...valid.taskContract, status: "ready" }).success, false);
  assert.equal(taskSchema.safeParse({ ...valid.task, objective: valid.taskContract.objective }).success, false);
  assert.equal(taskRunSchema.safeParse({ ...valid.taskRun, scope: valid.taskContract.scope }).success, false);
});

test("P01-T05 task contracts preflight dependency satisfaction, resource availability, and contract completeness", async () => {
  const { taskContract } = await readLifecycleFixture("lifecycle-valid.json");

  const satisfied = preflightTaskContract(taskContract, {
    availableContracts: [{ contractId: taskContract.id, revision: taskContract.revision }],
    availableAgents: taskContract.agents,
    availableArtifacts: taskContract.context.predecessorArtifacts
  });
  assert.equal(satisfied.ok, true);
  assert.deepEqual(satisfied.issues, []);

  const dependencyBlocked = preflightTaskContract(
    {
      ...taskContract,
      dependencies: [{ contractId: "ctr_missing-dependency", revision: 2 }]
    },
    {
      availableContracts: [{ contractId: taskContract.id, revision: taskContract.revision }],
      availableAgents: taskContract.agents,
      availableArtifacts: taskContract.context.predecessorArtifacts
    }
  );
  assert.equal(dependencyBlocked.ok, false);
  assert.equal(dependencyBlocked.issues[0].code, "dependency_unsatisfied");

  const resourceBlocked = preflightTaskContract(taskContract, {
    availableContracts: [{ contractId: taskContract.id, revision: taskContract.revision }],
    availableAgents: []
  });
  assert.equal(resourceBlocked.ok, false);
  assert.equal(resourceBlocked.issues[0].code, "resource_unavailable");

  const incomplete = preflightTaskContract(
    {
      ...taskContract,
      context: {
        ...taskContract.context,
        specRefs: [],
        designRefs: [],
        predecessorArtifacts: []
      },
      completion: {
        ...taskContract.completion,
        expectedArtifacts: []
      }
    },
    {
      availableContracts: [{ contractId: taskContract.id, revision: taskContract.revision }],
      availableAgents: taskContract.agents
    }
  );
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.issues[0].code, "contract_incomplete");
  assert.equal(incomplete.issues.at(-1).code, "contract_incomplete");
});

test("P01-T05 task contracts reject unsafe scope and incomplete verification contracts", async () => {
  const { taskContract } = await readLifecycleFixture("lifecycle-valid.json");

  assert.equal(
    taskContractSchema.safeParse({
      ...taskContract,
      scope: {
        ...taskContract.scope,
        forbidden: [taskContract.scope.write[0]]
      }
    }).success,
    false
  );
  assert.equal(taskContractSchema.safeParse({ ...taskContract, verification: [] }).success, false);
  assert.equal(taskContractSchema.safeParse({ ...taskContract, wave: undefined }).success, false);
  assert.equal(taskContractSchema.safeParse({ ...taskContract, agents: [] }).success, false);
  assert.equal(
    taskContractSchema.safeParse({
      ...taskContract,
      risk: {
        tier: "R2",
        reasons: ["public-schema-contract"]
      },
      completion: {
        ...taskContract.completion,
        blockedConditions: []
      }
    }).success,
    false
  );
});

test("P01-T05 task run manifests are frozen after start", async () => {
  const { taskRun } = await readLifecycleFixture("lifecycle-valid.json");

  assert.equal(taskRunSchema.safeParse(taskRun).success, true);
  assert.equal(
    taskRunSchema.safeParse({
      ...taskRun,
      manifest: {
        ...taskRun.manifest,
        frozenAt: undefined
      }
    }).success,
    false
  );
  assert.equal(
    taskRunSchema.safeParse({
      ...taskRun,
      status: "created",
      startedAt: undefined,
      manifest: {
        ...taskRun.manifest,
        frozenAt: undefined
      }
    }).success,
    true
  );
});

test("P01-T05 evidence and reviews can represent unknown or not verified results", async () => {
  const { evidenceBundle, reviewDecision } = await readLifecycleFixture("lifecycle-valid.json");

  assert.equal(
    evidenceBundleSchema.safeParse({
      ...evidenceBundle,
      status: "unknown",
      items: [
        {
          ...evidenceBundle.items[0],
          verdict: "not_verified"
        }
      ]
    }).success,
    true
  );
  assert.equal(
    reviewDecisionSchema.safeParse({
      ...reviewDecision,
      verdicts: {
        specification: "unknown",
        integration: "not_verified",
        evidence: "unknown"
      }
    }).success,
    true
  );
});

test("P01-T05 review findings require evidence for blocking severity", async () => {
  const { reviewDecision } = await readLifecycleFixture("lifecycle-valid.json");

  assert.equal(
    reviewDecisionSchema.safeParse({
      ...reviewDecision,
      findings: [
        {
          id: "finding-blocking-no-evidence",
          severity: "blocking",
          title: "Missing proof",
          body: "A blocking finding must cite evidence."
        }
      ]
    }).success,
    false
  );
});

test("P01-T05 approvals require explicit action scope and idempotency", async () => {
  const { approval } = await readLifecycleFixture("lifecycle-valid.json");

  assert.equal(approvalSchema.safeParse(approval).success, true);
  assert.equal(
    approvalSchema.safeParse({
      ...approval,
      scope: {
        ...approval.scope,
        targets: []
      }
    }).success,
    false
  );
  assert.equal(approvalSchema.safeParse({ ...approval, idempotencyKey: undefined }).success, false);
});

test("P01-T05 release and observation schemas represent rollback and forward-fix paths", async () => {
  const { release, observation } = await readLifecycleFixture("lifecycle-valid.json");

  assert.equal(releaseSchema.safeParse(release).success, true);
  assert.equal(observationSchema.safeParse(observation).success, true);
  assert.equal(releaseSchema.safeParse({ ...release, status: "forward_fix_required", forwardFixPlan: undefined }).success, false);
  assert.equal(observationSchema.safeParse({ ...observation, status: "rolled_back", rollbackEvidenceRefs: [] }).success, false);
});

test("review feedback: lifecycle schemas reject impossible chronology and empty collected evidence", async () => {
  const { approval, evidenceBundle, observation, release, reviewDecision, taskRun } = await readLifecycleFixture("lifecycle-valid.json");

  assert.equal(
    taskRunSchema.safeParse({
      ...taskRun,
      status: "succeeded",
      finishedAt: "2026-06-20T01:31:00.000Z"
    }).success,
    false
  );
  assert.equal(
    approvalSchema.safeParse({
      ...approval,
      decidedAt: "2026-06-20T01:34:00.000Z"
    }).success,
    false
  );
  assert.equal(
    approvalSchema.safeParse({
      ...approval,
      expiresAt: "2026-06-20T01:34:00.000Z"
    }).success,
    false
  );
  assert.equal(
    observationSchema.safeParse({
      ...observation,
      endedAt: "2026-06-20T01:37:00.000Z"
    }).success,
    false
  );
  assert.equal(
    releaseSchema.safeParse({
      ...release,
      deployment: {
        ...release.deployment,
        deployedAt: "2026-06-20T01:36:00.000Z"
      }
    }).success,
    false
  );
  assert.equal(
    evidenceBundleSchema.safeParse({
      ...evidenceBundle,
      retention: {
        ...evidenceBundle.retention,
        retainUntil: "2026-06-20T01:32:00.000Z"
      }
    }).success,
    false
  );
  assert.equal(
    evidenceBundleSchema.safeParse({
      ...evidenceBundle,
      items: [
        {
          ...evidenceBundle.items[0],
          command: {
            ...evidenceBundle.items[0].command,
            startedAt: "2026-06-20T01:40:00.000Z",
            endedAt: "2026-06-20T01:39:00.000Z"
          }
        }
      ]
    }).success,
    false
  );
  assert.equal(evidenceBundleSchema.safeParse({ ...evidenceBundle, status: "collected", items: [] }).success, false);
  assert.equal(reviewDecisionSchema.safeParse({ ...reviewDecision, status: "accepted", submittedAt: undefined }).success, false);
  assert.equal(
    reviewDecisionSchema.safeParse({
      ...reviewDecision,
      submittedAt: "2026-06-20T01:33:00.000Z"
    }).success,
    false
  );
});

test("review feedback: submitted review audit fields are represented in generated JSON Schema", () => {
  assert.equal(hasJsonSchemaVariantRequiring(lifecycleJsonSchemas.reviewDecision, "submitted", ["submittedAt"]), true);
  assert.equal(hasJsonSchemaVariantRequiring(lifecycleJsonSchemas.reviewDecision, "accepted", ["submittedAt"]), true);
  assert.equal(hasJsonSchemaVariantRequiring(lifecycleJsonSchemas.reviewDecision, "rejected", ["submittedAt"]), true);
  assert.equal(hasJsonSchemaVariantRequiring(lifecycleJsonSchemas.reviewDecision, "superseded", ["submittedAt"]), true);
});

test("P01-T05 invalid lifecycle fixture cases are rejected", async () => {
  const invalid = await readLifecycleFixture("lifecycle-invalid.json");

  for (const entry of invalid.cases) {
    const schema = {
      taskContract: taskContractSchema,
      task: taskSchema,
      taskRun: taskRunSchema,
      evidenceBundle: evidenceBundleSchema,
      reviewDecision: reviewDecisionSchema,
      approval: approvalSchema,
      release: releaseSchema,
      observation: observationSchema
    }[entry.schema];

    assert.ok(schema, `unknown invalid fixture schema ${entry.schema}`);
    assert.equal(schema.safeParse(entry.value).success, false, entry.name);
  }
});

test("P01-T05 generated lifecycle JSON schemas match committed artifacts", async () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const schemaDirectory = join(testDirectory, "..", "..", "..", "schemas", "entities");

  const expectedFiles = {
    taskContract: "task-contract.schema.json",
    task: "task.schema.json",
    taskRun: "task-run.schema.json",
    evidenceBundle: "evidence.schema.json",
    reviewDecision: "review.schema.json",
    approval: "approval.schema.json",
    release: "release.schema.json",
    observation: "observation.schema.json"
  };

  for (const [name, fileName] of Object.entries(expectedFiles)) {
    const committed = JSON.parse(await readFile(join(schemaDirectory, fileName), "utf8"));
    assert.deepEqual(committed, lifecycleJsonSchemas[name]);
  }
});
