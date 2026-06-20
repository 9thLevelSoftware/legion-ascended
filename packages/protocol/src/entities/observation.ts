import * as z from "zod";

import {
  changeIdSchema,
  evidenceIdSchema,
  projectIdSchema,
  releaseIdSchema,
  observationIdSchema,
  taskIdSchema
} from "../primitives/ids.js";
import { utcTimestampSchema } from "../primitives/values.js";
import { releaseEnvironmentSchema } from "./release.js";
import { schemaMetadataSchema } from "./common.js";

export const observationStatusSchema = z.enum([
  "pending",
  "observing",
  "healthy",
  "degraded",
  "failed",
  "rolled_back",
  "forward_fix_required",
  "unknown"
]);

export type ObservationStatus = z.infer<typeof observationStatusSchema>;

export const observationSignalSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9._-]{1,127}$/, "Invalid observation signal name"),
  status: z.enum(["pass", "fail", "warn", "unknown", "not_verified"]),
  observedAt: utcTimestampSchema,
  evidenceRefs: z.array(evidenceIdSchema)
});

export type ObservationSignal = z.infer<typeof observationSignalSchema>;

const observationBaseSchema = schemaMetadataSchema.extend({
  kind: z.literal("observation"),
  id: observationIdSchema,
  projectId: projectIdSchema,
  changeId: changeIdSchema,
  releaseId: releaseIdSchema,
  environment: releaseEnvironmentSchema,
  deploymentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/, "Invalid deployment ID").optional(),
  startedAt: utcTimestampSchema,
  endedAt: utcTimestampSchema.optional(),
  healthCriteria: z.array(z.string().min(1).max(1_024)),
  signals: z.array(observationSignalSchema),
  evidenceRefs: z.array(evidenceIdSchema)
});

const observationOpenLoopFields = {
  rollbackEvidenceRefs: z.array(evidenceIdSchema).optional(),
  forwardFixRefs: z.array(taskIdSchema).optional()
};

export const observationSchema = z
  .discriminatedUnion("status", [
    observationBaseSchema.extend({
      status: z.literal("pending"),
      ...observationOpenLoopFields
    }),
    observationBaseSchema.extend({
      status: z.literal("observing"),
      ...observationOpenLoopFields
    }),
    observationBaseSchema.extend({
      status: z.literal("healthy"),
      ...observationOpenLoopFields
    }),
    observationBaseSchema.extend({
      status: z.literal("degraded"),
      ...observationOpenLoopFields
    }),
    observationBaseSchema.extend({
      status: z.literal("failed"),
      ...observationOpenLoopFields
    }),
    observationBaseSchema.extend({
      status: z.literal("rolled_back"),
      rollbackEvidenceRefs: z.array(evidenceIdSchema).min(1),
      forwardFixRefs: z.array(taskIdSchema).optional()
    }),
    observationBaseSchema.extend({
      status: z.literal("forward_fix_required"),
      rollbackEvidenceRefs: z.array(evidenceIdSchema).optional(),
      forwardFixRefs: z.array(taskIdSchema).min(1)
    }),
    observationBaseSchema.extend({
      status: z.literal("unknown"),
      ...observationOpenLoopFields
    })
  ])
  .superRefine((observation, context) => {
    if (observation.endedAt && new Date(observation.endedAt).getTime() < new Date(observation.startedAt).getTime()) {
      context.addIssue({
        code: "custom",
        message: "endedAt cannot be before startedAt.",
        path: ["endedAt"]
      });
    }
  });

export type Observation = z.infer<typeof observationSchema>;
