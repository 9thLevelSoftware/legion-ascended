import * as z from "zod";

import { actorSchema, protocolErrorSchema } from "../primitives/common.js";
import {
  changeIdSchema,
  contractIdSchema,
  evidenceIdSchema,
  projectIdSchema,
  reviewIdSchema,
  runIdSchema,
  taskIdSchema
} from "../primitives/ids.js";
import {
  artifactPathSchema,
  contentHashSchema,
  gitShaSchema,
  idempotencyKeySchema,
  schemaVersionSchema,
  utcTimestampSchema
} from "../primitives/values.js";
import { riskTierSchema, schemaMetadataSchema } from "./common.js";

export const taskRunStatusSchema = z.enum([
  "created",
  "started",
  "succeeded",
  "failed",
  "blocked",
  "canceled",
  "superseded"
]);

export type TaskRunStatus = z.infer<typeof taskRunStatusSchema>;

export const runtimeManifestSchema = z.strictObject({
  driver: z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/, "Invalid runtime driver ID"),
  version: schemaVersionSchema
});

export type RuntimeManifest = z.infer<typeof runtimeManifestSchema>;

const workerBundleRoleSchema = z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/, "Invalid worker role ID");
const workerBundleDomainSchema = z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/, "Invalid worker domain ID");
const workerBundleCapabilitySchema = z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/, "Invalid worker capability ID");

export const workerBundlePromptContentContractSchema = z.strictObject({
  instructionsHash: contentHashSchema,
  requiredSections: z.array(z.string().min(1).max(128)).min(1),
  forbiddenSections: z.array(z.string().min(1).max(128))
});

export type WorkerBundlePromptContentContract = z.infer<typeof workerBundlePromptContentContractSchema>;

export const workerBundleManifestSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/, "Invalid worker bundle ID"),
  version: schemaVersionSchema,
  role: workerBundleRoleSchema,
  domain: workerBundleDomainSchema,
  capabilities: z.array(workerBundleCapabilitySchema).min(1),
  promptContentContract: workerBundlePromptContentContractSchema
});

export type WorkerBundleManifest = z.infer<typeof workerBundleManifestSchema>;
export type WorkerBundle = WorkerBundleManifest;

export const modelManifestSchema = z.strictObject({
  provider: z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/, "Invalid model provider ID"),
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "Invalid model ID"),
  policyVersion: schemaVersionSchema
});

export type ModelManifest = z.infer<typeof modelManifestSchema>;

export const taskRunInputManifestSchema = z.strictObject({
  contractHash: contentHashSchema,
  currentSpecsHash: contentHashSchema,
  deltaSpecsHash: contentHashSchema,
  oracleHash: contentHashSchema
});

export type TaskRunInputManifest = z.infer<typeof taskRunInputManifestSchema>;

export const repositoryManifestSchema = z.strictObject({
  baseCommit: gitShaSchema,
  branch: z.string().regex(/^[A-Za-z0-9._\/-]{1,128}$/, "Invalid branch name").optional()
});

export type RepositoryManifest = z.infer<typeof repositoryManifestSchema>;

export const workspaceManifestSchema = z.strictObject({
  sandboxDriver: z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/, "Invalid sandbox driver ID"),
  worktreePath: artifactPathSchema
});

export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>;

export const taskRunPolicyManifestSchema = z.strictObject({
  version: schemaVersionSchema,
  riskTier: riskTierSchema
});

export type TaskRunPolicyManifest = z.infer<typeof taskRunPolicyManifestSchema>;

export const taskRunManifestSchema = z.strictObject({
  runtime: runtimeManifestSchema,
  workerBundle: workerBundleManifestSchema,
  model: modelManifestSchema,
  inputs: taskRunInputManifestSchema,
  repository: repositoryManifestSchema,
  workspace: workspaceManifestSchema,
  policy: taskRunPolicyManifestSchema,
  idempotencyKey: idempotencyKeySchema,
  frozenAt: utcTimestampSchema.optional()
});

export type TaskRunManifest = z.infer<typeof taskRunManifestSchema>;

export const frozenTaskRunManifestSchema = taskRunManifestSchema.extend({
  frozenAt: utcTimestampSchema
});

export type FrozenTaskRunManifest = z.infer<typeof frozenTaskRunManifestSchema>;

const taskRunBaseSchema = schemaMetadataSchema.extend({
  kind: z.literal("task-run"),
  id: runIdSchema,
  projectId: projectIdSchema,
  changeId: changeIdSchema,
  taskId: taskIdSchema,
  contractId: contractIdSchema,
  contractRevision: z.number().int().positive(),
  attempt: z.number().int().positive(),
  claimedBy: actorSchema.optional(),
  evidenceRefs: z.array(evidenceIdSchema).optional(),
  reviewRefs: z.array(reviewIdSchema).optional(),
  error: protocolErrorSchema.optional()
});

export const taskRunSchema = z
  .discriminatedUnion("status", [
    taskRunBaseSchema.extend({
      status: z.literal("created"),
      startedAt: utcTimestampSchema.optional(),
      finishedAt: utcTimestampSchema.optional(),
      manifest: taskRunManifestSchema
    }),
    taskRunBaseSchema.extend({
      status: z.literal("started"),
      startedAt: utcTimestampSchema,
      finishedAt: utcTimestampSchema.optional(),
      manifest: frozenTaskRunManifestSchema
    }),
    taskRunBaseSchema.extend({
      status: z.literal("succeeded"),
      startedAt: utcTimestampSchema,
      finishedAt: utcTimestampSchema,
      manifest: frozenTaskRunManifestSchema
    }),
    taskRunBaseSchema.extend({
      status: z.literal("failed"),
      startedAt: utcTimestampSchema,
      finishedAt: utcTimestampSchema,
      manifest: frozenTaskRunManifestSchema
    }),
    taskRunBaseSchema.extend({
      status: z.literal("blocked"),
      startedAt: utcTimestampSchema,
      finishedAt: utcTimestampSchema,
      manifest: frozenTaskRunManifestSchema
    }),
    taskRunBaseSchema.extend({
      status: z.literal("canceled"),
      startedAt: utcTimestampSchema,
      finishedAt: utcTimestampSchema,
      manifest: frozenTaskRunManifestSchema
    }),
    taskRunBaseSchema.extend({
      status: z.literal("superseded"),
      startedAt: utcTimestampSchema,
      finishedAt: utcTimestampSchema,
      manifest: frozenTaskRunManifestSchema
    })
  ])
  .superRefine((taskRun, context) => {
    if (taskRun.startedAt && taskRun.finishedAt && new Date(taskRun.finishedAt).getTime() < new Date(taskRun.startedAt).getTime()) {
      context.addIssue({
        code: "custom",
        message: "finishedAt cannot be before startedAt.",
        path: ["finishedAt"]
      });
    }
  });

export type TaskRun = z.infer<typeof taskRunSchema>;
