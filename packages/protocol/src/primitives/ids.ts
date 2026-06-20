import * as z from "zod";

export const ENTITY_ID_KINDS = [
  "project",
  "change",
  "requirement",
  "decision",
  "oracle",
  "contract",
  "task",
  "run",
  "evidence",
  "review",
  "approval",
  "release",
  "observation",
  "event"
] as const;

export type EntityIdKind = (typeof ENTITY_ID_KINDS)[number];

export const ENTITY_ID_PREFIXES: Record<EntityIdKind, string> = {
  project: "prj",
  change: "chg",
  requirement: "req",
  decision: "dec",
  oracle: "orc",
  contract: "ctr",
  task: "tsk",
  run: "run",
  evidence: "evd",
  review: "rev",
  approval: "apv",
  release: "rel",
  observation: "obs",
  event: "evt"
} as const;

export const timeSortableIdSchema = z
  .string()
  .regex(/^[0-9a-hjkmnp-tv-z]{26}$/, "Invalid time-sortable ID")
  .describe("Lowercase Crockford-style 26-character time-sortable ID.");

const slugSuffixSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/, "Invalid entity ID suffix")
  .describe("Lowercase slug suffix used after an entity-kind prefix.");

function idSchema<const Brand extends string>(
  prefix: string,
  suffixPattern: RegExp,
  description: string
) {
  const suffixSource = suffixPattern.source.replace(/^\^/, "").replace(/\$$/, "");
  return z
    .string()
    .regex(new RegExp(`^${prefix}_${suffixSource}$`), `Invalid ${description}`)
    .brand<Brand>()
    .describe(description);
}

const slugSuffixPattern = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const timeSortableSuffixPattern = /^[0-9a-hjkmnp-tv-z]{26}$/;

export const projectIdSchema = idSchema<"ProjectId">("prj", slugSuffixPattern, "Project ID");
export const changeIdSchema = idSchema<"ChangeId">("chg", slugSuffixPattern, "Change ID");
export const requirementIdSchema = idSchema<"RequirementId">("req", slugSuffixPattern, "Requirement ID");
export const decisionIdSchema = idSchema<"DecisionId">("dec", slugSuffixPattern, "Decision ID");
export const oracleIdSchema = idSchema<"OracleId">("orc", slugSuffixPattern, "Oracle ID");
export const contractIdSchema = idSchema<"ContractId">("ctr", slugSuffixPattern, "Task contract ID");
export const taskIdSchema = idSchema<"TaskId">("tsk", slugSuffixPattern, "Task ID");
export const runIdSchema = idSchema<"RunId">("run", slugSuffixPattern, "Run ID");
export const evidenceIdSchema = idSchema<"EvidenceId">("evd", slugSuffixPattern, "Evidence ID");
export const reviewIdSchema = idSchema<"ReviewId">("rev", slugSuffixPattern, "Review ID");
export const approvalIdSchema = idSchema<"ApprovalId">("apv", slugSuffixPattern, "Approval ID");
export const releaseIdSchema = idSchema<"ReleaseId">("rel", slugSuffixPattern, "Release ID");
export const observationIdSchema = idSchema<"ObservationId">("obs", slugSuffixPattern, "Observation ID");
export const eventIdSchema = idSchema<"EventId">("evt", timeSortableSuffixPattern, "Event ID");

export type ProjectId = z.infer<typeof projectIdSchema>;
export type ChangeId = z.infer<typeof changeIdSchema>;
export type RequirementId = z.infer<typeof requirementIdSchema>;
export type DecisionId = z.infer<typeof decisionIdSchema>;
export type OracleId = z.infer<typeof oracleIdSchema>;
export type ContractId = z.infer<typeof contractIdSchema>;
export type TaskId = z.infer<typeof taskIdSchema>;
export type RunId = z.infer<typeof runIdSchema>;
export type EvidenceId = z.infer<typeof evidenceIdSchema>;
export type ReviewId = z.infer<typeof reviewIdSchema>;
export type ApprovalId = z.infer<typeof approvalIdSchema>;
export type ReleaseId = z.infer<typeof releaseIdSchema>;
export type ObservationId = z.infer<typeof observationIdSchema>;
export type EventId = z.infer<typeof eventIdSchema>;

export type EntityId =
  | ProjectId
  | ChangeId
  | RequirementId
  | DecisionId
  | OracleId
  | ContractId
  | TaskId
  | RunId
  | EvidenceId
  | ReviewId
  | ApprovalId
  | ReleaseId
  | ObservationId
  | EventId;

export const entityIdSchemas = {
  project: projectIdSchema,
  change: changeIdSchema,
  requirement: requirementIdSchema,
  decision: decisionIdSchema,
  oracle: oracleIdSchema,
  contract: contractIdSchema,
  task: taskIdSchema,
  run: runIdSchema,
  evidence: evidenceIdSchema,
  review: reviewIdSchema,
  approval: approvalIdSchema,
  release: releaseIdSchema,
  observation: observationIdSchema,
  event: eventIdSchema
} as const;

export const entityIdKindSchema = z.enum(ENTITY_ID_KINDS);

export const anyEntityIdSchema = z.union([
  projectIdSchema,
  changeIdSchema,
  requirementIdSchema,
  decisionIdSchema,
  oracleIdSchema,
  contractIdSchema,
  taskIdSchema,
  runIdSchema,
  evidenceIdSchema,
  reviewIdSchema,
  approvalIdSchema,
  releaseIdSchema,
  observationIdSchema,
  eventIdSchema
]);

export const entityReferenceSchema = z.strictObject({
  kind: entityIdKindSchema,
  id: anyEntityIdSchema
});

export type EntityReference = z.infer<typeof entityReferenceSchema>;

export function parseEntityId(kind: EntityIdKind, input: string): EntityId {
  return entityIdSchemas[kind].parse(input);
}

export function formatEntityId(kind: EntityIdKind, suffix: string): EntityId {
  const suffixValue = kind === "event" ? timeSortableIdSchema.parse(suffix) : slugSuffixSchema.parse(suffix);
  return parseEntityId(kind, `${ENTITY_ID_PREFIXES[kind]}_${suffixValue}`);
}
