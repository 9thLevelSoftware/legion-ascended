import path from "node:path";
import { mkdir } from "node:fs/promises";

import {
  SqliteBoardStoreWithApprovalRepository,
  SqliteBoardStoreWithClaimRepository,
  SqliteBoardStoreWithEventRepository,
  SqliteBoardStoreWithRepository
} from "@legion/store-sqlite";

import {
  helpResult,
  hasFlag,
  readJsonInput,
  requiredStringOption,
  stripCommand,
  success,
  usageError,
  type CliContext,
  type CliResult
} from "../../runtime.js";

const BOARD_HELP = `legion next board <domain>

Domains:
  task       Create, inspect, and mutate board task rows.
  event      Append and inspect append-only board events.
  claim      Create and manage task claim leases.
  approval   Create and manage approval records.

All non-help commands accept --input <path> with a JSON object.
Global:
  --repository-root <path>  Repository root. Defaults to the current directory.
  --json                    Emit machine-readable JSON.
  --no-color                Disable ANSI styling.
  --help                    Show help.`;

const TASK_HELP = `legion next board task <action>

Actions:
  create           Create a board task from JSON input.
  get              Load a task by taskId.
  list             List tasks using a JSON query object.
  update-priority  Update a task priority.
  transition       Transition a task status.
  bump-generation  Bump a task generation.
  supersede        Supersede a task with a successor.
  delete           Delete a task at an expected generation.

All actions accept --input <path> with a JSON object.`;

const EVENT_HELP = `legion next board event <action>

Actions:
  append           Append a single board event.
  append-batch     Append a batch of board events.
  get              Load an event by eventId.
  get-by-idempotency-key  Load an event by idempotency key.
  list             List events using a JSON query object.
  count            Count events using a JSON query object.
  tail             Return the tail of the event stream.

All actions accept --input <path> with a JSON object.`;

const CLAIM_HELP = `legion next board claim <action>

Actions:
  try              Attempt to claim a task.
  get              Load a claim by leaseToken.
  active           Load the active claim for a task.
  heartbeat        Refresh a lease heartbeat.
  release          Release a claim.
  reclaim          Reclaim expired leases.

All actions accept --input <path> with a JSON object.`;

const APPROVAL_HELP = `legion next board approval <action>

Actions:
  create           Create a new approval request.
  get              Load an approval by approvalId.
  list             List approvals using a JSON query object.
  grant            Grant an approval.
  deny             Deny an approval.
  revoke           Revoke an approval.
  expire           Expire an approval.

All actions accept --input <path> with a JSON object.`;

interface BoardStoreHandle {
  migrate(): unknown;
  close(): void;
}

export async function handleBoardCommand(context: CliContext): Promise<CliResult> {
  const [command] = context.args.positionals;
  if (hasFlag(context, "help") || command === undefined || command === "help") return helpResult(BOARD_HELP);

  const commandContext = stripCommand(context, 1);
  switch (command) {
    case "task":
      return handleTaskCommand(commandContext);
    case "event":
      return handleEventCommand(commandContext);
    case "claim":
      return handleClaimCommand(commandContext);
    case "approval":
      return handleApprovalCommand(commandContext);
    default:
      return helpResult(BOARD_HELP);
  }
}

async function handleTaskCommand(context: CliContext): Promise<CliResult> {
  const [action] = context.args.positionals;
  if (hasFlag(context, "help") || action === undefined || action === "help") return helpResult(TASK_HELP);

  const commandContext = stripCommand(context, 1);
  switch (action) {
    case "create":
      return withTaskRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const task = repository.createTask(input as any);
        return success({ ok: true, status: "created", task }, `${task.taskId}: created.`);
      });
    case "get":
      return withTaskRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const taskId = requiredStringField(input, "taskId");
        if (taskId === undefined) return usageError("Missing required field taskId.");
        const task = repository.getTask(taskId);
        return success({ ok: true, status: "loaded", task }, task === null ? `${taskId}: not found.` : `${taskId}: loaded.`);
      });
    case "list":
      return withTaskRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const tasks = repository.listTasks(input as any);
        return success({ ok: true, status: "listed", tasks }, `${tasks.length} tasks listed.`);
      });
    case "update-priority":
      return withTaskRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const taskId = requiredStringField(input, "taskId");
        if (taskId === undefined) return usageError("Missing required field taskId.");
        const nextPriority = requiredNumberField(input, "nextPriority", "priority");
        if (nextPriority === undefined) return usageError("Missing required numeric field nextPriority/priority.");
        const task = repository.updateTaskPriority(taskId, nextPriority, numberField(input, "expectedGeneration"));
        return success({ ok: true, status: "updated", task }, `${task.taskId}: priority updated.`);
      });
    case "transition":
      return withTaskRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const taskId = requiredStringField(input, "taskId");
        if (taskId === undefined) return usageError("Missing required field taskId.");
        const toStatus = requiredStringField(input, "toStatus");
        if (toStatus === undefined) return usageError("Missing required field toStatus.");
        const transition: Record<string, unknown> = { toStatus };
        const blocker = (input as any).blocker;
        if (blocker !== undefined) transition["blocker"] = blocker;
        const task = repository.transitionTaskStatus(taskId, transition as any, numberField(input, "expectedGeneration"));
        return success({ ok: true, status: "transitioned", task }, `${task.taskId}: transitioned to ${task.status}.`);
      });
    case "bump-generation":
      return withTaskRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const task = repository.bumpGeneration(input as any);
        return success({ ok: true, status: "bumped", task }, `${task.taskId}: generation bumped.`);
      });
    case "supersede":
      return withTaskRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const result = repository.supersedeTask(input as any);
        return success({ ok: true, status: "superseded", retired: result.retired, successor: result.successor }, `${result.retired.taskId}: superseded.`);
      });
    case "delete":
      return withTaskRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const taskId = requiredStringField(input, "taskId");
        if (taskId === undefined) return usageError("Missing required field taskId.");
        const expectedGeneration = requiredNumberField(input, "expectedGeneration", "generation");
        if (expectedGeneration === undefined) return usageError("Missing required numeric field expectedGeneration/generation.");
        repository.deleteTask(taskId, expectedGeneration);
        return success({ ok: true, status: "deleted" }, `${taskId}: deleted.`);
      });
    default:
      return helpResult(TASK_HELP);
  }
}

async function handleEventCommand(context: CliContext): Promise<CliResult> {
  const [action] = context.args.positionals;
  if (hasFlag(context, "help") || action === undefined || action === "help") return helpResult(EVENT_HELP);

  const commandContext = stripCommand(context, 1);
  switch (action) {
    case "append":
      return withEventRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const result = repository.appendEvent(input as any);
        return success({ ok: true, status: "appended", event: result.event }, `${result.event.eventId}: appended.`);
      });
    case "append-batch":
      return withEventRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const result = repository.appendEvents(input as any);
        return success({ ok: true, status: "appended", events: result.events }, `${result.events.length} events appended.`);
      });
    case "get":
      return withEventRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const eventId = requiredStringField(input, "eventId");
        if (eventId === undefined) return usageError("Missing required field eventId.");
        const event = repository.getEvent(eventId);
        return success({ ok: true, status: "loaded", event }, event === null ? `${eventId}: not found.` : `${eventId}: loaded.`);
      });
    case "get-by-idempotency-key":
      return withEventRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const idempotencyKey = requiredStringField(input, "idempotencyKey");
        if (idempotencyKey === undefined) return usageError("Missing required field idempotencyKey.");
        const event = repository.getEventByIdempotencyKey(idempotencyKey);
        return success({ ok: true, status: "loaded", event }, event === null ? `${idempotencyKey}: not found.` : `${idempotencyKey}: loaded.`);
      });
    case "list":
      return withEventRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const events = repository.listEvents(input as any);
        return success({ ok: true, status: "listed", events }, `${events.length} events listed.`);
      });
    case "count":
      return withEventRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const count = repository.countEvents(input as any);
        return success({ ok: true, status: "counted", count }, `${count} events counted.`);
      });
    case "tail":
      return withEventRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const limit = numberField(input, "limit") ?? 50;
        const events = repository.tail(limit);
        return success({ ok: true, status: "listed", events }, `${events.length} events returned.`);
      });
    default:
      return helpResult(EVENT_HELP);
  }
}

async function handleClaimCommand(context: CliContext): Promise<CliResult> {
  const [action] = context.args.positionals;
  if (hasFlag(context, "help") || action === undefined || action === "help") return helpResult(CLAIM_HELP);

  const commandContext = stripCommand(context, 1);
  switch (action) {
    case "try":
      return withClaimRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const claim = repository.tryClaim(input as any);
        return success({ ok: true, status: "claimed", claim }, `${claim.taskId}: claimed.`);
      });
    case "get":
      return withClaimRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const leaseToken = requiredStringField(input, "leaseToken");
        if (leaseToken === undefined) return usageError("Missing required field leaseToken.");
        const claim = repository.getClaim(leaseToken);
        return success({ ok: true, status: "loaded", claim }, claim === null ? `${leaseToken}: not found.` : `${leaseToken}: loaded.`);
      });
    case "active":
      return withClaimRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const taskId = requiredStringField(input, "taskId");
        if (taskId === undefined) return usageError("Missing required field taskId.");
        const claim = repository.getActiveClaimForTask(taskId);
        return success({ ok: true, status: "loaded", claim }, claim === null ? `${taskId}: no active claim.` : `${taskId}: active claim loaded.`);
      });
    case "heartbeat":
      return withClaimRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const claim = repository.heartbeat(input as any);
        return success({ ok: true, status: "updated", claim }, `${claim.leaseToken}: heartbeat refreshed.`);
      });
    case "release":
      return withClaimRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const claim = repository.release(input as any);
        return success({ ok: true, status: "released", claim }, `${claim.leaseToken}: released.`);
      });
    case "reclaim":
      return withClaimRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const claims = repository.reclaimExpiredLeases(input as any);
        return success({ ok: true, status: "reclaimed", claims }, `${claims.length} claims reclaimed.`);
      });
    default:
      return helpResult(CLAIM_HELP);
  }
}

async function handleApprovalCommand(context: CliContext): Promise<CliResult> {
  const [action] = context.args.positionals;
  if (hasFlag(context, "help") || action === undefined || action === "help") return helpResult(APPROVAL_HELP);

  const commandContext = stripCommand(context, 1);
  switch (action) {
    case "create":
      return withApprovalRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const approval = repository.createApproval(input as any);
        return success({ ok: true, status: "created", approval }, `${approval.approvalId}: created.`);
      });
    case "get":
      return withApprovalRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const approvalId = requiredStringField(input, "approvalId");
        if (approvalId === undefined) return usageError("Missing required field approvalId.");
        const approval = repository.getApproval(approvalId);
        return success({ ok: true, status: "loaded", approval }, approval === null ? `${approvalId}: not found.` : `${approvalId}: loaded.`);
      });
    case "list":
      return withApprovalRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const approvals = repository.listApprovals(input as any);
        return success({ ok: true, status: "listed", approvals }, `${approvals.length} approvals listed.`);
      });
    case "grant":
      return withApprovalRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const approval = repository.grantApproval(input as any);
        return success({ ok: true, status: "granted", approval }, `${approval.approvalId}: granted.`);
      });
    case "deny":
      return withApprovalRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const approval = repository.denyApproval(input as any);
        return success({ ok: true, status: "denied", approval }, `${approval.approvalId}: denied.`);
      });
    case "revoke":
      return withApprovalRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const approval = repository.revokeApproval(input as any);
        return success({ ok: true, status: "revoked", approval }, `${approval.approvalId}: revoked.`);
      });
    case "expire":
      return withApprovalRepository(commandContext, async (repository) => {
        const input = await loadBoardInput(commandContext);
        if (isCliResult(input)) return input;
        const approval = repository.expireApproval(input as any);
        return success({ ok: true, status: "expired", approval }, `${approval.approvalId}: expired.`);
      });
    default:
      return helpResult(APPROVAL_HELP);
  }
}

async function withTaskRepository(context: CliContext, callback: (repository: any) => Promise<CliResult>): Promise<CliResult> {
  return withBoardStore(context, () => SqliteBoardStoreWithRepository.open(boardStoreOptions(context)), async (store) => {
    return callback(store.repository);
  });
}

async function withEventRepository(context: CliContext, callback: (repository: any) => Promise<CliResult>): Promise<CliResult> {
  return withBoardStore(context, () => SqliteBoardStoreWithEventRepository.open(boardStoreOptions(context)), async (store) => {
    return callback(store.eventRepository);
  });
}

async function withClaimRepository(context: CliContext, callback: (repository: any) => Promise<CliResult>): Promise<CliResult> {
  return withBoardStore(context, () => SqliteBoardStoreWithClaimRepository.open(boardStoreOptions(context)), async (store) => {
    return callback(store.claimRepository);
  });
}

async function withApprovalRepository(context: CliContext, callback: (repository: any) => Promise<CliResult>): Promise<CliResult> {
  return withBoardStore(context, () => SqliteBoardStoreWithApprovalRepository.open(boardStoreOptions(context)), async (store) => {
    return callback(store.approvalRepository);
  });
}

async function withBoardStore<T extends BoardStoreHandle>(
  context: CliContext,
  openStore: () => T,
  callback: (store: T) => Promise<CliResult>
): Promise<CliResult> {
  await mkdir(path.dirname(boardDatabasePath(context)), { recursive: true });
  const store = openStore();
  try {
    store.migrate();
    return await callback(store);
  } finally {
    store.close();
  }
}

async function loadBoardInput(context: CliContext): Promise<Record<string, unknown> | CliResult> {
  const inputPath = requiredStringOption(context, "input");
  if (typeof inputPath !== "string") return inputPath;
  return readJsonInput(inputPath);
}

function boardStoreOptions(context: CliContext): { readonly databasePath: string; readonly busyTimeoutMs: number } {
  return {
    databasePath: boardDatabasePath(context),
    busyTimeoutMs: 7_500
  };
}

function boardDatabasePath(context: CliContext): string {
  return path.join(context.repositoryRoot, ".legion", "var", "board.sqlite");
}

function requiredStringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredNumberField(input: Record<string, unknown>, key: string, fallbackKey?: string): number | undefined {
  const value = input[key] ?? (fallbackKey ? input[fallbackKey] : undefined);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberField(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isCliResult(value: unknown): value is CliResult {
  return Boolean(value && typeof value === "object" && "exitCode" in value && "payload" in value);
}
