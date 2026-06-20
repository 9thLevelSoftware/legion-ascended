import * as z from "zod";

import { changeIdSchema, projectIdSchema, runIdSchema, taskIdSchema } from "./ids.js";

export const utcTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "Invalid canonical UTC timestamp")
  .refine((value) => new Date(value).toISOString() === value, "Invalid canonical UTC timestamp")
  .brand<"UtcTimestamp">()
  .describe("Canonical UTC timestamp formatted as YYYY-MM-DDTHH:mm:ss.SSSZ.");

export type UtcTimestamp = z.infer<typeof utcTimestampSchema>;

export const schemaVersionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Invalid semantic schema version")
  .brand<"SchemaVersion">()
  .describe("Major.minor.patch schema version without leading zeroes.");

export type SchemaVersion = z.infer<typeof schemaVersionSchema>;

export const contentHashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "Invalid SHA-256 content hash")
  .brand<"ContentHash">()
  .describe("Lowercase SHA-256 content hash with sha256: prefix.");

export type ContentHash = z.infer<typeof contentHashSchema>;

export const gitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "Invalid Git SHA")
  .brand<"GitSha">()
  .describe("Lowercase 40-character Git object SHA.");

export type GitSha = z.infer<typeof gitShaSchema>;

const artifactPathPattern =
  /^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*\/\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+=:,~-]+(?:\/[A-Za-z0-9._@+=:,~-]+)*$/;

export const artifactPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(artifactPathPattern, "Invalid artifact path")
  .brand<"ArtifactPath">()
  .describe("Relative POSIX artifact path inside an approved artifact root.");

export type ArtifactPath = z.infer<typeof artifactPathSchema>;

export const artifactReferenceSchema = z.strictObject({
  path: artifactPathSchema,
  sha256: contentHashSchema,
  mediaType: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/, "Invalid media type")
    .optional()
});

export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;

const effectKindSchema = z
  .string()
  .regex(/^[a-z][a-z0-9._-]{1,63}$/, "Invalid effect kind")
  .brand<"EffectKind">();

export const idempotencyKeySchema = z
  .string()
  .regex(
    /^prj_[a-z0-9][a-z0-9-]{1,62}[a-z0-9]:chg_[a-z0-9][a-z0-9-]{1,62}[a-z0-9]:tsk_[a-z0-9][a-z0-9-]{1,62}[a-z0-9]:run_[a-z0-9][a-z0-9-]{1,62}[a-z0-9]:[a-z][a-z0-9._-]{1,63}:sha256:[0-9a-f]{64}$/,
    "Invalid idempotency key"
  )
  .brand<"IdempotencyKey">()
  .describe("Stable logical operation key: project:change:task:run:effect-kind:target-hash.");

export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;

export const correlationIdSchema = z
  .string()
  .regex(/^cor_[0-9a-hjkmnp-tv-z]{26}$/, "Invalid correlation ID")
  .brand<"CorrelationId">();

export type CorrelationId = z.infer<typeof correlationIdSchema>;

export const paginationCursorSchema = z
  .string()
  .regex(/^cur_[A-Za-z0-9_-]{4,256}$/, "Invalid pagination cursor")
  .brand<"PaginationCursor">();

export type PaginationCursor = z.infer<typeof paginationCursorSchema>;

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export interface JsonValueSchemaOptions {
  readonly maxDepth?: number;
  readonly maxStringLength?: number;
  readonly maxArrayLength?: number;
  readonly maxObjectKeys?: number;
  readonly maxObjectKeyLength?: number;
}

export function createJsonValueSchema(options: JsonValueSchemaOptions = {}): z.ZodType<JsonValue> {
  const maxDepth = options.maxDepth ?? 4;
  const maxStringLength = options.maxStringLength ?? 2_048;
  const maxArrayLength = options.maxArrayLength ?? 64;
  const maxObjectKeys = options.maxObjectKeys ?? 64;
  const maxObjectKeyLength = options.maxObjectKeyLength ?? 128;

  const scalarSchema = z.union([
    z.string().max(maxStringLength),
    z.number().finite(),
    z.boolean(),
    z.null()
  ]);

  function atDepth(depthRemaining: number): z.ZodType<JsonValue> {
    if (depthRemaining <= 0) return scalarSchema;

    const childSchema = atDepth(depthRemaining - 1);
    const arraySchema = z.array(childSchema).max(maxArrayLength);
    const objectSchema = z
      .record(z.string().min(1).max(maxObjectKeyLength), childSchema)
      .superRefine((value, context) => {
        if (Object.keys(value).length > maxObjectKeys) {
          context.addIssue({
            code: "custom",
            message: `JSON object exceeds maximum key count ${maxObjectKeys}`
          });
        }
      });

    return z.union([scalarSchema, arraySchema, objectSchema]);
  }

  return atDepth(maxDepth);
}

export const jsonValueSchema = createJsonValueSchema();

const metadataKeySchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/, "Invalid metadata key");
const stringRecordSchema = z.record(metadataKeySchema, z.string().max(512));

export const metadataSchema = z.strictObject({
  labels: stringRecordSchema.optional(),
  annotations: stringRecordSchema.optional(),
  attributes: z.record(metadataKeySchema, jsonValueSchema).optional()
});

export type Metadata = z.infer<typeof metadataSchema>;

export function buildIdempotencyKey(input: {
  readonly projectId: z.infer<typeof projectIdSchema>;
  readonly changeId: z.infer<typeof changeIdSchema>;
  readonly taskId: z.infer<typeof taskIdSchema>;
  readonly runId: z.infer<typeof runIdSchema>;
  readonly effectKind: string;
  readonly targetHash: z.infer<typeof contentHashSchema>;
}): IdempotencyKey {
  const projectId = projectIdSchema.parse(input.projectId);
  const changeId = changeIdSchema.parse(input.changeId);
  const taskId = taskIdSchema.parse(input.taskId);
  const runId = runIdSchema.parse(input.runId);
  const effectKind = effectKindSchema.parse(input.effectKind);
  const targetHash = contentHashSchema.parse(input.targetHash);

  return idempotencyKeySchema.parse(`${projectId}:${changeId}:${taskId}:${runId}:${effectKind}:${targetHash}`);
}
