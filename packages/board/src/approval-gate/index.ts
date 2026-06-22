/**
 * P11-T01 — Approval-gate projection barrel.
 *
 * Re-exports the approval-gate contract, reducer, and
 * descriptor so consumers (SQLite projector, CLI) can import
 * the full approval-gate surface from
 * `@legion/board/approval-gate`.
 */

export {
  APPROVAL_GATE_ADAPTER_KEYS,
  APPROVAL_GATE_ADAPTER_KIND,
  APPROVAL_GATE_ADAPTER_SCHEMA_VERSION,
  APPROVAL_GATE_PROJECTION_KEY_PREFIX,
  APPROVAL_GATE_PROJECTION_VERSION,
  APPROVAL_GATE_VERDICTS,
  approvalGateProjectionKey,
  isApprovalGateProjectionState,
  makeInitialApprovalGateState,
  parseApprovalGateProjectionKey
} from "./contract.js";

export {
  APPROVAL_GATE_REDUCER_KIND,
  APPROVAL_GATE_REDUCER_KIND_LITERAL,
  decideApprovalGateVerdict,
  makeApprovalGateReducer,
  reduceApprovalGate,
  replayApprovalGate
} from "./reducer.js";

export type {
  ApprovalGateAdapterKey,
  ApprovalGateAggregateId,
  ApprovalGateProjectionDescriptor,
  ApprovalGateProjectionState,
  ApprovalGateReducer,
  ApprovalGateVerdict,
  ChangeId,
  ProjectId
} from "./contract.js";