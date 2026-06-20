export const LEGION_PROTOCOL_VERSION = "0.1.0" as const;

export type LegionProtocolVersion = typeof LEGION_PROTOCOL_VERSION;

export * from "./entities/approval.js";
export * from "./entities/change.js";
export * from "./entities/common.js";
export * from "./entities/decision.js";
export * from "./entities/evidence.js";
export * from "./entities/observation.js";
export * from "./entities/oracle.js";
export * from "./entities/project.js";
export * from "./entities/release.js";
export * from "./entities/requirement.js";
export * from "./entities/review.js";
export * from "./entities/schema-documents.js";
export * from "./entities/task-contract.js";
export * from "./entities/task-run.js";
export * from "./entities/task.js";
export * from "./primitives/common.js";
export * from "./primitives/ids.js";
export * from "./primitives/schema-documents.js";
export * from "./primitives/values.js";
