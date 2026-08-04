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

import { budgetForWriteScope } from "./budget.js";
import { criterionIdFor, generatedCriterion } from "./criteria.js";
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
  /** The blast-radius limit the interview recorded, when there was one. */
  readonly enforcementBudget?: {
    readonly maxFilesChanged: number;
    readonly maxLinesChanged: number;
    readonly maxNewFiles: number;
  };
}

/**
 * The narrower of a derived budget and the project policy, field by field.
 *
 * Ad-hoc work derives a budget from its write scope, which for a repository-wide
 * request is deliberately generous. Where the operator recorded a limit, that
 * limit wins: a task cannot be granted more room than the project allows just
 * because it arrived through `legion quick` rather than through a plan.
 */
function narrowedToPolicy(
  derived: { readonly maxFilesChanged: number; readonly maxLinesChanged: number; readonly maxNewFiles: number },
  policy:
    | { readonly maxFilesChanged: number; readonly maxLinesChanged: number; readonly maxNewFiles: number }
    | undefined
) {
  if (policy === undefined) return derived;
  return {
    maxFilesChanged: Math.min(derived.maxFilesChanged, policy.maxFilesChanged),
    maxLinesChanged: Math.min(derived.maxLinesChanged, policy.maxLinesChanged),
    maxNewFiles: Math.min(derived.maxNewFiles, policy.maxNewFiles)
  };
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
        // The ad-hoc request carries a real verification command, so its
        // primary criterion is genuinely executable rather than aspirational.
        {
          id: criterionIdFor(input.objective, 0),
          statement: input.objective,
          proof: {
            mode: "executable",
            command: verification.command,
            args: [...verification.args],
            expectedExitCode: 0,
            timeoutMs: 120_000
          }
        },
        // These two are workflow lifecycle facts, not properties of the change;
        // no command decides them.
        generatedCriterion("Build evidence is collected by legion build.", 1),
        generatedCriterion("Review evidence is accepted by a human before ship readiness.", 2)
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
      // Executable, because this function already holds the command that decides
      // it — the same one it writes into `verification` below. Emitting an
      // inspectable oracle here asked a human to confirm what a runner can.
      type: "executable",
      execution: {
        mode: "command",
        command: verification.command,
        args: [...verification.args],
        expectedExitCode: 0,
        timeoutMs: 120_000
      }
    })
  });
  if (!oracle.ok) return oracle;

  const adHocWriteScope = input.writeScope ?? ["."];
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
    agents: ["implementer"],
    dependencies: [],
    context: {
      specRefs: [],
      designRefs: [change.bundle.artifactRevisions.find((entry) => entry.role === "design")?.artifact ?? change.reference],
      predecessorArtifacts: [change.revision, oracle.revision].map((entry) => entry.artifact)
    },
    scope: {
      read: input.readScope ?? [input.sourceArtifactPath, change.artifactPath, oracle.artifactPath],
      write: adHocWriteScope,
      forbidden: [".git", "node_modules", ".legion/project", ".legion/var/runtime.sqlite"],
      sequentialFiles: [],
      // Bounded by the project's own policy when the interview recorded one.
      // A derived budget wider than the operator's limit is a task that escaped
      // the policy through the ad-hoc door — `legion validate` reports exactly
      // that, and it reported it here.
      budget: narrowedToPolicy(
        budgetForWriteScope(adHocWriteScope, { slackFiles: 2 }),
        input.enforcementBudget
      )
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
      blockedConditions: ["Build evidence is missing or review rejects the result."],
      diffReconciliation: { required: true, allowUnlistedReads: true }
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
