/**
 * P11-T01 — `legion dev board dashboard` CLI adapter.
 *
 * Wires the dashboard projector into the CLI's existing
 * board command tree. The CLI is the operator surface for
 * the dashboard projection: operators inspect the
 * project-scoped task status counts, event timeline,
 * release-observation verdict pointers, and approval
 * verdict pointers.
 *
 * The CLI does NOT spawn runtime drivers or host probes —
 * those belong to the Phase 10 release-observation
 * orchestrator and the Phase 8 per-task review pipeline.
 * The CLI merely routes through the SQLite-backed projector
 * to replay / rebuild / verify the dashboard projection
 * state.
 *
 * Subcommands:
 *   status         Replay the dashboard event log through
 *                  the pure reducer (no DB write).
 *   rebuild        Replay the event log and persist the
 *                  projection under
 *                  `dashboard:<projectId>`.
 *   verify         Compare the persisted projection against
 *                  a fresh replay; fails closed on drift.
 *
 * All subcommands accept `--input <path>` with a JSON
 * object. All three subcommands require a `projectId`
 * field; the optional `tailLimit` (1..200) defaults to 25.
 */

import path from "node:path";
import { mkdir } from "node:fs/promises";

import { SqliteBoardStoreWithEventRepository } from "@legion/store-sqlite";
import type {
  BoardProjectionRepository,
  DashboardProjectionState
} from "@legion/board";
import {
  SqliteDashboardProjector,
  type SqliteDashboardProjectorReplayResult
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

const DASHBOARD_HELP = `legion dev board dashboard <action>

Actions:
  status    Replay the dashboard projection without persisting.
  rebuild   Replay and persist the projection under dashboard:<projectId>.
  verify    Verify the persisted projection matches a fresh replay (drift detection).

All actions accept --input <path> with a JSON object.
Status / rebuild / verify input shape:
  {
    "projectId": "proj-...",
    "tailLimit": 25               (optional, default 25, max 200)
  }
Global:
  --repository-root <path>  Repository root. Defaults to the current directory.
  --json                    Emit machine-readable JSON.
  --no-color                Disable ANSI styling.
  --help                    Show help.`;

interface DashboardInputShape {
  readonly projectId?: unknown;
  readonly tailLimit?: unknown;
}

interface DashboardSuccessPayload {
  readonly ok: true;
  readonly status: "replayed" | "rebuilt" | "verified";
  readonly projectId: string;
  readonly projectionKey: string;
  readonly tailLimit: number;
  readonly eventCount: number;
  readonly rebuiltThroughGlobalSequence: number;
  readonly state: DashboardProjectionState | null;
  readonly stateHash: string;
  readonly projection: SqliteDashboardProjectorReplayResult;
}

interface DashboardFailurePayload {
  readonly ok: false;
  readonly status: "failed";
  readonly code: string;
  readonly message: string;
}

type DashboardPayload = DashboardSuccessPayload | DashboardFailurePayload;

export async function handleDashboardCommand(
  context: CliContext
): Promise<CliResult> {
  const [action] = context.args.positionals;
  if (
    hasFlag(context, "help") ||
    action === undefined ||
    action === "help"
  ) {
    return helpResult(DASHBOARD_HELP);
  }

  const commandContext = stripCommand(context, 1);
  switch (action) {
    case "status":
      return runStatus(commandContext);
    case "rebuild":
      return runRebuild(commandContext);
    case "verify":
      return runVerify(commandContext);
    default:
      return helpResult(DASHBOARD_HELP);
  }
}

async function runStatus(context: CliContext): Promise<CliResult> {
  const parsed = await loadDashboardInput(context);
  if (isCliFailure(parsed)) return parsed;

  return withBoardStore(context, async ({ eventRepository, projectionRepository }) => {
    const projector = new SqliteDashboardProjector({
      projectId: parsed.projectId as never,
      eventRepository,
      projectionRepository,
      tailLimit: parsed.tailLimit
    });
    const report = projector.replay();
    const payload: DashboardSuccessPayload = {
      ok: true,
      status: "replayed",
      projectId: parsed.projectId,
      projectionKey: projector.projectionKeyPublic,
      tailLimit: parsed.tailLimit,
      eventCount: report.eventCount,
      rebuiltThroughGlobalSequence: report.rebuiltThroughGlobalSequence,
      state: report.state,
      stateHash: report.stateHash,
      projection: report
    };
    return success(
      payload as unknown as Record<string, unknown>,
      `${parsed.projectId}: dashboard replayed through global sequence ${report.rebuiltThroughGlobalSequence}.`
    );
  });
}

async function runRebuild(context: CliContext): Promise<CliResult> {
  const parsed = await loadDashboardInput(context);
  if (isCliFailure(parsed)) return parsed;

  return withBoardStore(context, async ({ eventRepository, projectionRepository }) => {
    const projector = new SqliteDashboardProjector({
      projectId: parsed.projectId as never,
      eventRepository,
      projectionRepository,
      tailLimit: parsed.tailLimit
    });
    const report = projector.rebuildAndSave();
    const payload: DashboardSuccessPayload = {
      ok: true,
      status: "rebuilt",
      projectId: parsed.projectId,
      projectionKey: projector.projectionKeyPublic,
      tailLimit: parsed.tailLimit,
      eventCount: report.eventCount,
      rebuiltThroughGlobalSequence: report.rebuiltThroughGlobalSequence,
      state: report.state,
      stateHash: report.stateHash,
      projection: report
    };
    return success(
      payload as unknown as Record<string, unknown>,
      `${parsed.projectId}: dashboard rebuilt through global sequence ${report.rebuiltThroughGlobalSequence}.`
    );
  });
}

async function runVerify(context: CliContext): Promise<CliResult> {
  const parsed = await loadDashboardInput(context);
  if (isCliFailure(parsed)) return parsed;

  return withBoardStore(context, async ({ eventRepository, projectionRepository }) => {
    try {
      const projector = new SqliteDashboardProjector({
        projectId: parsed.projectId as never,
        eventRepository,
        projectionRepository,
        tailLimit: parsed.tailLimit
      });
      const report = projector.verify();
      const payload: DashboardSuccessPayload = {
        ok: true,
        status: "verified",
        projectId: parsed.projectId,
        projectionKey: projector.projectionKeyPublic,
        tailLimit: parsed.tailLimit,
        eventCount: report.eventCount,
        rebuiltThroughGlobalSequence: report.rebuiltThroughGlobalSequence,
        state: report.state,
        stateHash: report.stateHash,
        projection: report
      };
      return success(
        payload as unknown as Record<string, unknown>,
        `${parsed.projectId}: dashboard verified through global sequence ${report.rebuiltThroughGlobalSequence}.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const payload: DashboardFailurePayload = {
        ok: false,
        status: "failed",
        code: "verify_failed",
        message
      };
      return failureResult(payload, `dashboard verify failed: ${message}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

interface ParsedDashboardInput {
  readonly projectId: string;
  readonly tailLimit: number;
}

async function loadDashboardInput(
  context: CliContext
): Promise<ParsedDashboardInput | CliResult> {
  const inputPath = requiredStringOption(context, "input");
  if (typeof inputPath !== "string") return inputPath;
  const input = (await readJsonInput(inputPath)) as Record<string, unknown>;
  return parseDashboardInput(input);
}

function parseDashboardInput(
  input: Record<string, unknown>
): ParsedDashboardInput | CliResult {
  const shape = input as DashboardInputShape;
  if (typeof shape.projectId !== "string" || shape.projectId.length === 0) {
    return usageError("Missing or invalid projectId (expected non-empty string).");
  }
  let tailLimit = 25;
  if (typeof shape.tailLimit === "number" && Number.isFinite(shape.tailLimit)) {
    tailLimit = Math.max(1, Math.min(200, Math.floor(shape.tailLimit)));
  }
  return { projectId: shape.projectId, tailLimit };
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

function failureResult(payload: DashboardFailurePayload, human: string): CliResult {
  return {
    exitCode: 1,
    payload: payload as unknown as Record<string, unknown>,
    human
  } as CliResult;
}
