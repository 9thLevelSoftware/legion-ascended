export const LEGION_PROTOCOL_VERSION = "0.1.0" as const;

export type LegionProtocolVersion = typeof LEGION_PROTOCOL_VERSION;

export * from "./primitives/common.js";
export * from "./primitives/ids.js";
export * from "./primitives/schema-documents.js";
export * from "./primitives/values.js";
