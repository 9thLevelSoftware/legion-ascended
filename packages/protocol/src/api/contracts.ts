import * as z from "zod";

import { actorSchema, protocolErrorSchema } from "../primitives/common.js";
import {
  approvalIdSchema,
  changeIdSchema,
  contractIdSchema,
  decisionIdSchema,
  eventIdSchema,
  evidenceIdSchema,
  observationIdSchema,
  oracleIdSchema,
  projectIdSchema,
  releaseIdSchema,
  requirementIdSchema,
  reviewIdSchema,
  runIdSchema,
  taskIdSchema
} from "../primitives/ids.js";
import {
  artifactReferenceSchema,
  correlationIdSchema,
  gitShaSchema,
  idempotencyKeySchema,
  metadataSchema,
  paginationCursorSchema,
  utcTimestampSchema
} from "../primitives/values.js";
import { riskTierSchema } from "../entities/common.js";
import { releaseEnvironmentSchema } from "../entities/release.js";
import { reviewVerdictSchema } from "../entities/review.js";
import { taskStatusSchema } from "../entities/task.js";
import { eventEnvelopeSchema } from "../events/envelope.js";

export const API_COMMAND_TYPES = [
  "project.init.v1",
  "baseline.refresh.v1",
  "change.create.v1",
  "change.specify.v1",
  "change.oracle.v1",
  "change.design.v1",
  "change.plan.v1",
  "change.revise.v1",
  "task.create.v1",
  "task.claim.v1",
  "task.block.v1",
  "task.complete.v1",
  "task.invalidate.v1",
  "run.start.v1",
  "approval.request.v1",
  "approval.decide.v1",
  "review.submit.v1",
  "release.request.v1",
  "observation.record.v1",
  "archive.create.v1",
  "worker.create.v1",
  "council.request.v1",
  "doctor.run.v1"
] as const;

export const STATE_CHANGING_COMMAND_TYPES = [
  "project.init.v1",
  "baseline.refresh.v1",
  "change.create.v1",
  "change.specify.v1",
  "change.oracle.v1",
  "change.design.v1",
  "change.plan.v1",
  "change.revise.v1",
  "task.create.v1",
  "task.claim.v1",
  "task.block.v1",
  "task.complete.v1",
  "task.invalidate.v1",
  "run.start.v1",
  "approval.request.v1",
  "approval.decide.v1",
  "review.submit.v1",
  "release.request.v1",
  "observation.record.v1",
  "archive.create.v1",
  "worker.create.v1",
  "council.request.v1"
] as const;

export const API_QUERY_TYPES = [
  "board.snapshot.v1",
  "change.detail.v1",
  "task.list.v1",
  "event.stream.v1",
  "release.status.v1"
] as const;

export const commandTypeSchema = z.enum(API_COMMAND_TYPES);
export const stateChangingCommandTypeSchema = z.enum(STATE_CHANGING_COMMAND_TYPES);
export const queryTypeSchema = z.enum(API_QUERY_TYPES);

export type CommandType = z.infer<typeof commandTypeSchema>;
export type StateChangingCommandType = z.infer<typeof stateChangingCommandTypeSchema>;
export type QueryType = z.infer<typeof queryTypeSchema>;

export const commandIdSchema = z
  .string()
  .regex(/^cmd_[0-9a-hjkmnp-tv-z]{26}$/, "Invalid command ID")
  .brand<"CommandId">();

export const queryIdSchema = z
  .string()
  .regex(/^qry_[0-9a-hjkmnp-tv-z]{26}$/, "Invalid query ID")
  .brand<"QueryId">();

export type CommandId = z.infer<typeof commandIdSchema>;
export type QueryId = z.infer<typeof queryIdSchema>;

const currentApiSchemaVersion = z.literal("0.1.0");
const boundedTextSchema = z.string().min(1).max(2_048);
const commandModeSchema = z.enum(["planned", "explore", "adhoc"]);
const skillIdSchema = z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/, "Invalid skill ID");
const workerBundleIdSchema = z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/, "Invalid worker bundle ID");
const councilTopicSchema = z.string().min(1).max(256);

const projectInitPayloadSchema = z.strictObject({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/, "Invalid project slug"),
  name: z.string().min(1).max(128),
  repository: artifactReferenceSchema.optional()
});

const baselineRefreshPayloadSchema = z.strictObject({
  reason: boundedTextSchema,
  baseCommit: gitShaSchema.optional()
});

const changeCreatePayloadSchema = z.strictObject({
  title: z.string().min(1).max(160),
  summary: boundedTextSchema,
  mode: commandModeSchema,
  riskTier: riskTierSchema
});

const changeArtifactPayloadSchema = z.strictObject({
  changeId: changeIdSchema,
  artifact: artifactReferenceSchema
});

const changeRevisePayloadSchema = z.strictObject({
  changeId: changeIdSchema,
  reason: boundedTextSchema,
  targetRevision: z.number().int().positive()
});

const taskCreatePayloadSchema = z.strictObject({
  changeId: changeIdSchema,
  contractId: contractIdSchema,
  contractRevision: z.number().int().positive(),
  priority: z.number().int().min(0).max(1_000)
});

const taskClaimPayloadSchema = z.strictObject({
  taskId: taskIdSchema,
  workerBundleId: workerBundleIdSchema
});

const taskBlockPayloadSchema = z.strictObject({
  taskId: taskIdSchema,
  reason: boundedTextSchema
});

const taskCompletePayloadSchema = z.strictObject({
  taskId: taskIdSchema,
  runId: runIdSchema,
  evidenceRefs: z.array(evidenceIdSchema).min(1)
});

const taskInvalidatePayloadSchema = z.strictObject({
  taskId: taskIdSchema,
  reason: boundedTextSchema
});

const runStartPayloadSchema = z.strictObject({
  taskId: taskIdSchema,
  contractId: contractIdSchema,
  contractRevision: z.number().int().positive()
});

const approvalRequestPayloadSchema = z.strictObject({
  taskId: taskIdSchema.optional(),
  runId: runIdSchema.optional(),
  action: z.string().regex(/^[a-z][a-z0-9._:-]{1,127}$/, "Invalid approval action"),
  reason: boundedTextSchema
});

const approvalDecidePayloadSchema = z.strictObject({
  approvalId: approvalIdSchema,
  decision: z.enum(["granted", "denied"]),
  reason: boundedTextSchema
});

const reviewSubmitPayloadSchema = z.strictObject({
  reviewId: reviewIdSchema,
  verdict: reviewVerdictSchema,
  evidenceRefs: z.array(evidenceIdSchema)
});

const releaseRequestPayloadSchema = z.strictObject({
  changeId: changeIdSchema,
  environment: releaseEnvironmentSchema,
  taskRefs: z.array(taskIdSchema).min(1)
});

const observationRecordPayloadSchema = z.strictObject({
  releaseId: releaseIdSchema,
  status: z.enum(["healthy", "failed", "rolled_back", "forward_fix_required"]),
  evidenceRefs: z.array(evidenceIdSchema)
});

const archiveCreatePayloadSchema = z.strictObject({
  changeId: changeIdSchema,
  retrospective: z.boolean()
});

const workerCreatePayloadSchema = z.strictObject({
  bundleId: workerBundleIdSchema,
  skillRefs: z.array(skillIdSchema)
});

const councilRequestPayloadSchema = z.strictObject({
  topic: councilTopicSchema,
  decisionRefs: z.array(z.union([changeIdSchema, decisionIdSchema])).min(1)
});

const doctorRunPayloadSchema = z
  .strictObject({
    scope: z.enum(["project", "change", "task", "schema"]),
    targetId: z.union([projectIdSchema, changeIdSchema, taskIdSchema]).optional()
  })
  .superRefine((payload, context) => {
    if (!payload.targetId || payload.scope === "schema") return;

    const expectedPrefix = {
      project: "prj_",
      change: "chg_",
      task: "tsk_"
    }[payload.scope];

    if (!payload.targetId.startsWith(expectedPrefix)) {
      context.addIssue({
        code: "custom",
        message: `targetId must match doctor scope ${payload.scope}`,
        path: ["targetId"]
      });
    }
  });

const commandPayloadSchema = z.union([
  projectInitPayloadSchema,
  baselineRefreshPayloadSchema,
  changeCreatePayloadSchema,
  changeArtifactPayloadSchema,
  changeRevisePayloadSchema,
  taskCreatePayloadSchema,
  taskClaimPayloadSchema,
  taskBlockPayloadSchema,
  taskCompletePayloadSchema,
  taskInvalidatePayloadSchema,
  runStartPayloadSchema,
  approvalRequestPayloadSchema,
  approvalDecidePayloadSchema,
  reviewSubmitPayloadSchema,
  releaseRequestPayloadSchema,
  observationRecordPayloadSchema,
  archiveCreatePayloadSchema,
  workerCreatePayloadSchema,
  councilRequestPayloadSchema,
  doctorRunPayloadSchema
]);

const commandPayloadSchemas: Record<CommandType, z.ZodType> = {
  "project.init.v1": projectInitPayloadSchema,
  "baseline.refresh.v1": baselineRefreshPayloadSchema,
  "change.create.v1": changeCreatePayloadSchema,
  "change.specify.v1": changeArtifactPayloadSchema,
  "change.oracle.v1": changeArtifactPayloadSchema,
  "change.design.v1": changeArtifactPayloadSchema,
  "change.plan.v1": changeArtifactPayloadSchema,
  "change.revise.v1": changeRevisePayloadSchema,
  "task.create.v1": taskCreatePayloadSchema,
  "task.claim.v1": taskClaimPayloadSchema,
  "task.block.v1": taskBlockPayloadSchema,
  "task.complete.v1": taskCompletePayloadSchema,
  "task.invalidate.v1": taskInvalidatePayloadSchema,
  "run.start.v1": runStartPayloadSchema,
  "approval.request.v1": approvalRequestPayloadSchema,
  "approval.decide.v1": approvalDecidePayloadSchema,
  "review.submit.v1": reviewSubmitPayloadSchema,
  "release.request.v1": releaseRequestPayloadSchema,
  "observation.record.v1": observationRecordPayloadSchema,
  "archive.create.v1": archiveCreatePayloadSchema,
  "worker.create.v1": workerCreatePayloadSchema,
  "council.request.v1": councilRequestPayloadSchema,
  "doctor.run.v1": doctorRunPayloadSchema
};

export interface CommandResultContract {
  readonly successType: `${string}.accepted.v1`;
  readonly rejectionType: `${string}.rejected.v1`;
  readonly rejectionCodes: readonly string[];
}

export interface CommandCatalogEntry {
  readonly type: CommandType;
  readonly stateChanging: boolean;
  readonly summary: string;
  readonly result: CommandResultContract;
}

function resultContract(prefix: string, rejectionCodes: readonly string[]): CommandResultContract {
  return {
    successType: `${prefix}.accepted.v1`,
    rejectionType: `${prefix}.rejected.v1`,
    rejectionCodes
  };
}

export const COMMAND_CATALOG: Record<CommandType, CommandCatalogEntry> = {
  "project.init.v1": {
    type: "project.init.v1",
    stateChanging: true,
    summary: "Initialize a project workflow root.",
    result: resultContract("project.init", ["project_exists", "invalid_policy"])
  },
  "baseline.refresh.v1": {
    type: "baseline.refresh.v1",
    stateChanging: true,
    summary: "Record a refreshed project baseline.",
    result: resultContract("baseline.refresh", ["baseline_conflict", "artifact_missing"])
  },
  "change.create.v1": {
    type: "change.create.v1",
    stateChanging: true,
    summary: "Create a workflow change.",
    result: resultContract("change.create", ["duplicate_change", "invalid_risk"])
  },
  "change.specify.v1": {
    type: "change.specify.v1",
    stateChanging: true,
    summary: "Attach specification artifacts to a change.",
    result: resultContract("change.specify", ["change_not_found", "artifact_rejected"])
  },
  "change.oracle.v1": {
    type: "change.oracle.v1",
    stateChanging: true,
    summary: "Attach oracle artifacts to a change.",
    result: resultContract("change.oracle", ["change_not_found", "oracle_rejected"])
  },
  "change.design.v1": {
    type: "change.design.v1",
    stateChanging: true,
    summary: "Attach design artifacts to a change.",
    result: resultContract("change.design", ["change_not_found", "design_rejected"])
  },
  "change.plan.v1": {
    type: "change.plan.v1",
    stateChanging: true,
    summary: "Attach task planning artifacts to a change.",
    result: resultContract("change.plan", ["change_not_ready", "plan_rejected"])
  },
  "change.revise.v1": {
    type: "change.revise.v1",
    stateChanging: true,
    summary: "Revise a change after feedback.",
    result: resultContract("change.revise", ["change_not_found", "revision_conflict"])
  },
  "task.create.v1": {
    type: "task.create.v1",
    stateChanging: true,
    summary: "Create an operational task from a task contract.",
    result: resultContract("task.create", ["contract_not_found", "dependency_blocked"])
  },
  "task.claim.v1": {
    type: "task.claim.v1",
    stateChanging: true,
    summary: "Claim a task for a worker run.",
    result: resultContract("task.claim", ["task_not_ready", "claim_conflict"])
  },
  "task.block.v1": {
    type: "task.block.v1",
    stateChanging: true,
    summary: "Record a task blocker.",
    result: resultContract("task.block", ["task_not_found", "invalid_blocker"])
  },
  "task.complete.v1": {
    type: "task.complete.v1",
    stateChanging: true,
    summary: "Record task completion.",
    result: resultContract("task.complete", ["task_not_running", "evidence_missing"])
  },
  "task.invalidate.v1": {
    type: "task.invalidate.v1",
    stateChanging: true,
    summary: "Invalidate a stale task.",
    result: resultContract("task.invalidate", ["task_not_found", "already_terminal"])
  },
  "run.start.v1": {
    type: "run.start.v1",
    stateChanging: true,
    summary: "Start a task run.",
    result: resultContract("run.start", ["task_not_claimed", "manifest_invalid"])
  },
  "approval.request.v1": {
    type: "approval.request.v1",
    stateChanging: true,
    summary: "Request approval for an effect.",
    result: resultContract("approval.request", ["scope_invalid", "duplicate_request"])
  },
  "approval.decide.v1": {
    type: "approval.decide.v1",
    stateChanging: true,
    summary: "Record an approval decision.",
    result: resultContract("approval.decide", ["approval_not_found", "already_decided"])
  },
  "review.submit.v1": {
    type: "review.submit.v1",
    stateChanging: true,
    summary: "Submit review findings.",
    result: resultContract("review.submit", ["review_not_found", "evidence_missing"])
  },
  "release.request.v1": {
    type: "release.request.v1",
    stateChanging: true,
    summary: "Request a release.",
    result: resultContract("release.request", ["change_not_ready", "approval_missing"])
  },
  "observation.record.v1": {
    type: "observation.record.v1",
    stateChanging: true,
    summary: "Record release observation data.",
    result: resultContract("observation.record", ["release_not_found", "evidence_missing"])
  },
  "archive.create.v1": {
    type: "archive.create.v1",
    stateChanging: true,
    summary: "Archive completed workflow evidence.",
    result: resultContract("archive.create", ["change_not_terminal", "evidence_missing"])
  },
  "worker.create.v1": {
    type: "worker.create.v1",
    stateChanging: true,
    summary: "Register a worker bundle extension.",
    result: resultContract("worker.create", ["bundle_exists", "skill_missing"])
  },
  "council.request.v1": {
    type: "council.request.v1",
    stateChanging: true,
    summary: "Request governance council deliberation.",
    result: resultContract("council.request", ["topic_invalid", "decision_conflict"])
  },
  "doctor.run.v1": {
    type: "doctor.run.v1",
    stateChanging: false,
    summary: "Run protocol and state diagnostics without mutating workflow state.",
    result: resultContract("doctor.run", ["scope_invalid", "target_missing"])
  }
};

export const commandEnvelopeSchema = z
  .strictObject({
    schemaVersion: currentApiSchemaVersion,
    id: commandIdSchema,
    type: commandTypeSchema,
    version: z.literal(1),
    projectId: projectIdSchema,
    changeId: changeIdSchema.optional(),
    taskId: taskIdSchema.optional(),
    runId: runIdSchema.optional(),
    correlationId: correlationIdSchema.optional(),
    actor: actorSchema,
    issuedAt: utcTimestampSchema,
    idempotencyKey: idempotencyKeySchema.optional(),
    payload: commandPayloadSchema,
    metadata: metadataSchema.optional()
  })
  .superRefine((command, context) => {
    const schema = commandPayloadSchemas[command.type];

    if (!schema) {
      context.addIssue({
        code: "custom",
        message: `command type ${command.type} is not cataloged`,
        path: ["type"]
      });
      return;
    }

    const payloadResult = schema.safeParse(command.payload);
    if (!payloadResult.success) {
      context.addIssue({
        code: "custom",
        message: `payload does not match command type ${command.type}`,
        path: ["payload"]
      });
    }
  });

export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

const commandResultTypeSchema = z.string().regex(
  /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.(accepted|rejected)\.v1$/,
  "Invalid command result type"
);

const commandSuccessPayloadSchema = z.strictObject({
  entityRefs: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("project"), id: projectIdSchema }),
      z.strictObject({ kind: z.literal("change"), id: changeIdSchema }),
      z.strictObject({ kind: z.literal("task"), id: taskIdSchema }),
      z.strictObject({ kind: z.literal("run"), id: runIdSchema }),
      z.strictObject({ kind: z.literal("approval"), id: approvalIdSchema }),
      z.strictObject({ kind: z.literal("release"), id: releaseIdSchema }),
      z.strictObject({ kind: z.literal("observation"), id: observationIdSchema }),
      z.strictObject({ kind: z.literal("requirement"), id: requirementIdSchema }),
      z.strictObject({ kind: z.literal("oracle"), id: oracleIdSchema }),
      z.strictObject({ kind: z.literal("evidence"), id: evidenceIdSchema })
    ])
  )
});

const commandSuccessResultSchema = z.strictObject({
  schemaVersion: currentApiSchemaVersion,
  commandId: commandIdSchema,
  commandType: commandTypeSchema,
  status: z.literal("success"),
  resultType: commandResultTypeSchema,
  completedAt: utcTimestampSchema,
  eventRefs: z.array(eventIdSchema).min(1),
  result: commandSuccessPayloadSchema
});

const commandRejectionResultSchema = z.strictObject({
  schemaVersion: currentApiSchemaVersion,
  commandId: commandIdSchema,
  commandType: commandTypeSchema,
  status: z.literal("rejected"),
  resultType: commandResultTypeSchema,
  completedAt: utcTimestampSchema,
  rejection: protocolErrorSchema
});

export const commandResultSchema = z
  .discriminatedUnion("status", [commandSuccessResultSchema, commandRejectionResultSchema])
  .superRefine((result, context) => {
    const catalogEntry = COMMAND_CATALOG[result.commandType];

    if (!catalogEntry) {
      context.addIssue({
        code: "custom",
        message: `command type ${result.commandType} is not cataloged`,
        path: ["commandType"]
      });
      return;
    }

    const expected = catalogEntry.result;
    const expectedType = result.status === "success" ? expected.successType : expected.rejectionType;

    if (result.resultType !== expectedType) {
      context.addIssue({
        code: "custom",
        message: `resultType for ${result.commandType} must be ${expectedType}`,
        path: ["resultType"]
      });
    }

    if (result.status === "rejected" && !expected.rejectionCodes.includes(result.rejection.code)) {
      context.addIssue({
        code: "custom",
        message: `rejection code for ${result.commandType} is not cataloged`,
        path: ["rejection", "code"]
      });
    }
  });

export type CommandResult = z.infer<typeof commandResultSchema>;

const queryFilterSchema = z.strictObject({
  changeId: changeIdSchema.optional(),
  taskId: taskIdSchema.optional(),
  runId: runIdSchema.optional(),
  status: z.union([taskStatusSchema, z.enum(["open", "closed", "all"])]).optional()
});

export const queryRequestSchema = z.strictObject({
  schemaVersion: currentApiSchemaVersion,
  id: queryIdSchema,
  type: queryTypeSchema,
  version: z.literal(1),
  projectId: projectIdSchema,
  actor: actorSchema,
  issuedAt: utcTimestampSchema,
  cursor: paginationCursorSchema.optional(),
  limit: z.number().int().positive().max(200),
  filters: queryFilterSchema.optional()
});

export type QueryRequest = z.infer<typeof queryRequestSchema>;

const boardTaskProjectionSchema = z.strictObject({
  kind: z.literal("board-task"),
  taskId: taskIdSchema,
  changeId: changeIdSchema,
  contractId: contractIdSchema,
  status: taskStatusSchema,
  priority: z.number().int().min(0).max(1_000),
  generation: z.number().int().positive(),
  updatedAt: utcTimestampSchema
});

const changeDetailProjectionSchema = z.strictObject({
  kind: z.literal("change-detail"),
  changeId: changeIdSchema,
  requirementRefs: z.array(requirementIdSchema),
  decisionRefs: z.array(decisionIdSchema),
  oracleRefs: z.array(oracleIdSchema),
  riskTier: riskTierSchema
});

const releaseStatusProjectionSchema = z.strictObject({
  kind: z.literal("release-status"),
  releaseId: releaseIdSchema,
  environment: releaseEnvironmentSchema,
  status: z.enum(["requested", "staging", "deployed", "healthy", "failed", "rollback_required", "rolled_back", "forward_fix_required", "superseded"]),
  updatedAt: utcTimestampSchema
});

const queryItemSchema = z.union([
  boardTaskProjectionSchema,
  changeDetailProjectionSchema,
  eventEnvelopeSchema,
  releaseStatusProjectionSchema
]);

const paginationStateSchema = z.strictObject({
  nextCursor: paginationCursorSchema.optional(),
  hasMore: z.boolean()
});

export const queryResponseSchema = z.strictObject({
  schemaVersion: currentApiSchemaVersion,
  requestId: queryIdSchema,
  type: queryTypeSchema,
  generatedAt: utcTimestampSchema,
  items: z.array(queryItemSchema),
  pagination: paginationStateSchema
});

export type QueryResponse = z.infer<typeof queryResponseSchema>;

export const apiFixtureCorpusSchema = z.strictObject({
  commands: z.array(commandEnvelopeSchema).min(1),
  commandResults: z.array(commandResultSchema).min(1),
  queryRequests: z.array(queryRequestSchema).min(1),
  queryResponses: z.array(queryResponseSchema).min(1)
});

export type ApiFixtureCorpus = z.infer<typeof apiFixtureCorpusSchema>;

const commandCatalogRows = API_COMMAND_TYPES.map((type) => {
  const entry = COMMAND_CATALOG[type];
  return `| \`${entry.type}\` | ${entry.stateChanging ? "yes" : "no"} | \`${entry.result.successType}\` | \`${entry.result.rejectionType}\` | ${entry.summary} |`;
}).join("\n");

export const apiContractDocumentation = [
  "# Legion API Contracts",
  "",
  "The API contracts describe provider-neutral command and query envelopes for Legion workflow hosts. They do not encode HTTP methods, paths, status codes, sockets, runtime sessions, model providers, or storage provider details.",
  "",
  "## Commands",
  "",
  "Commands request workflow state transitions. Every state-changing command has a cataloged success result type and a cataloged typed rejection result. Command handlers should emit durable events only after accepting a command.",
  "",
  "| Command type | State-changing | Success result | Rejection result | Purpose |",
  "| --- | --- | --- | --- | --- |",
  commandCatalogRows,
  "",
  "## Queries",
  "",
  "Queries return typed projections with cursor pagination. The cursor is an opaque protocol value; transport adapters may map it to host-specific request syntax outside this package."
].join("\n");
