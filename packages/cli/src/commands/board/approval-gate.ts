/**
 * P11-T01 — `legion next board approval-gate` CLI adapter.
 *
 * Wires the approval-gate projector into the CLI's existing
 * board command tree. The CLI is the operator surface for
 * the per-(projectId, changeId) approval verdict: operators
 * inspect whether a change has been approved, rejected,
 * blocked, or is still pending on whole-change or
 * release-observation evidence.
 *
 * The CLI does NOT execute reviewer/approval workflows.
 * The approval verdict is purely a *projection* over the
 * existing Phase 9 whole-change + Phase 10 release-
 * observation board events. The CLI merely replays /
 * rebuilds / verifies the approval-gate projection state.
 *
 * Subcommands:
 *   status         Replay the approval-gate event log
 *                  through the pure reducer (no DB write).
 *   rebuild        Replay the event log and persist the
 *                  projection under
 *                  `approval-gate:<projectId>:<changeId>`.
 *   verify         Compare the persisted projection against
 *                  a fresh replay; fails closed on drift.
 *
 * All subcommands accept `--input <path>` with a JSON
 * object. All three subcommands require a `projectId` AND
 * a `changeId` field.
 */

import path from "node:path";
import { mkdir } from "node:fs/promises";

import { SqliteBoardStoreWithEventRepository } from "@legion/store-sqlite";
import type {
  ApprovalGateProjectionState,
  BoardProjectionRepository
} from "@legion/board";
import {
  SqliteApprovalGateProjector,
  type SqliteApprovalGateProjectorReplayResult
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

const APPROVAL_GATE_HELP = `legion next board approval-gate <action>

Actions:
  status    Replay the approval-gate projection without persisting.
  rebuild   Replay and persist the projection under approval-gate:<projectId>:<changeId>.
  verify    Verify the persisted projection matches a fresh replay (drift detection).

All actions accept --input <path> with a JSON object.
Status / rebuild / verify input shape:
  {
    "projectId": "proj-...",
    "changeId":  "chg-..."
  }
Global:
  --repository-root <path>  Repository root. Defaults to the current directory.
  --json                    Emit machine-readable JSON.
  --no-color                Disable ANSI styling.
  --help                    Show help.`;

interface ApprovalGateInputShape {
  readonly projectId?: unknown;
  readonly changeId?: unknown;
}

interface ApprovalGateSuccessPayload {
  readonly ok: true;
  readonly status: "replayed" | "rebuilt" | "verified";
  readonly projectId: string;
  readonly changeId: string;
  readonly projectionKey: string;
  readonly eventCount: number;
  readonly rebuiltThroughGlobalSequence: number;
  readonly state: ApprovalGateProjectionState | null;
  readonly stateHash: string;
  readonly projection: SqliteApprovalGateProjectorReplayResult;
}

interface ApprovalGateFailurePayload {
  readonly ok: false;
  readonly status: "failed";
  readonly code: string;
  readonly message: string;
}

type ApprovalGatePayload =
  | ApprovalGateSuccessPayload
  | ApprovalGateFailurePayload;

export async function handleApprovalGateCommand(
  context: CliContext
): Promise<CliResult> {
  const [action] = context.args.positionals;
  if (
    hasFlag(context, "help") ||
    action === undefined ||
    action === "help"
  ) {
    return helpResult(APPROVAL_GATE_HELP);
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
      return helpResult(APPROVAL_GATE_HELP);
  }
}

async function runStatus(context: CliContext): Promise<CliResult> {
  const parsed = await loadApprovalGateInput(context);
  if (isCliFailure(parsed)) return parsed;

  return withBoardStore(context, async ({ eventRepository, projectionRepository }) => {
    const projector = new SqliteApprovalGateProjector({
      projectId: parsed.projectId as never,
      changeId: parsed.changeId as never,
      eventRepository,
      projectionRepository
    });
    const report = projector.replay();
    const payload: ApprovalGateSuccessPayload = {
      ok: true,
      status: "replayed",
      projectId: parsed.projectId,
      changeId: parsed.changeId,
      projectionKey: projector.projectionKeyPublic,
      eventCount: report.eventCount,
      rebuiltThroughGlobalSequence: report.rebuiltThroughGlobalSequence,
      state: report.state,
      stateHash: report.stateHash,
      projection: report
    };
    const verdict = report.state?.verdict ?? "pending";
    return success(
      payload as unknown as Record<string, unknown>,
      `${parsed.changeId}: approval-gate replayed — verdict = ${verdict}.`
    );
  });
}

async function runRebuild(context: CliContext): Promise<CliResult> {
  const parsed = await loadApprovalGateInput(context);
  if (isCliFailure(parsed)) return parsed;

  return withBoardStore(context, async ({ eventRepository, projectionRepository }) => {
    const projector = new SqliteApprovalGateProjector({
      projectId: parsed.projectId as never,
      changeId: parsed.changeId as never,
      eventRepository,
      projectionRepository
    });
    const report = projector.rebuildAndSave();
    const payload: ApprovalGateSuccessPayload = {
      ok: true,
      status: "rebuilt",
      projectId: parsed.projectId,
      changeId: parsed.changeId,
      projectionKey: projector.projectionKeyPublic,
      eventCount: report.eventCount,
      rebuiltThroughGlobalSequence: report.rebuiltThroughGlobalSequence,
      state: report.state,
      stateHash: report.stateHash,
      projection: report
    };
    const verdict = report.state?.verdict ?? "pending";
    return success(
      payload as unknown as Record<string, unknown>,
      `${parsed.changeId}: approval-gate rebuilt — verdict = ${verdict}.`
    );
  });
}

async function runVerify(context: CliContext): Promise<CliResult> {
  const parsed = await loadApprovalGateInput(context);
  if (isCliFailure(parsed)) return parsed;

  return withBoardStore(context, async ({ eventRepository, projectionRepository }) => {
    try {
      const projector = new SqliteApprovalGateProjector({
        projectId: parsed.projectId as never,
        changeId: parsed.changeId as never,
        eventRepository,
        projectionRepository
      });
      const report = projector.verify();
      const payload: ApprovalGateSuccessPayload = {
        ok: true,
        status: "verified",
        projectId: parsed.projectId,
        changeId: parsed.changeId,
        projectionKey: projector.projectionKeyPublic,
        eventCount: report.eventCount,
        rebuiltThroughGlobalSequence: report.rebuiltThroughGlobalSequence,
        state: report.state,
        stateHash: report.stateHash,
        projection: report
      };
      const verdict = report.state?.verdict ?? "pending";
      return success(
        payload as unknown as Record<string, unknown>,
        `${parsed.changeId}: approval-gate verified — verdict = ${verdict}.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const payload: ApprovalGateFailurePayload = {
        ok: false,
        status: "failed",
        code: "verify_failed",
        message
      };
      return failureResult(payload, `approval-gate verify failed: ${message}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

interface ParsedApprovalGateInput {
  readonly projectId: string;
  readonly changeId: string;
}

async function loadApprovalGateInput(
  context: CliContext
): Promise<ParsedApprovalGateInput | CliResult> {
  const inputPath = requiredStringOption(context, "input");
  if (typeof inputPath !== "string") return inputPath;
  const input = (await readJsonInput(inputPath)) as Record<string, unknown>;
  return parseApprovalGateInput(input);
}

function parseApprovalGateInput(
  input: Record<string, unknown>
): ParsedApprovalGateInput | CliResult {
  const shape = input as ApprovalGateInputShape;
  if (typeof shape.projectId !== "string" || shape.projectId.length === 0) {
    return usageError("Missing or invalid projectId (expected non-empty string).");
  }
  if (typeof shape.changeId !== "string" || shape.changeId.length === 0) {
    return usageError("Missing or invalid changeId (expected non-empty string).");
  }
  return { projectId: shape.projectId, changeId: shape.changeId };
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

function failureResult(
  payload: ApprovalGateFailurePayload,
  human: string
): CliResult {
  return {
    exitCode: 1,
    payload: payload as unknown as Record<string, unknown>,
    human
  } as CliResult;
}