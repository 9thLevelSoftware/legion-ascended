export type EventId = `evt_${string}`;
export type TaskId = string;
export type RunId = string;

export interface AppendEventInput {
  eventId: EventId;
  streamId: string;
  type: string;
  payload: unknown;
  idempotencyKey?: string;
}

export interface ClaimTaskInput {
  taskId: TaskId;
  workerId: string;
  leaseTtlMs: number;
  expectedContractRevision: string;
}

export interface ClaimedTask {
  taskId: TaskId;
  generation: number;
  leaseId: string;
  leaseExpiresAt: string;
}

export interface OutboxInput {
  idempotencyKey: string;
  effectClass: "S1" | "S2" | "S3" | "S4";
  target: string;
  payload: unknown;
  requiresApproval: boolean;
}

export interface LegionStore {
  appendEvent(input: AppendEventInput): Promise<void>;
  rebuildProjection(streamId?: string): Promise<void>;
  claimTask(input: ClaimTaskInput): Promise<ClaimedTask | null>;
  heartbeat(leaseId: string, leaseTtlMs: number): Promise<boolean>;
  releaseClaim(leaseId: string, result: "completed" | "blocked" | "failed"): Promise<void>;
  enqueueOutbox(input: OutboxInput): Promise<void>;
  markOutboxAttempt(idempotencyKey: string, result: "succeeded" | "failed", providerRef?: string): Promise<void>;
  backupTo(path: string): Promise<{ sha256: string }>;
  migrate(targetVersion: number): Promise<void>;
}
