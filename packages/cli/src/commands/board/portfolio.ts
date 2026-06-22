/**
 * P11-T02 — `legion next board portfolio` CLI adapter.
 *
 * Wires the portfolio projector into the CLI's existing
 * board command tree. The CLI is the operator surface for
 * the cross-project portfolio projection: operators inspect
 * the tenant-scoped per-project rollups, cross-project
 * dependency edges, and resource allocation ledger.
 *
 * The CLI does NOT spawn runtime drivers or host probes —
 * those belong to the Phase 10 release-observation
 * orchestrator and the Phase 8 per-task review pipeline.
 * The CLI merely routes through the SQLite-backed projector
 * to replay / rebuild / verify the portfolio projection
 * state.
 *
 * Subcommands:
 *   status         Replay the portfolio event log through
 *                  the pure reducer (no DB write).
 *   rebuild        Replay the event log and persist the
 *                  projection under
 *                  `portfolio:<tenantId>`.
 *   verify         Compare the persisted projection against
 *                  a fresh replay; fails closed on drift.
 *
 * All subcommands accept `--input <path>` with a JSON
 * object. All three subcommands require a `tenantId` field;
 * the optional `projectIds` list scopes the reducer to a
 * specific set of projects.
 */

import path from "node:path";
import { mkdir } from "node:fs/promises";

import { SqliteBoardStoreWithEventRepository } from "@legion/store-sqlite";
import type {
  BoardProjectionRepository,
  PortfolioProjectionState,
  ProjectId,
  TenantId
} from "@legion/board";
import {
  asTenantId,
  portfolioScopeFromList
} from "@legion/board";
import {
  SqlitePortfolioProjector,
  type SqlitePortfolioProjectorReplayResult
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

const PORTFOLIO_HELP = `legion next board portfolio <action>

Actions:
  status    Replay the portfolio projection without persisting.
  rebuild   Replay and persist the projection under portfolio:<tenantId>.
  verify    Verify the persisted projection matches a fresh replay (drift detection).

All actions accept --input <path> with a JSON object.
Status / rebuild / verify input shape:
  {
    "tenantId": "tnt-...",
    "projectIds": ["prj-...", ...]   (optional scope filter; tenant-wide when omitted)
  }
Global:
  --repository-root <path>  Repository root. Defaults to the current directory.
  --json                    Emit machine-readable JSON.
  --no-color                Disable ANSI styling.
  --help                    Show help.`;

interface PortfolioInputShape {
  readonly tenantId?: unknown;
  readonly projectIds?: unknown;
}

interface PortfolioSuccessPayload {
  readonly ok: true;
  readonly status: "replayed" | "rebuilt" | "verified";
  readonly tenantId: string;
  readonly projectionKey: string;
  readonly scope: readonly string[];
  readonly eventCount: number;
  readonly rebuiltThroughGlobalSequence: number;
  readonly state: PortfolioProjectionState | null;
  readonly stateHash: string;
  readonly projection: SqlitePortfolioProjectorReplayResult;
}

interface PortfolioFailurePayload {
  readonly ok: false;
  readonly status: "failed";
  readonly code: string;
  readonly message: string;
}

type PortfolioPayload = PortfolioSuccessPayload | PortfolioFailurePayload;

export async function handlePortfolioCommand(
  context: CliContext
): Promise<CliResult> {
  const [action] = context.args.positionals;
  if (
    hasFlag(context, "help") ||
    action === undefined ||
    action === "help"
  ) {
    return helpResult(PORTFOLIO_HELP);
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
      return helpResult(PORTFOLIO_HELP);
  }
}

async function runStatus(context: CliContext): Promise<CliResult> {
  const parsed = await loadPortfolioInput(context);
  if (isCliFailure(parsed)) return parsed;

  return withBoardStore(context, async ({ eventRepository, projectionRepository }) => {
    const projector = new SqlitePortfolioProjector({
      tenantId: parsed.tenantId,
      eventRepository,
      projectionRepository,
      scope: parsed.projectIds
    });
    const report = projector.replay();
    const payload: PortfolioSuccessPayload = {
      ok: true,
      status: "replayed",
      tenantId: parsed.tenantId,
      projectionKey: projector.projectionKeyPublic,
      scope: parsed.projectIds,
      eventCount: report.eventCount,
      rebuiltThroughGlobalSequence: report.rebuiltThroughGlobalSequence,
      state: report.state,
      stateHash: report.stateHash,
      projection: report
    };
    return success(
      payload as unknown as Record<string, unknown>,
      `${parsed.tenantId}: portfolio replayed through global sequence ${report.rebuiltThroughGlobalSequence}.`
    );
  });
}

async function runRebuild(context: CliContext): Promise<CliResult> {
  const parsed = await loadPortfolioInput(context);
  if (isCliFailure(parsed)) return parsed;

  return withBoardStore(context, async ({ eventRepository, projectionRepository }) => {
    const projector = new SqlitePortfolioProjector({
      tenantId: parsed.tenantId,
      eventRepository,
      projectionRepository,
      scope: parsed.projectIds
    });
    const report = projector.rebuildAndSave();
    const payload: PortfolioSuccessPayload = {
      ok: true,
      status: "rebuilt",
      tenantId: parsed.tenantId,
      projectionKey: projector.projectionKeyPublic,
      scope: parsed.projectIds,
      eventCount: report.eventCount,
      rebuiltThroughGlobalSequence: report.rebuiltThroughGlobalSequence,
      state: report.state,
      stateHash: report.stateHash,
      projection: report
    };
    return success(
      payload as unknown as Record<string, unknown>,
      `${parsed.tenantId}: portfolio rebuilt through global sequence ${report.rebuiltThroughGlobalSequence}.`
    );
  });
}

async function runVerify(context: CliContext): Promise<CliResult> {
  const parsed = await loadPortfolioInput(context);
  if (isCliFailure(parsed)) return parsed;

  return withBoardStore(context, async ({ eventRepository, projectionRepository }) => {
    try {
      const projector = new SqlitePortfolioProjector({
        tenantId: parsed.tenantId,
        eventRepository,
        projectionRepository,
        scope: parsed.projectIds
      });
      const report = projector.verify();
      const payload: PortfolioSuccessPayload = {
        ok: true,
        status: "verified",
        tenantId: parsed.tenantId,
        projectionKey: projector.projectionKeyPublic,
        scope: parsed.projectIds,
        eventCount: report.eventCount,
        rebuiltThroughGlobalSequence: report.rebuiltThroughGlobalSequence,
        state: report.state,
        stateHash: report.stateHash,
        projection: report
      };
      return success(
        payload as unknown as Record<string, unknown>,
        `${parsed.tenantId}: portfolio verified through global sequence ${report.rebuiltThroughGlobalSequence}.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const payload: PortfolioFailurePayload = {
        ok: false,
        status: "failed",
        code: "verify_failed",
        message
      };
      return failureResult(payload, `portfolio verify failed: ${message}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

interface ParsedPortfolioInput {
  readonly tenantId: TenantId;
  readonly projectIds: readonly ProjectId[];
}

async function loadPortfolioInput(
  context: CliContext
): Promise<ParsedPortfolioInput | CliResult> {
  const inputPath = requiredStringOption(context, "input");
  if (typeof inputPath !== "string") return inputPath;
  const input = (await readJsonInput(inputPath)) as Record<string, unknown>;
  return parsePortfolioInput(input);
}

function parsePortfolioInput(
  input: Record<string, unknown>
): ParsedPortfolioInput | CliResult {
  const shape = input as PortfolioInputShape;
  if (typeof shape.tenantId !== "string" || shape.tenantId.length === 0) {
    return usageError("Missing or invalid tenantId (expected non-empty string).");
  }
  let tenantId: TenantId;
  try {
    tenantId = asTenantId(shape.tenantId);
  } catch {
    return usageError("Missing or invalid tenantId (expected non-empty string).");
  }
  const projectIds: ProjectId[] = [];
  if (Array.isArray(shape.projectIds)) {
    for (const value of shape.projectIds) {
      if (typeof value !== "string" || value.length === 0) {
        return usageError(
          "Invalid projectIds entry (expected non-empty string)."
        );
      }
      projectIds.push(value as ProjectId);
    }
  }
  // Drop scope nulls (mirrors portfolioScopeFromList) so the
  // CLI surfaces the same canonical scope shape the
  // projector would compute internally.
  if (projectIds.length === 0) {
    return { tenantId, projectIds: Object.freeze([]) as readonly ProjectId[] };
  }
  const deduped = Array.from(new Set<ProjectId>(projectIds));
  return { tenantId, projectIds: Object.freeze(deduped) as readonly ProjectId[] };
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

function failureResult(payload: PortfolioFailurePayload, human: string): CliResult {
  return {
    exitCode: 1,
    payload: payload as unknown as Record<string, unknown>,
    human
  } as CliResult;
}
