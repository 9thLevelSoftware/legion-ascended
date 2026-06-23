/**
 * P10-T02 — `legion dev board release-observation` CLI adapter.
 *
 * Wires the P10-T01 release-observation board adapter into the
 * CLI's existing board command tree. The CLI is the operator
 * surface for release-observation reports: operators inspect
 * release-observation BoardEvents, build a frozen
 * `ReleaseObservationReport` into a board event via the
 * aggregator, replay/verify the projection state through
 * `SqliteReleaseObservationProjector`, and rebuild the
 * projection when needed.
 *
 * The CLI does NOT spawn runtime drivers, canary probes, or
 * health-check subprocesses — those are injected through
 * provider-neutral runners in `@legion/core`. The CLI merely
 * routes the typed report (typically supplied by an out-of-band
 * monitor or a dry-run replay) into the board's append-only
 * event log and projection store.
 *
 * Subcommands:
 *   aggregate         Build a frozen BoardEvent from a JSON
 *                     ReleaseObservationReport and append it
 *                     to the event log. Re-runs are idempotent
 *                     by `<changeId>:<mergeQueueHash>:<reportSha256>:<eventType>`.
 *   status            Replay the release-observation event log
 *                     through the pure reducer (no DB write).
 *   rebuild           Replay the event log and persist the
 *                     projection under
 *                     `release-observation:<changeId>:<mergeQueueHash>`.
 *   verify            Compare the persisted projection against
 *                     a fresh replay; fails closed on drift.
 *
 * All subcommands accept `--input <path>` with a JSON object.
 * Status / rebuild / verify require a `(changeId, mergeQueueHash)`
 * pair in the input.
 */

import path from "node:path";
import { mkdir } from "node:fs/promises";

import { SqliteBoardStoreWithEventRepository } from "@legion/store-sqlite";
import type {
  AppendBoardEventInput,
  BoardProjectionRepository
} from "@legion/board-store";
import {
  ReleaseObservationBoardAggregator,
  type ReleaseObservationBoardAggregatorInput,
  type ReleaseObservationBoardAggregatorSuccess,
  type ReleaseObservationBoardIssue
} from "@legion/board";
import {
  SqliteReleaseObservationProjector,
  type SqliteReleaseObservationProjectorReplayResult
} from "@legion/store-sqlite";

import {
  hasFlag,
  helpResult,
  readJsonInput,
  requiredStringOption,
  stripCommand,
  success,
  usageError,
  type CliContext,
  type CliResult
} from "../../runtime.js";

const RELEASE_OBSERVATION_HELP = `legion dev board release-observation <action>

Actions:
  aggregate    Build a BoardEvent from a ReleaseObservationReport JSON and append to the event log.
  status       Replay the release-observation projection without persisting.
  rebuild      Replay and persist the projection under release-observation:<changeId>:<mergeQueueHash>.
  verify       Verify the persisted projection matches a fresh replay (drift detection).

All actions accept --input <path> with a JSON object.
Aggregate input shape:
  {
    "changeId":      "chg_...",
    "report":        { ...ReleaseObservationReport... },
    "reporter":      "ci-bot"          (optional),
    "correlationId": "corr-123"        (optional)
  }
Status / rebuild / verify input shape:
  {
    "changeId":       "chg_...",
    "mergeQueueHash": "sha256:..."
  }
Global:
  --repository-root <path>  Repository root. Defaults to the current directory.
  --json                    Emit machine-readable JSON.
  --no-color                Disable ANSI styling.
  --help                    Show help.`;

interface ReleaseObservationAggregateInputShape {
  readonly changeId?: unknown;
  readonly report?: unknown;
  readonly reporter?: unknown;
  readonly correlationId?: unknown;
}

interface ReleaseObservationProjectionInputShape {
  readonly changeId?: unknown;
  readonly mergeQueueHash?: unknown;
}

interface ReleaseObservationSuccessPayload {
  readonly ok: true;
  readonly status: "appended" | "replayed" | "rebuilt" | "verified";
  readonly changeId: string;
  readonly mergeQueueHash: string;
  readonly reportSha256: string;
  readonly lastEventType: string;
  readonly idempotencyKey: string;
  readonly observedAt: string;
  readonly eventIds: readonly string[];
  readonly state: unknown;
  readonly projection: SqliteReleaseObservationProjectorReplayResult;
}

interface ReleaseObservationFailurePayload {
  readonly ok: false;
  readonly status: "failed";
  readonly code: string;
  readonly issues: readonly ReleaseObservationBoardIssue[];
  readonly message: string;
}

type ReleaseObservationPayload =
  | ReleaseObservationSuccessPayload
  | ReleaseObservationFailurePayload;

/**
 * Dispatch helper — runs `aggregate`, `status`, `rebuild`, or
 * `verify` against the SQLite-backed board store. Mirrors the
 * `withTaskRepository` / `withEventRepository` helpers in
 * `board/index.ts`.
 */
export async function handleReleaseObservationCommand(
  context: CliContext
): Promise<CliResult> {
  const [action] = context.args.positionals;
  if (
    hasFlag(context, "help") ||
    action === undefined ||
    action === "help"
  ) {
    return helpResult(RELEASE_OBSERVATION_HELP);
  }

  const commandContext = stripCommand(context, 1);
  switch (action) {
    case "aggregate":
      return runAggregate(commandContext);
    case "status":
      return runStatus(commandContext);
    case "rebuild":
      return runRebuild(commandContext);
    case "verify":
      return runVerify(commandContext);
    default:
      return helpResult(RELEASE_OBSERVATION_HELP);
  }
}

async function runAggregate(context: CliContext): Promise<CliResult> {
  const input = await loadReleaseObservationInput(context);
  if (isCliFailure(input)) return input;

  const parsed = parseAggregateInput(input);
  if (isCliFailure(parsed)) return parsed;

  return withBoardStore(context, async ({ eventRepository, projectionRepository }) => {
    const aggregator = new ReleaseObservationBoardAggregator();
    const result = aggregator.aggregate(parsed.aggregatorInput);

    if (!result.ok) {
      const payload: ReleaseObservationFailurePayload = {
        ok: false,
        status: "failed",
        code: "aggregate_failed",
        issues: result.issues,
        message: "release-observation aggregator rejected the report"
      };
      return failureResult(payload, summarizeIssues(result.issues));
    }

    const successResult = result as ReleaseObservationBoardAggregatorSuccess;
    // The aggregator emits frozen BoardEvent envelopes with a
    // typed payload. The SQLite event repository append API
    // takes the simpler `AppendBoardEventInput` shape, so we
    // project the aggregator output into that contract.
    const appendInputs: AppendBoardEventInput[] = successResult.events.map(
      (event) => ({
        aggregateKind: event.aggregateKind,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        eventVersion: event.eventVersion,
        payload: event.payload as Readonly<Record<string, unknown>>,
        causationId: event.causationId ?? null,
        correlationId: event.correlationId ?? null,
        idempotencyKey: event.idempotencyKey ?? null,
        occurredAt: event.occurredAt
      })
    );

    const appendOutcome = eventRepository.appendEvents({ events: appendInputs });
    const storedEvents = appendOutcome.events;
    if (storedEvents.length === 0) {
      const payload: ReleaseObservationFailurePayload = {
        ok: false,
        status: "failed",
        code: "append_returned_no_event",
        issues: [],
        message: "event repository returned no events after append"
      };
      return failureResult(payload, payload.message);
    }

    // After append, replay the projection so operators see the
    // freshly-persisted state alongside the append result.
    const replay = replayOnly(
      successResult.changeId,
      successResult.mergeQueueHash,
      eventRepository,
      projectionRepository
    );

    const payload: ReleaseObservationSuccessPayload = {
      ok: true,
      status: "appended",
      changeId: successResult.changeId,
      mergeQueueHash: successResult.mergeQueueHash,
      reportSha256: successResult.reportSha256,
      lastEventType: successResult.lastEventType,
      idempotencyKey: successResult.idempotencyKey,
      observedAt: successResult.observedAt,
      eventIds: storedEvents.map((event) => event.eventId),
      state: successResult.state,
      projection: replay
    };
    return successResult_(
      payload,
      `${payload.changeId}: release-observation ${payload.lastEventType} appended (event ${storedEvents[0]!.eventId}).`
    );
  });
}

async function runStatus(context: CliContext): Promise<CliResult> {
  const input = await loadReleaseObservationInput(context);
  if (isCliFailure(input)) return input;
  const parsed = parseProjectionInput(input);
  if (isCliFailure(parsed)) return parsed;

  return withBoardStore(context, async ({ eventRepository, projectionRepository }) => {
    const report = replayOnly(
      parsed.changeId,
      parsed.mergeQueueHash,
      eventRepository,
      projectionRepository
    );
    const status = report.state === null ? "absent" : report.state.lastEventType;
    const payload: ReleaseObservationSuccessPayload = {
      ok: true,
      status: "replayed",
      changeId: parsed.changeId,
      mergeQueueHash: parsed.mergeQueueHash,
      reportSha256: report.state?.reportSha256 ?? EMPTY_SHA256,
      lastEventType: report.state?.lastEventType ?? "release.observed",
      idempotencyKey:
        report.state === null
          ? `${parsed.changeId}:${parsed.mergeQueueHash}:no-state:no-state`
          : `${parsed.changeId}:${parsed.mergeQueueHash}:${report.state.reportSha256}:${report.state.lastEventType}`,
      observedAt: report.state?.lastObservedAt ?? "1970-01-01T00:00:00.000Z",
      eventIds: [],
      state: report.state,
      projection: report
    };
    return successResult_(
      payload,
      `${parsed.changeId}: release-observation status = ${status}.`
    );
  });
}

async function runRebuild(context: CliContext): Promise<CliResult> {
  const input = await loadReleaseObservationInput(context);
  if (isCliFailure(input)) return input;
  const parsed = parseProjectionInput(input);
  if (isCliFailure(parsed)) return parsed;

  return withBoardStore(context, async ({ eventRepository, projectionRepository }) => {
    const projector = new SqliteReleaseObservationProjector({
      changeId: parsed.changeId as never,
      mergeQueueHash: parsed.mergeQueueHash,
      eventRepository,
      projectionRepository
    });
    const report = projector.rebuildAndSave();
    const payload: ReleaseObservationSuccessPayload = {
      ok: true,
      status: "rebuilt",
      changeId: parsed.changeId,
      mergeQueueHash: parsed.mergeQueueHash,
      reportSha256: report.state?.reportSha256 ?? EMPTY_SHA256,
      lastEventType: report.state?.lastEventType ?? "release.observed",
      idempotencyKey:
        report.state === null
          ? `${parsed.changeId}:${parsed.mergeQueueHash}:no-state:no-state`
          : `${parsed.changeId}:${parsed.mergeQueueHash}:${report.state.reportSha256}:${report.state.lastEventType}`,
      observedAt: report.state?.lastObservedAt ?? "1970-01-01T00:00:00.000Z",
      eventIds: [],
      state: report.state,
      projection: report
    };
    return successResult_(
      payload,
      `${parsed.changeId}: release-observation projection rebuilt through globalSequence ${report.rebuiltThroughGlobalSequence}.`
    );
  });
}

async function runVerify(context: CliContext): Promise<CliResult> {
  const input = await loadReleaseObservationInput(context);
  if (isCliFailure(input)) return input;
  const parsed = parseProjectionInput(input);
  if (isCliFailure(parsed)) return parsed;

  return withBoardStore(context, async ({ eventRepository, projectionRepository }) => {
    try {
      const projector = new SqliteReleaseObservationProjector({
        changeId: parsed.changeId as never,
        mergeQueueHash: parsed.mergeQueueHash,
        eventRepository,
        projectionRepository
      });
      const report = projector.verify();
      const payload: ReleaseObservationSuccessPayload = {
        ok: true,
        status: "verified",
        changeId: parsed.changeId,
        mergeQueueHash: parsed.mergeQueueHash,
        reportSha256: report.state?.reportSha256 ?? EMPTY_SHA256,
        lastEventType: report.state?.lastEventType ?? "release.observed",
        idempotencyKey:
          report.state === null
            ? `${parsed.changeId}:${parsed.mergeQueueHash}:no-state:no-state`
            : `${parsed.changeId}:${parsed.mergeQueueHash}:${report.state.reportSha256}:${report.state.lastEventType}`,
        observedAt: report.state?.lastObservedAt ?? "1970-01-01T00:00:00.000Z",
        eventIds: [],
        state: report.state,
        projection: report
      };
      return successResult_(
        payload,
        `${parsed.changeId}: release-observation projection verified at sequence ${report.rebuiltThroughGlobalSequence}.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const payload: ReleaseObservationFailurePayload = {
        ok: false,
        status: "failed",
        code: "verify_failed",
        issues: [],
        message
      };
      return failureResult(payload, `release-observation verify failed: ${message}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMPTY_SHA256 = "sha256:" + "0".repeat(64);

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

async function loadReleaseObservationInput(
  context: CliContext
): Promise<Record<string, unknown> | CliResult> {
  const inputPath = requiredStringOption(context, "input");
  if (typeof inputPath !== "string") return inputPath;
  return readJsonInput(inputPath);
}

function parseAggregateInput(
  input: Record<string, unknown>
): { readonly aggregatorInput: ReleaseObservationBoardAggregatorInput } | CliResult {
  const shape = input as ReleaseObservationAggregateInputShape;
  if (typeof shape.changeId !== "string" || shape.changeId.length === 0) {
    return usageError("Missing or invalid changeId (expected non-empty string).");
  }
  if (!shape.report || typeof shape.report !== "object") {
    return usageError(
      "Missing or invalid report (expected a ReleaseObservationReport object)."
    );
  }
  const aggregatorInput: ReleaseObservationBoardAggregatorInput = {
    changeId: shape.changeId as unknown as ReleaseObservationBoardAggregatorInput["changeId"],
    report: shape.report as unknown as ReleaseObservationBoardAggregatorInput["report"],
    ...(typeof shape.reporter === "string" && shape.reporter.length > 0
      ? { reporter: shape.reporter }
      : {}),
    ...(typeof shape.correlationId === "string" && shape.correlationId.length > 0
      ? { correlationId: shape.correlationId }
      : {})
  };
  return { aggregatorInput };
}

function parseProjectionInput(
  input: Record<string, unknown>
): { readonly changeId: string; readonly mergeQueueHash: string } | CliResult {
  const shape = input as ReleaseObservationProjectionInputShape;
  if (typeof shape.changeId !== "string" || shape.changeId.length === 0) {
    return usageError("Missing or invalid changeId (expected non-empty string).");
  }
  if (
    typeof shape.mergeQueueHash !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(shape.mergeQueueHash)
  ) {
    return usageError(
      "Missing or invalid mergeQueueHash (expected sha256:<64-hex-digits>)."
    );
  }
  return { changeId: shape.changeId, mergeQueueHash: shape.mergeQueueHash };
}

// ---------------------------------------------------------------------------
// Store + projector helpers
// ---------------------------------------------------------------------------

interface BoardStoreWithProjection {
  readonly eventRepository: SqliteBoardStoreWithEventRepository["eventRepository"];
  readonly projectionRepository: BoardProjectionRepository;
}

async function withBoardStore(
  context: CliContext,
  callback: (handle: BoardStoreWithProjection) => Promise<CliResult>
): Promise<CliResult> {
  await mkdir(path.dirname(boardDatabasePath(context)), { recursive: true });
  const store = SqliteBoardStoreWithEventRepository.open(boardStoreOptions(context));
  try {
    store.migrate();
    return await callback({
      eventRepository: store.eventRepository,
      projectionRepository: store.projectionRepository
    });
  } finally {
    store.close();
  }
}

function replayOnly(
  changeId: string,
  mergeQueueHash: string,
  eventRepository: SqliteBoardStoreWithEventRepository["eventRepository"],
  projectionRepository: BoardProjectionRepository
): SqliteReleaseObservationProjectorReplayResult {
  const projector = new SqliteReleaseObservationProjector({
    changeId: changeId as never,
    mergeQueueHash,
    eventRepository,
    projectionRepository
  });
  return projector.replay();
}

function boardStoreOptions(context: CliContext): {
  readonly databasePath: string;
  readonly busyTimeoutMs: number;
} {
  return {
    databasePath: boardDatabasePath(context),
    busyTimeoutMs: 7_500
  };
}

function boardDatabasePath(context: CliContext): string {
  return path.join(context.repositoryRoot, ".legion", "var", "board.sqlite");
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function isCliFailure(value: unknown): value is CliResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      "exitCode" in value &&
      "payload" in value &&
      (value as { exitCode: unknown }).exitCode !== 0
  );
}

function summarizeIssues(issues: readonly ReleaseObservationBoardIssue[]): string {
  if (issues.length === 0) return "release-observation aggregator failed";
  return issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ");
}

function successResult_(
  payload: ReleaseObservationSuccessPayload,
  human: string
): CliResult {
  return success(payload as unknown as Record<string, unknown>, human);
}

function failureResult(
  payload: ReleaseObservationFailurePayload,
  human: string
): CliResult {
  return {
    exitCode: 1,
    payload: payload as unknown as Record<string, unknown>,
    human
  };
}

// Re-export the public surface so unit tests can exercise the
// parsing + result helpers without going through the CLI.
export const __testing = {
  parseAggregateInput,
  parseProjectionInput,
  summarizeIssues,
  replayOnly,
  successResult_,
  failureResult
};
