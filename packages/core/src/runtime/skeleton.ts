/**
 * ADR-004 Runtime Driver — abstract base skeleton.
 *
 * Purpose:
 *  - Declare the full provider-neutral method surface mandated by
 *    ADR-004 so that any concrete implementation (runtime-local,
 *    runtime-eve, runtime-legacy-cli, the FakeRuntimeDriver used in
 *    tests, etc.) is forced to satisfy the contract shape.
 *  - Provide a safe base behaviour: every method throws a
 *    `NotImplementedError` carrying the driver id and the method
 *    name, so an unfinished driver fails loudly and is never
 *    mistaken for a working one.
 *
 * The signatures below are copied verbatim from `./contract.ts`.
 * Subclasses MUST override every method. The skeleton itself is
 * `abstract`; it cannot be instantiated directly.
 *
 * Methods are declared `async` so that the `throw` becomes a
 * rejected Promise rather than a synchronous throw. This is what
 * `assert.rejects` and `await`-style callers expect; without it
 * the rejection bubbles out as a sync error and bypasses promise
 * middleware.
 */

import type { RunId } from "@legion/protocol";

import type {
  RuntimeApprovalOutcome,
  RuntimeApprovalRef,
  RuntimeArtifactHandle,
  RuntimeArtifactRef,
  RuntimeCancelReason,
  RuntimeCancelResult,
  RuntimeCheckpointRef,
  RuntimeDriver,
  RuntimeDriverId,
  RuntimeInspection,
  RuntimeResumeResult,
  RuntimeStartRequest,
  RuntimeStartResult,
  RuntimeStreamEvent
} from "./contract.js";

/**
 * Thrown by the skeleton when a concrete driver fails to override a
 * method. Callers can pattern-match on `code === "not_implemented"`
 * to distinguish scaffolding gaps from real driver failures.
 *
 * TypeScript has no built-in `NotImplementedError`, so the core
 * defines one. It is a deliberate sentinel, not a generic `Error`.
 */
export class NotImplementedError extends Error {
  readonly code = "not_implemented" as const;
  readonly driverId: RuntimeDriverId;
  readonly method: string;

  constructor(driverId: RuntimeDriverId, method: string) {
    super(
      `RuntimeDriver ${driverId.driver}@${driverId.version} does not implement ${method}() — required by ADR-004`
    );
    this.name = "NotImplementedError";
    this.driverId = driverId;
    this.method = method;
  }
}

/**
 * Abstract ADR-004 base. Every method throws `NotImplementedError`
 * unless the concrete subclass overrides it. Subclasses receive the
 * declared `driverId` via the constructor so error messages are
 * always attributable to the right runtime.
 */
export abstract class RuntimeDriverSkeleton implements RuntimeDriver {
  readonly driverId: RuntimeDriverId;

  protected constructor(driverId: RuntimeDriverId) {
    this.driverId = driverId;
  }

  /**
   * Create one version-pinned execution attempt for an approved
   * task contract. The driver must return a deterministic run id
   * and a frozen manifest that downstream state machines can rely
   * on.
   */
  async start(_request: RuntimeStartRequest): Promise<RuntimeStartResult> {
    throw new NotImplementedError(this.driverId, "start");
  }

  /**
   * Continue a paused or interrupted run after reconciling board
   * state and idempotency records. The checkpoint reference is
   * provider-neutral; the driver must translate it to whatever its
   * provider supports.
   */
  async resume(_runId: RunId, _checkpointRef: RuntimeCheckpointRef): Promise<RuntimeResumeResult> {
    throw new NotImplementedError(this.driverId, "resume");
  }

  /**
   * Request termination and record the result without deleting
   * run history. The reason is preserved as a driver-neutral
   * protocol error so the board can emit a `run.finished.v1` event.
   */
  async cancel(_runId: RunId, _reason: RuntimeCancelReason): Promise<RuntimeCancelResult> {
    throw new NotImplementedError(this.driverId, "cancel");
  }

  /**
   * Return provider-neutral status, checkpoint, sandbox, and
   * artifact references for the run. Inspect is a read-only query
   * and MUST NOT mutate driver state.
   */
  async inspect(_runId: RunId): Promise<RuntimeInspection> {
    throw new NotImplementedError(this.driverId, "inspect");
  }

  /**
   * Emit provider-neutral run events for progress, tool calls,
   * approvals, artifacts, and terminal state. The driver owns
   * ordering and at-least-once delivery to the consumer; the
   * consumer owns persistence into the event store.
   *
   * The skeleton throws on the first iterator pull so an unfinished
   * driver fails loudly when a caller tries to consume its stream.
   * Declared `async *` so the throw is reported via the iterator's
   * rejected next() promise (consumers see the rejection through
   * `for await ... of`), not as a synchronous throw at call time.
   */
  async *stream(_runId: RunId): AsyncIterableIterator<RuntimeStreamEvent> {
    throw new NotImplementedError(this.driverId, "stream");
  }

  /**
   * Deliver a durable human authorization to a paused run when
   * policy permits. The driver translates the approval into a
   * provider-native resume signal but returns a provider-neutral
   * outcome.
   */
  async approve(_approvalRef: RuntimeApprovalRef): Promise<RuntimeApprovalOutcome> {
    throw new NotImplementedError(this.driverId, "approve");
  }

  /**
   * Fetch or register provider-neutral artifact metadata. The
   * driver must not interpret the bytes; it only resolves
   * references to and from provider storage.
   */
  async artifact(_runId: RunId, _artifactRef: RuntimeArtifactRef): Promise<RuntimeArtifactHandle> {
    throw new NotImplementedError(this.driverId, "artifact");
  }
}

/**
 * Convenience type union naming the seven ADR-004 methods. Useful
 * when building exhaustiveness checks on the method surface.
 */
export type SkeletonMethodName =
  | "start"
  | "resume"
  | "cancel"
  | "inspect"
  | "stream"
  | "approve"
  | "artifact";
