import { LEGION_PROTOCOL_VERSION } from "@legion/protocol";

export const LEGION_CORE_VERSION = "0.1.0" as const;
export const SUPPORTED_PROTOCOL_VERSION = LEGION_PROTOCOL_VERSION;

export * from "./transition.js";
export * from "./state-machines/index.js";
export * from "./gates/index.js";
export * from "./risk/index.js";
