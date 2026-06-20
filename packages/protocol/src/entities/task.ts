import * as z from "zod";

import { blockerSchema } from "../primitives/common.js";
import { changeIdSchema, contractIdSchema, projectIdSchema, taskIdSchema } from "../primitives/ids.js";
import { utcTimestampSchema } from "../primitives/values.js";
import { schemaMetadataSchema } from "./common.js";

export const taskStatusSchema = z.enum([
  "queued",
  "ready",
  "claimed",
  "running",
  "blocked",
  "completed",
  "failed",
  "canceled",
  "superseded"
]);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSchema = schemaMetadataSchema.extend({
  kind: z.literal("task"),
  id: taskIdSchema,
  projectId: projectIdSchema,
  changeId: changeIdSchema,
  contractId: contractIdSchema,
  contractRevision: z.number().int().positive(),
  status: taskStatusSchema,
  generation: z.number().int().positive(),
  priority: z.number().int().min(0).max(1_000),
  dependencies: z.array(taskIdSchema),
  blockers: z.array(blockerSchema),
  updatedAt: utcTimestampSchema
});

export type Task = z.infer<typeof taskSchema>;
