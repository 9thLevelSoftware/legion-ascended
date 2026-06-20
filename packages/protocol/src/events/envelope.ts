import * as z from "zod";

import { actorSchema, blockerSchema, protocolErrorSchema } from "../primitives/common.js";
import {
  approvalIdSchema,
  changeIdSchema,
  contractIdSchema,
  decisionIdSchema,
  evidenceIdSchema,
  observationIdSchema,
  oracleIdSchema,
  projectIdSchema,
  releaseIdSchema,
  requirementIdSchema,
  reviewIdSchema,
  runIdSchema,
  taskIdSchema,
  eventIdSchema
} from "../primitives/ids.js";
import {
  artifactReferenceSchema,
  contentHashSchema,
  correlationIdSchema,
  idempotencyKeySchema,
  metadataSchema,
  schemaVersionSchema,
  utcTimestampSchema
} from "../primitives/values.js";
import { approvalScopeSchema } from "../entities/approval.js";
import { artifactRoleSchema, riskTierSchema } from "../entities/common.js";
import { evidenceVerdictSchema } from "../entities/evidence.js";
import { observationStatusSchema } from "../entities/observation.js";
import { releaseEnvironmentSchema } from "../entities/release.js";
import { reviewVerdictSchema } from "../entities/review.js";

export const EVENT_TYPES = [
  "project.created.v1",
  "change.proposed.v1",
  "artifact_revision.recorded.v1",
  "task.created.v1",
  "task.linked.v1",
  "task.claimed.v1",
  "task.heartbeat_recorded.v1",
  "task.blocked.v1",
  "task.retry_scheduled.v1",
  "task.completed.v1",
  "task.invalidated.v1",
  "run.created.v1",
  "run.started.v1",
  "run.finished.v1",
  "input.recorded.v1",
  "approval.requested.v1",
  "approval.granted.v1",
  "approval.denied.v1",
  "evidence.collected.v1",
  "review.submitted.v1",
  "integration.outbox_intent_recorded.v1",
  "integration.effect_succeeded.v1",
  "integration.effect_failed.v1",
  "release.requested.v1",
  "release.deployed.v1",
  "release.rolled_back.v1",
  "observation.recorded.v1",
  "migration.applied.v1"
] as const;

export const eventTypeSchema = z.enum(EVENT_TYPES);

export type EventType = z.infer<typeof eventTypeSchema>;

const currentEventSchemaVersion = z.literal("0.1.0");
const effectClassSchema = z.enum(["S0", "S1", "S2", "S3", "S4"]);
const effectKindSchema = z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/, "Invalid effect kind");
const migrationIdSchema = z.string().regex(/^[a-z][a-z0-9._-]{1,127}$/, "Invalid migration ID");

export const eventAggregateReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("project"), id: projectIdSchema }),
  z.strictObject({ kind: z.literal("change"), id: changeIdSchema }),
  z.strictObject({ kind: z.literal("requirement"), id: requirementIdSchema }),
  z.strictObject({ kind: z.literal("decision"), id: decisionIdSchema }),
  z.strictObject({ kind: z.literal("oracle"), id: oracleIdSchema }),
  z.strictObject({ kind: z.literal("contract"), id: contractIdSchema }),
  z.strictObject({ kind: z.literal("task"), id: taskIdSchema }),
  z.strictObject({ kind: z.literal("run"), id: runIdSchema }),
  z.strictObject({ kind: z.literal("evidence"), id: evidenceIdSchema }),
  z.strictObject({ kind: z.literal("review"), id: reviewIdSchema }),
  z.strictObject({ kind: z.literal("approval"), id: approvalIdSchema }),
  z.strictObject({ kind: z.literal("release"), id: releaseIdSchema }),
  z.strictObject({ kind: z.literal("observation"), id: observationIdSchema })
]);

export type EventAggregateReference = z.infer<typeof eventAggregateReferenceSchema>;
export type EventAggregateKind = EventAggregateReference["kind"];

const textSummarySchema = z.string().min(1).max(2_048);
const relationSchema = z.enum(["depends_on", "blocks", "supersedes", "relates_to"]);

const projectCreatedPayloadSchema = z.strictObject({
  projectId: projectIdSchema,
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/, "Invalid project slug"),
  name: z.string().min(1).max(128)
});

const changeProposedPayloadSchema = z.strictObject({
  changeId: changeIdSchema,
  title: z.string().min(1).max(160),
  summary: textSummarySchema,
  riskTier: riskTierSchema
});

const artifactRevisionRecordedPayloadSchema = z.strictObject({
  changeId: changeIdSchema,
  role: artifactRoleSchema,
  artifact: artifactReferenceSchema,
  revision: z.number().int().positive()
});

const taskCreatedPayloadSchema = z.strictObject({
  taskId: taskIdSchema,
  contractId: contractIdSchema,
  contractRevision: z.number().int().positive(),
  priority: z.number().int().min(0).max(1_000)
});

const taskLinkedPayloadSchema = z.strictObject({
  taskId: taskIdSchema,
  linkedTaskId: taskIdSchema,
  relation: relationSchema
});

const taskClaimedPayloadSchema = z.strictObject({
  taskId: taskIdSchema,
  runId: runIdSchema,
  claimedBy: actorSchema
});

const taskHeartbeatPayloadSchema = z.strictObject({
  taskId: taskIdSchema,
  runId: runIdSchema,
  status: z.enum(["started", "running", "waiting"]),
  observedAt: utcTimestampSchema
});

const taskBlockedPayloadSchema = z.strictObject({
  taskId: taskIdSchema,
  blocker: blockerSchema
});

const taskRetryScheduledPayloadSchema = z.strictObject({
  taskId: taskIdSchema,
  runId: runIdSchema,
  attempt: z.number().int().positive(),
  reason: textSummarySchema,
  notBefore: utcTimestampSchema.optional()
});

const taskCompletedPayloadSchema = z.strictObject({
  taskId: taskIdSchema,
  runId: runIdSchema,
  evidenceRefs: z.array(evidenceIdSchema).min(1)
});

const taskInvalidatedPayloadSchema = z.strictObject({
  taskId: taskIdSchema,
  reason: textSummarySchema,
  supersededBy: taskIdSchema.optional()
});

const runCreatedPayloadSchema = z.strictObject({
  runId: runIdSchema,
  taskId: taskIdSchema,
  contractId: contractIdSchema,
  attempt: z.number().int().positive()
});

const runStartedPayloadSchema = z.strictObject({
  runId: runIdSchema,
  taskId: taskIdSchema,
  startedAt: utcTimestampSchema
});

const runFinishedPayloadSchema = z.strictObject({
  runId: runIdSchema,
  taskId: taskIdSchema,
  status: z.enum(["succeeded", "failed", "blocked", "canceled"]),
  finishedAt: utcTimestampSchema,
  evidenceRefs: z.array(evidenceIdSchema).optional(),
  error: protocolErrorSchema.optional()
});

const inputRecordedPayloadSchema = z.strictObject({
  target: eventAggregateReferenceSchema,
  inputKind: z.enum(["human-message", "file", "approval-response", "runtime-signal"]),
  artifact: artifactReferenceSchema.optional()
});

const approvalRequestedPayloadSchema = z.strictObject({
  approvalId: approvalIdSchema,
  requestedBy: actorSchema,
  scope: approvalScopeSchema
});

const approvalGrantedPayloadSchema = z.strictObject({
  approvalId: approvalIdSchema,
  decidedBy: actorSchema,
  reason: textSummarySchema
});

const approvalDeniedPayloadSchema = z.strictObject({
  approvalId: approvalIdSchema,
  decidedBy: actorSchema,
  reason: textSummarySchema
});

const evidenceCollectedPayloadSchema = z.strictObject({
  evidenceId: evidenceIdSchema,
  taskId: taskIdSchema.optional(),
  runId: runIdSchema.optional(),
  verdict: evidenceVerdictSchema
});

const reviewSubmittedPayloadSchema = z.strictObject({
  reviewId: reviewIdSchema,
  taskId: taskIdSchema.optional(),
  reviewer: actorSchema,
  verdict: reviewVerdictSchema
});

const integrationOutboxIntentRecordedPayloadSchema = z.strictObject({
  effectKind: effectKindSchema,
  effectClass: effectClassSchema,
  targetHash: contentHashSchema
});

const integrationEffectSucceededPayloadSchema = z.strictObject({
  effectKind: effectKindSchema,
  targetHash: contentHashSchema,
  artifact: artifactReferenceSchema.optional()
});

const integrationEffectFailedPayloadSchema = z.strictObject({
  effectKind: effectKindSchema,
  targetHash: contentHashSchema,
  error: protocolErrorSchema
});

const releaseRequestedPayloadSchema = z.strictObject({
  releaseId: releaseIdSchema,
  environment: releaseEnvironmentSchema
});

const releaseDeployedPayloadSchema = z.strictObject({
  releaseId: releaseIdSchema,
  environment: releaseEnvironmentSchema,
  deploymentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/, "Invalid deployment ID")
});

const releaseRolledBackPayloadSchema = z.strictObject({
  releaseId: releaseIdSchema,
  evidenceRefs: z.array(evidenceIdSchema).min(1)
});

const observationRecordedPayloadSchema = z.strictObject({
  observationId: observationIdSchema,
  releaseId: releaseIdSchema.optional(),
  status: observationStatusSchema
});

const migrationAppliedPayloadSchema = z.strictObject({
  migrationId: migrationIdSchema,
  fromVersion: schemaVersionSchema,
  toVersion: schemaVersionSchema
});

const eventPayloadSchema = z.union([
  projectCreatedPayloadSchema,
  changeProposedPayloadSchema,
  artifactRevisionRecordedPayloadSchema,
  taskCreatedPayloadSchema,
  taskLinkedPayloadSchema,
  taskClaimedPayloadSchema,
  taskHeartbeatPayloadSchema,
  taskBlockedPayloadSchema,
  taskRetryScheduledPayloadSchema,
  taskCompletedPayloadSchema,
  taskInvalidatedPayloadSchema,
  runCreatedPayloadSchema,
  runStartedPayloadSchema,
  runFinishedPayloadSchema,
  inputRecordedPayloadSchema,
  approvalRequestedPayloadSchema,
  approvalGrantedPayloadSchema,
  approvalDeniedPayloadSchema,
  evidenceCollectedPayloadSchema,
  reviewSubmittedPayloadSchema,
  integrationOutboxIntentRecordedPayloadSchema,
  integrationEffectSucceededPayloadSchema,
  integrationEffectFailedPayloadSchema,
  releaseRequestedPayloadSchema,
  releaseDeployedPayloadSchema,
  releaseRolledBackPayloadSchema,
  observationRecordedPayloadSchema,
  migrationAppliedPayloadSchema
]);

const eventPayloadSchemas: Record<EventType, z.ZodType> = {
  "project.created.v1": projectCreatedPayloadSchema,
  "change.proposed.v1": changeProposedPayloadSchema,
  "artifact_revision.recorded.v1": artifactRevisionRecordedPayloadSchema,
  "task.created.v1": taskCreatedPayloadSchema,
  "task.linked.v1": taskLinkedPayloadSchema,
  "task.claimed.v1": taskClaimedPayloadSchema,
  "task.heartbeat_recorded.v1": taskHeartbeatPayloadSchema,
  "task.blocked.v1": taskBlockedPayloadSchema,
  "task.retry_scheduled.v1": taskRetryScheduledPayloadSchema,
  "task.completed.v1": taskCompletedPayloadSchema,
  "task.invalidated.v1": taskInvalidatedPayloadSchema,
  "run.created.v1": runCreatedPayloadSchema,
  "run.started.v1": runStartedPayloadSchema,
  "run.finished.v1": runFinishedPayloadSchema,
  "input.recorded.v1": inputRecordedPayloadSchema,
  "approval.requested.v1": approvalRequestedPayloadSchema,
  "approval.granted.v1": approvalGrantedPayloadSchema,
  "approval.denied.v1": approvalDeniedPayloadSchema,
  "evidence.collected.v1": evidenceCollectedPayloadSchema,
  "review.submitted.v1": reviewSubmittedPayloadSchema,
  "integration.outbox_intent_recorded.v1": integrationOutboxIntentRecordedPayloadSchema,
  "integration.effect_succeeded.v1": integrationEffectSucceededPayloadSchema,
  "integration.effect_failed.v1": integrationEffectFailedPayloadSchema,
  "release.requested.v1": releaseRequestedPayloadSchema,
  "release.deployed.v1": releaseDeployedPayloadSchema,
  "release.rolled_back.v1": releaseRolledBackPayloadSchema,
  "observation.recorded.v1": observationRecordedPayloadSchema,
  "migration.applied.v1": migrationAppliedPayloadSchema
};

const eventAggregateKinds: Record<EventType, EventAggregateKind> = {
  "project.created.v1": "project",
  "change.proposed.v1": "change",
  "artifact_revision.recorded.v1": "change",
  "task.created.v1": "task",
  "task.linked.v1": "task",
  "task.claimed.v1": "task",
  "task.heartbeat_recorded.v1": "task",
  "task.blocked.v1": "task",
  "task.retry_scheduled.v1": "task",
  "task.completed.v1": "task",
  "task.invalidated.v1": "task",
  "run.created.v1": "run",
  "run.started.v1": "run",
  "run.finished.v1": "run",
  "input.recorded.v1": "run",
  "approval.requested.v1": "approval",
  "approval.granted.v1": "approval",
  "approval.denied.v1": "approval",
  "evidence.collected.v1": "evidence",
  "review.submitted.v1": "review",
  "integration.outbox_intent_recorded.v1": "run",
  "integration.effect_succeeded.v1": "run",
  "integration.effect_failed.v1": "run",
  "release.requested.v1": "release",
  "release.deployed.v1": "release",
  "release.rolled_back.v1": "release",
  "observation.recorded.v1": "observation",
  "migration.applied.v1": "project"
};

export interface EventCatalogEntry {
  readonly type: EventType;
  readonly aggregateKind: EventAggregateKind;
  readonly summary: string;
}

export const EVENT_CATALOG: readonly EventCatalogEntry[] = [
  { type: "project.created.v1", aggregateKind: "project", summary: "Project workflow root was created." },
  { type: "change.proposed.v1", aggregateKind: "change", summary: "Change intent was proposed." },
  { type: "artifact_revision.recorded.v1", aggregateKind: "change", summary: "Versioned artifact revision was recorded." },
  { type: "task.created.v1", aggregateKind: "task", summary: "Task was created from a contract revision." },
  { type: "task.linked.v1", aggregateKind: "task", summary: "Task relationship was recorded." },
  { type: "task.claimed.v1", aggregateKind: "task", summary: "Task claim was recorded with its run." },
  { type: "task.heartbeat_recorded.v1", aggregateKind: "task", summary: "Task run heartbeat fact was recorded." },
  { type: "task.blocked.v1", aggregateKind: "task", summary: "Task blocker was recorded." },
  { type: "task.retry_scheduled.v1", aggregateKind: "task", summary: "Retry schedule was recorded." },
  { type: "task.completed.v1", aggregateKind: "task", summary: "Task completion fact was recorded." },
  { type: "task.invalidated.v1", aggregateKind: "task", summary: "Task invalidation fact was recorded." },
  { type: "run.created.v1", aggregateKind: "run", summary: "Run attempt was created." },
  { type: "run.started.v1", aggregateKind: "run", summary: "Run attempt start was recorded." },
  { type: "run.finished.v1", aggregateKind: "run", summary: "Run terminal state was recorded." },
  { type: "input.recorded.v1", aggregateKind: "run", summary: "External input fact was recorded." },
  { type: "approval.requested.v1", aggregateKind: "approval", summary: "Approval request was recorded." },
  { type: "approval.granted.v1", aggregateKind: "approval", summary: "Approval grant was recorded." },
  { type: "approval.denied.v1", aggregateKind: "approval", summary: "Approval denial was recorded." },
  { type: "evidence.collected.v1", aggregateKind: "evidence", summary: "Evidence collection fact was recorded." },
  { type: "review.submitted.v1", aggregateKind: "review", summary: "Review submission fact was recorded." },
  { type: "integration.outbox_intent_recorded.v1", aggregateKind: "run", summary: "Outbox side-effect intent was recorded." },
  { type: "integration.effect_succeeded.v1", aggregateKind: "run", summary: "Side effect success was recorded." },
  { type: "integration.effect_failed.v1", aggregateKind: "run", summary: "Side effect failure was recorded." },
  { type: "release.requested.v1", aggregateKind: "release", summary: "Release request was recorded." },
  { type: "release.deployed.v1", aggregateKind: "release", summary: "Release deployment was recorded." },
  { type: "release.rolled_back.v1", aggregateKind: "release", summary: "Release rollback was recorded." },
  { type: "observation.recorded.v1", aggregateKind: "observation", summary: "Post-release observation was recorded." },
  { type: "migration.applied.v1", aggregateKind: "project", summary: "Protocol migration application was recorded." }
] as const;

export const eventEnvelopeSchema = z
  .strictObject({
    schemaVersion: currentEventSchemaVersion,
    id: eventIdSchema,
    type: eventTypeSchema,
    version: z.literal(1),
    projectId: projectIdSchema,
    changeId: changeIdSchema.optional(),
    aggregate: eventAggregateReferenceSchema,
    generation: z.number().int().positive(),
    sequence: z.number().int().nonnegative(),
    correlationId: correlationIdSchema.optional(),
    causationId: eventIdSchema.optional(),
    actor: actorSchema,
    occurredAt: utcTimestampSchema,
    payload: eventPayloadSchema,
    idempotencyKey: idempotencyKeySchema.optional(),
    metadata: metadataSchema.optional()
  })
  .superRefine((event, context) => {
    const schema = eventPayloadSchemas[event.type];

    if (!schema) {
      context.addIssue({
        code: "custom",
        message: `event type ${event.type} is not cataloged`,
        path: ["type"]
      });
      return;
    }

    const payloadResult = schema.safeParse(event.payload);
    if (!payloadResult.success) {
      context.addIssue({
        code: "custom",
        message: `payload does not match event type ${event.type}`,
        path: ["payload"]
      });
    }

    const expectedAggregateKind = eventAggregateKinds[event.type];
    if (!expectedAggregateKind) {
      context.addIssue({
        code: "custom",
        message: `event type ${event.type} has no aggregate mapping`,
        path: ["type"]
      });
      return;
    }

    if (event.aggregate.kind !== expectedAggregateKind) {
      context.addIssue({
        code: "custom",
        message: `aggregate kind for ${event.type} must be ${expectedAggregateKind}`,
        path: ["aggregate", "kind"]
      });
    }
  });

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export const eventFixtureCorpusSchema = z.strictObject({
  events: z.array(eventEnvelopeSchema).min(1)
});

export type EventFixtureCorpus = z.infer<typeof eventFixtureCorpusSchema>;

export const eventCompatibilityFixtureSchema = z.strictObject({
  schemaVersion: z.literal("0.0.1"),
  eventId: eventIdSchema,
  eventType: eventTypeSchema,
  projectId: projectIdSchema,
  changeId: changeIdSchema.optional(),
  aggregate: eventAggregateReferenceSchema,
  generation: z.number().int().positive(),
  sequence: z.number().int().nonnegative(),
  correlationId: correlationIdSchema.optional(),
  causationId: eventIdSchema.optional(),
  actor: actorSchema,
  timestamp: utcTimestampSchema,
  payload: eventPayloadSchema,
  idempotencyKey: idempotencyKeySchema.optional()
});

export type EventCompatibilityFixture = z.infer<typeof eventCompatibilityFixtureSchema>;

export function isDuplicateEventEnvelope(left: EventEnvelope, right: EventEnvelope): boolean {
  if (left.id === right.id) return true;
  return Boolean(left.idempotencyKey && right.idempotencyKey && left.idempotencyKey === right.idempotencyKey);
}

export function assertEventHandlerCoverage(coveredTypes: Iterable<EventType>): void {
  const covered = new Set(coveredTypes);
  const missing = EVENT_TYPES.filter((type) => !covered.has(type));

  if (missing.length > 0) {
    throw new Error(`Missing event handler coverage for: ${missing.join(", ")}`);
  }

  const unknown = [...covered].filter((type) => !EVENT_TYPES.includes(type));
  if (unknown.length > 0) {
    throw new Error(`Unknown event handler coverage for: ${unknown.join(", ")}`);
  }
}

export function normalizeEventEnvelope(input: unknown): EventEnvelope {
  const current = eventEnvelopeSchema.safeParse(input);
  if (current.success) return current.data;

  const legacy = eventCompatibilityFixtureSchema.parse(input);
  return eventEnvelopeSchema.parse({
    schemaVersion: "0.1.0",
    id: legacy.eventId,
    type: legacy.eventType,
    version: 1,
    projectId: legacy.projectId,
    changeId: legacy.changeId,
    aggregate: legacy.aggregate,
    generation: legacy.generation,
    sequence: legacy.sequence,
    correlationId: legacy.correlationId,
    causationId: legacy.causationId,
    actor: legacy.actor,
    occurredAt: legacy.timestamp,
    payload: legacy.payload,
    idempotencyKey: legacy.idempotencyKey
  });
}

const eventCatalogRows = EVENT_CATALOG.map(
  (entry) => `| \`${entry.type}\` | \`${entry.aggregateKind}\` | ${entry.summary} |`
).join("\n");

export const eventContractDocumentation = [
  "# Legion Event Contracts",
  "",
  "Events are immutable facts. They describe what happened in the workflow control plane and do not carry transport details, runtime provider handles, or imperative execution instructions.",
  "",
  "## Ordering",
  "",
  "Consumers order events within an aggregate by `generation` and then `sequence`. `generation` advances when an aggregate is rebuilt or invalidated. `sequence` is append-only inside that generation. `correlationId` groups one user-visible operation, while `causationId` points to the prior event that caused a follow-on fact.",
  "",
  "## Duplicate Handling",
  "",
  "Delivery is at-least-once. Consumers must recognize duplicates by `id`; side-effect related facts also carry `idempotencyKey` so dispatchers can collapse logically repeated effects. Replay must rebuild projections only and must not spawn workers, call models, create commits, post comments, deploy, or repeat effects.",
  "",
  "## Catalog",
  "",
  "| Event type | Aggregate | Fact |",
  "| --- | --- | --- |",
  eventCatalogRows
].join("\n");
