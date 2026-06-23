import {
  artifactPathForRole,
  createChangeBundle,
  createCurrentSpec,
  createOracleArtifact,
  readCurrentSpec,
  writeTaskGraph
} from "@legion/artifacts";
import {
  LEGION_PROTOCOL_VERSION,
  oracleSchema,
  requirementSchema,
  taskContractSchema,
  formatEntityId,
  type Project,
  type UtcTimestamp
} from "@legion/protocol";

import { currentUtcTimestamp, firstDecisionOwner, resolveBaseGitSha } from "./change-input.js";
import { slugFromName } from "./input.js";

export interface AdHocTaskgraphInput {
  readonly repositoryRoot: string;
  readonly project: Project;
  readonly kind: "quick" | "polish";
  readonly title: string;
  readonly objective: string;
  readonly sourceArtifactPath: string;
  readonly idSlug?: string;
  readonly createdAt?: UtcTimestamp;
  readonly readScope?: readonly string[];
  readonly writeScope?: readonly string[];
  readonly verificationCommand?: readonly string[];
}

export async function createAdHocTaskgraph(input: AdHocTaskgraphInput) {
  const createdAt = input.createdAt ?? currentUtcTimestamp();
  const baseGitSha = resolveBaseGitSha(input.repositoryRoot);
  const owner = firstDecisionOwner(input.project);
  const suffix = adHocSuffix(input.kind, input.title, createdAt, input.idSlug);
  const requirementId = formatEntityId("requirement", suffix);
  const changeId = formatEntityId("change", suffix);
  const oracleId = formatEntityId("oracle", suffix);
  const contractId = formatEntityId("contract", suffix);
  const currentSpecPath = artifactPathForRole({ role: "current-spec", requirementId });
  const taskgraphPath = artifactPathForRole({ role: "taskgraph", changeId });
  const verification = commandParts(input.verificationCommand ?? ["legion", "validate"]);

  const requirement = requirementSchema.parse({
    schemaVersion: LEGION_PROTOCOL_VERSION,
    createdAt,
    kind: "requirement",
    id: requirementId,
    projectId: input.project.id,
    priority: "must",
    category: input.kind === "polish" ? "quality" : "behavior",
    status: "accepted",
    statement: input.objective,
    acceptance: {
      language: `${input.title} is complete when the requested work is implemented, verified, and reviewed.`,
      criteria: [
        input.objective,
        "Build evidence is collected by legion build.",
        "Review evidence is accepted by a human before ship readiness."
      ],
      oracleRefs: [oracleId]
    },
    traceRefs: [
      {
        path: currentSpecPath,
        anchor: requirementId,
        relation: "defines",
        entity: { kind: "requirement", id: requirementId }
      },
      {
        path: input.sourceArtifactPath,
        anchor: suffix,
        relation: "defines",
        entity: { kind: "requirement", id: requirementId }
      }
    ],
    supersedes: []
  });

  const currentSpecInput = {
    repositoryRoot: input.repositoryRoot,
    document: {
      primaryRequirementId: requirementId,
      capability: {
        id: suffix,
        title: input.title,
        status: "active" as const
      },
      requirements: [requirement],
      sections: {
        purpose: input.objective,
        behaviors: input.objective,
        constraints: "Ad-hoc Legion work must remain scoped, evidence-backed, and human-reviewed.",
        scenarios: `A maintainer runs legion ${input.kind} and then legion build to execute this work.`,
        interfaces: `legion ${input.kind}`,
        compatibility: "The generated taskgraph uses the same build/review path as roadmap phases.",
        failureModes: "If artifacts cannot be written or validated, the command returns typed diagnostics.",
        traceIds: [requirementId]
      }
    }
  };

  const currentSpec = await readCurrentSpec({
    repositoryRoot: input.repositoryRoot,
    requirementId
  });
  const spec = currentSpec.ok ? currentSpec : await createCurrentSpec(currentSpecInput);
  if (!spec.ok) return spec;

  const change = await createChangeBundle({
    repositoryRoot: input.repositoryRoot,
    changeId,
    projectId: input.project.id,
    title: input.title,
    summary: input.objective,
    owners: [owner],
    baseGitSha,
    risk: {
      tier: input.kind === "polish" ? "R1" : "R2",
      reasons: [`${input.kind} work is explicitly requested and remains review-gated.`]
    },
    createdAt,
    currentSpecs: [
      {
        requirementId: spec.document.primaryRequirementId,
        expectedRevision: spec.document.revision
      }
    ],
    deltaSpecs: [
      {
        operation: "modify",
        requirementId,
        proposedRequirement: requirement,
        sections: currentSpecInput.document.sections,
        rationale: `Create a typed ${input.kind} taskgraph for guided execution.`
      }
    ],
    design: {
      title: input.title,
      body: [
        `Source: ${input.sourceArtifactPath}`,
        "",
        input.objective
      ].join("\n")
    }
  });
  if (!change.ok) return change;

  const oraclePath = artifactPathForRole({ role: "oracle", changeId, oracleId });
  const oracle = await createOracleArtifact({
    repositoryRoot: input.repositoryRoot,
    changeId,
    baseGitSha,
    oracle: oracleSchema.parse({
      schemaVersion: LEGION_PROTOCOL_VERSION,
      createdAt,
      kind: "oracle",
      id: oracleId,
      projectId: input.project.id,
      title: `${input.title} acceptance oracle`,
      owner,
      protectedPaths: [change.artifactPath],
      sourceArtifacts: [change.reference],
      expected: {
        preconditions: ["The ad-hoc taskgraph exists and validates."],
        postconditions: ["The requested work is implemented and backed by build evidence."],
        evidence: ["Build and review evidence is attached through the standard Legion loop."]
      },
      requirementCoverage: [
        {
          requirementId,
          coverage: "primary",
          criteria: ["The ad-hoc request has been implemented, verified, and reviewed."]
        }
      ],
      traceRefs: [
        {
          path: oraclePath,
          anchor: oracleId,
          relation: "verifies",
          entity: { kind: "requirement", id: requirementId }
        }
      ],
      type: "inspectable",
      execution: {
        mode: "manual-inspection",
        instructions: `Review implementation and evidence for: ${input.objective}`
      }
    })
  });
  if (!oracle.ok) return oracle;

  const task = taskContractSchema.parse({
    schemaVersion: LEGION_PROTOCOL_VERSION,
    createdAt,
    kind: "task-contract",
    id: contractId,
    projectId: input.project.id,
    changeId,
    revision: 1,
    title: input.title,
    objective: input.objective,
    requirementIds: [requirementId],
    wave: "A",
    agents: [input.kind === "polish" ? "code-polisher" : "workflow-implementer"],
    dependencies: [],
    context: {
      specRefs: [],
      designRefs: [change.bundle.artifactRevisions.find((entry) => entry.role === "design")?.artifact ?? change.reference],
      predecessorArtifacts: [change.revision, oracle.revision].map((entry) => entry.artifact)
    },
    scope: {
      read: input.readScope ?? [input.sourceArtifactPath, change.artifactPath, oracle.artifactPath],
      write: input.writeScope ?? [taskgraphPath],
      forbidden: [".git", "node_modules", ".legion/var/runtime.sqlite"],
      sequentialFiles: []
    },
    interfaces: {
      consumes: [{ name: "AdHocRequest", description: `The ${input.kind} request prepared by Legion.` }],
      produces: [{ name: "BuildEvidence", description: "Implementation and verification evidence." }]
    },
    oracleRefs: [oracleId],
    verification: [
      {
        command: verification.command,
        args: verification.args,
        expectedExitCode: 0,
        timeoutMs: 120_000
      }
    ],
    risk: {
      tier: input.kind === "polish" ? "R1" : "R2",
      reasons: [`${input.kind} work is bounded by a generated task contract.`]
    },
    approvals: [],
    completion: {
      expectedArtifacts: [change.reference],
      requiredEvidence: [`${verification.command} ${verification.args.join(" ")}`.trim()],
      blockedConditions: ["Build evidence is missing or review rejects the result."]
    }
  });

  const taskgraph = await writeTaskGraph({
    repositoryRoot: input.repositoryRoot,
    changeId,
    tasks: [task],
    artifactInputs: [change.revision, oracle.revision],
    baseGitSha
  });
  if (!taskgraph.ok) return taskgraph;

  return {
    ok: true as const,
    status: "planned" as const,
    change,
    oracle,
    taskgraph,
    taskgraphPath,
    taskId: task.id
  };
}

function adHocSuffix(kind: "quick" | "polish", title: string, createdAt: UtcTimestamp, idSlug: string | undefined): string {
  if (idSlug !== undefined) {
    return `${kind}-${slugFromName(idSlug).slice(0, 56).replace(/-+$/g, "")}`.slice(0, 63).replace(/-+$/g, "");
  }
  const timestamp = createdAt.replace(/[^0-9]/g, "").slice(0, 14);
  const slug = slugFromName(title).slice(0, 48).replace(/-+$/g, "") || "task";
  return `${kind}-${timestamp}-${slug}`.slice(0, 63).replace(/-+$/g, "");
}

function commandParts(parts: readonly string[]): { readonly command: string; readonly args: readonly string[] } {
  const command = parts[0] ?? "legion";
  return {
    command,
    args: parts.slice(1)
  };
}
