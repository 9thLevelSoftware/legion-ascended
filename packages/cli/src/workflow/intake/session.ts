/**
 * Durable intake session state.
 *
 * The session lives on disk from the first question, not from the last. That is
 * the whole mechanism behind "the interview survives context loss": an agent
 * that has forgotten the conversation can read the file and find out exactly
 * which nodes were asked, what was answered, and what is still open — rather
 * than reconstructing an interview from a summary of itself, which is where the
 * questions quietly go missing.
 *
 * Every mutation is a pure function returning a new session, and every write
 * revalidates against `intakeSessionSchema`. A session that cannot be parsed is
 * refused rather than repaired: silent repair of the record that says what was
 * asked would defeat the point of keeping it.
 */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  formatEntityId,
  intakeSessionSchema,
  utcTimestampSchema,
  type Exploration,
  type IntakeAnswer,
  type IntakeInjectedNode,
  type IntakeSession,
  type ProjectId,
  type UtcTimestamp
} from "@legion/protocol";

import {
  INTAKE_GRAPH_VERSION,
  MAX_NODE_ID_LENGTH,
  answersByNodeId,
  applicableNodes,
  findNode,
  isNodeApplicable,
  namespaceInjectedNodeId,
  nextNode
} from "./graph.js";

export const INTAKE_ROOT = ".legion/project/intake" as const;
const SESSION_FILE = "session.json";

export function intakeSessionDirectory(repositoryRoot: string, sessionId: string): string {
  return path.join(repositoryRoot, ".legion", "project", "intake", sessionId);
}

function sessionFilePath(repositoryRoot: string, sessionId: string): string {
  return path.join(intakeSessionDirectory(repositoryRoot, sessionId), SESSION_FILE);
}

export function nowTimestamp(): UtcTimestamp {
  return utcTimestampSchema.parse(new Date().toISOString());
}

/**
 * A session ID derived from the creation instant.
 *
 * Sortable, so "the most recent session" is a lexicographic question rather
 * than a filesystem-timestamp one — `readdir` order and mtime are both things
 * that differ across platforms and get rewritten by ordinary tooling.
 */
export function intakeSessionIdFor(createdAt: UtcTimestamp, salt = ""): string {
  const compact = createdAt.replace(/[-:.]/g, "").replace("T", "-").replace("Z", "");
  return formatEntityId("intake", `${compact}${salt}`);
}

export interface CreateSessionInput {
  readonly createdAt: UtcTimestamp;
  readonly schemaVersion: string;
  readonly exploration?: Exploration;
  readonly explorationArtifact?: { readonly path: string; readonly sha256: string };
  readonly salt?: string;
  /** Allocated by the caller against the filesystem; see `allocateSessionId`. */
  readonly sessionId?: string;
}

export interface SeededSession {
  readonly session: IntakeSession;
  /** Proposals the exploration offered, keyed by slot, for pre-filling prompts. */
  readonly proposals: ReadonlyMap<string, ExplorationProposal>;
}

export interface ExplorationProposal {
  readonly value: string | readonly string[];
  readonly rationale: string;
  readonly anchor: string;
  readonly confidence: string;
  readonly runId: string;
}

/**
 * Build a new session, optionally seeded from a brainstorm.
 *
 * Seeding attaches *proposals*, never answers. Every required node is still
 * asked; a proposal only changes what the operator is shown as a starting
 * point. Open questions become injected nodes, so an exploration that resolved
 * less makes the interview longer rather than shorter — the direction that
 * keeps a fuzzy idea from becoming a confident contract.
 */
export function createSession(input: CreateSessionInput): SeededSession {
  // `sessionId` is supplied by a caller that checked the filesystem. Deriving it
  // here from the timestamp alone made two starts with the same `--created-at`
  // produce the same ID, and `saveSession` would overwrite the earlier record.
  const id = input.sessionId ?? intakeSessionIdFor(input.createdAt, input.salt ?? "");
  const proposals = new Map<string, ExplorationProposal>();
  const injectedNodes: IntakeInjectedNode[] = [];

  if (input.exploration !== undefined) {
    for (const proposal of input.exploration.proposals) {
      proposals.set(proposal.slot, {
        value: proposal.value,
        rationale: proposal.rationale,
        anchor: proposal.anchor,
        confidence: proposal.confidence,
        runId: input.exploration.runId
      });
    }
    // Injected IDs are namespaced rather than checked for collisions: the graph
    // never uses the `open-` prefix, so a slugified open question can never
    // shadow a built-in node no matter what the exploration called it.
    const takenNodeIds = new Set<string>();
    for (const question of input.exploration.openQuestions) {
      let nodeId = namespaceInjectedNodeId(question.nodeId);
      let collision = 0;
      while (takenNodeIds.has(nodeId)) {
        collision += 1;
        const suffix = `-${collision}`;
        nodeId = `${namespaceInjectedNodeId(question.nodeId).slice(0, MAX_NODE_ID_LENGTH - suffix.length)}${suffix}`;
      }
      takenNodeIds.add(nodeId);
      injectedNodes.push({
        nodeId,
        slot: question.slot,
        prompt: question.question,
        origin: { runId: input.exploration.runId, anchor: question.slot }
      });
    }
  }

  const explorationRef =
    input.exploration !== undefined && input.explorationArtifact !== undefined
      ? {
          runId: input.exploration.runId,
          artifact: {
            path: input.explorationArtifact.path,
            sha256: input.explorationArtifact.sha256
          }
        }
      : undefined;

  const draft = {
    schemaVersion: input.schemaVersion,
    createdAt: input.createdAt,
    kind: "intake-session" as const,
    id,
    graphVersion: INTAKE_GRAPH_VERSION,
    status: "active" as const,
    ...(explorationRef === undefined ? {} : { explorationRef }),
    answers: [],
    injectedNodes,
    diagnostics: []
  };

  const withCursor = withRecomputedCursor(intakeSessionSchema.parse(draft));
  return { session: withCursor, proposals };
}

/**
 * Recompute the cursor from the answers.
 *
 * The cursor is derived, never assigned: storing it independently of the
 * answers creates two sources of truth for "what is next", and the one that
 * drifts is always the one a resumed session reads.
 */
export function withRecomputedCursor(session: IntakeSession): IntakeSession {
  const { node } = nextNode({ answers: session.answers, injectedNodes: session.injectedNodes });
  const next = node === undefined ? {} : { cursor: node.id };
  const { cursor: _dropped, ...rest } = session;
  return intakeSessionSchema.parse({ ...rest, ...next });
}

export interface RecordAnswerInput {
  readonly session: IntakeSession;
  readonly nodeId: string;
  readonly value: IntakeAnswer["value"];
  readonly answeredAt: UtcTimestamp;
  readonly source?: IntakeAnswer["source"];
  readonly proposedFrom?: IntakeAnswer["proposedFrom"];
}

export type RecordAnswerResult =
  | { readonly ok: true; readonly session: IntakeSession }
  | { readonly ok: false; readonly reason: string };

/**
 * Record one answer.
 *
 * Re-answering a node replaces the previous entry rather than appending a
 * second one, because the schema forbids a node appearing twice and a session
 * carrying two answers for one question has no defensible reading.
 */
export function recordAnswer(input: RecordAnswerInput): RecordAnswerResult {
  if (input.session.status !== "active") {
    return { ok: false, reason: `This session is ${input.session.status} and cannot take new answers.` };
  }

  const node = findNode(
    { answers: input.session.answers, injectedNodes: input.session.injectedNodes },
    input.nodeId
  );
  if (node === undefined) {
    return {
      ok: false,
      reason: `${input.nodeId} is not a question in this session. Ask for the next question rather than choosing one.`
    };
  }

  // A materialized node is not necessarily a node being asked. Recording an
  // answer to one excluded by its `dependsOn` — how a `wont` requirement is
  // proven, say — would put a value in the session that the interview never
  // requested and that the next prune would silently remove.
  if (!isNodeApplicable(node, answersByNodeId(input.session.answers))) {
    return {
      ok: false,
      reason: `${input.nodeId} is not being asked; an earlier answer ruled it out.`
    };
  }

  const answer: IntakeAnswer = {
    nodeId: node.id,
    slot: node.slot,
    value: input.value,
    answeredAt: input.answeredAt,
    source: input.source ?? "human",
    ...(input.proposedFrom === undefined ? {} : { proposedFrom: input.proposedFrom })
  };

  const answers = [...input.session.answers.filter((entry) => entry.nodeId !== node.id), answer];
  const parsed = intakeSessionSchema.safeParse({ ...input.session, answers });
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map((issue) => issue.message).join("; ") };
  }

  return { ok: true, session: withRecomputedCursor(pruneOrphanedAnswers(parsed.data)) };
}

/**
 * Drop answers to nodes the graph no longer materializes.
 *
 * Changing a loop controller from "yes, another" to "no" shortens the graph.
 * Without pruning, the answers to the nodes that disappeared stay on disk and
 * `requirementDrafts` reconstructs requirements the operator withdrew — a
 * contract containing work nobody asked for, assembled from stale state.
 */
export function pruneOrphanedAnswers(session: IntakeSession): IntakeSession {
  // Iterated to a fixed point. One pass is very likely enough — removing an
  // answer only ever shrinks the graph — but "very likely" is the kind of
  // reasoning that leaves a stale answer in a contract, and the loop is cheap.
  let current = session;
  for (;;) {
    const live = new Set(
      applicableNodes({ answers: current.answers, injectedNodes: current.injectedNodes }).map(
        (node) => node.id
      )
    );
    const answers = current.answers.filter((answer) => live.has(answer.nodeId));
    if (answers.length === current.answers.length) return current;
    current = intakeSessionSchema.parse({ ...current, answers });
  }
}

export type BackResult =
  | { readonly ok: true; readonly session: IntakeSession; readonly nodeId: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Step back one question.
 *
 * Removes the most recently *answered* node rather than the previous node in
 * graph order. Those differ whenever a loop controller was flipped, and the
 * answer the operator wants to change is the one they just gave.
 */
export function stepBack(session: IntakeSession): BackResult {
  if (session.status !== "active") {
    return { ok: false, reason: `This session is ${session.status} and cannot be rewound.` };
  }
  // `recordAnswer` always appends, so the tail is the most recent answer.
  // Sorting by `answeredAt` instead would be wrong under `--intake`, where a
  // whole answer set can share one millisecond.
  const last = session.answers.at(-1);
  if (last === undefined) {
    return { ok: false, reason: "Nothing has been answered yet." };
  }

  const answers = session.answers.filter((entry) => entry.nodeId !== last.nodeId);
  const pruned = pruneOrphanedAnswers(intakeSessionSchema.parse({ ...session, answers }));
  return { ok: true, session: withRecomputedCursor(pruned), nodeId: last.nodeId };
}

export function abortSession(session: IntakeSession): IntakeSession {
  return intakeSessionSchema.parse({ ...session, status: "aborted" });
}

export function finalizeSession(session: IntakeSession, projectId: ProjectId): IntakeSession {
  const { cursor: _dropped, ...rest } = session;
  return intakeSessionSchema.parse({ ...rest, status: "finalized", projectId });
}

export function withDiagnostics(
  session: IntakeSession,
  diagnostics: readonly string[]
): IntakeSession {
  return intakeSessionSchema.parse({ ...session, diagnostics: [...diagnostics] });
}

export type LoadSessionResult =
  | { readonly ok: true; readonly session: IntakeSession }
  | { readonly ok: false; readonly reason: string };

/**
 * Whether an active session may still be advanced by this CLI.
 *
 * A session pins the graph version it started under. If the CLI has since moved
 * to a different graph, the answers on disk were given to questions that may no
 * longer exist, mean something else, or sit in a different order — and every
 * cursor, prune and finalize would silently reinterpret them under the new
 * graph. Pinning would be decoration if nothing enforced it.
 *
 * Finalized and aborted sessions are exempt. They are records rather than work
 * in progress, and refusing to read a record because the graph moved on would
 * make history unreadable after every upgrade.
 */
export function graphVersionMismatch(session: IntakeSession): string | undefined {
  if (session.status !== "active") return undefined;
  if (session.graphVersion === INTAKE_GRAPH_VERSION) return undefined;
  return (
    `Session ${session.id} was started under intake graph ${session.graphVersion}, but this CLI ships ${INTAKE_GRAPH_VERSION}. ` +
    `Its answers were given to a different set of questions. Run legion start --abort --session ${session.id} and begin again, ` +
    `or finish it with the CLI version it was started under.`
  );
}

export async function loadSession(
  repositoryRoot: string,
  sessionId: string
): Promise<LoadSessionResult> {
  let text: string;
  try {
    text = await readFile(sessionFilePath(repositoryRoot, sessionId), "utf8");
  } catch (error) {
    if (isEnoent(error)) return { ok: false, reason: `No intake session ${sessionId} exists.` };
    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `Intake session ${sessionId} is not valid JSON: ${message}` };
  }

  const parsed = intakeSessionSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Intake session ${sessionId} does not match the protocol: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`
    };
  }
  return { ok: true, session: parsed.data };
}

export async function saveSession(repositoryRoot: string, session: IntakeSession): Promise<void> {
  // Revalidate on the way out. Every mutation above already parses, but this is
  // the last point before the bytes become the record of what was asked, and
  // the cost of being sure is one schema call.
  const validated = intakeSessionSchema.parse(session);
  const directory = intakeSessionDirectory(repositoryRoot, validated.id);
  await mkdir(directory, { recursive: true });

  const target = path.join(directory, SESSION_FILE);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(validated, undefined, 2)}\n`, "utf8");
  await rename(temporary, target);
}

/**
 * Every session on disk, newest first.
 *
 * Sorted by ID, which encodes the creation instant, so the ordering does not
 * depend on directory-entry order or on mtimes that a checkout rewrites.
 */
export async function listSessions(repositoryRoot: string): Promise<readonly string[]> {
  const root = path.join(repositoryRoot, ".legion", "project", "intake");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("itk_"))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
}

export type FindActiveSessionResult =
  | { readonly ok: true; readonly session: IntakeSession | undefined }
  | { readonly ok: false; readonly reason: string };

/**
 * The most recent session that is still open, if any.
 *
 * A candidate that cannot be parsed stops the search rather than being skipped.
 * Skipping it would resume an older interview, or silently start a new one,
 * while the durable record of the interview in progress sat corrupt on disk —
 * and the operator would answer a different session without being told. The
 * previous comment here claimed exactly this behaviour and the code did the
 * opposite.
 */
export async function findActiveSession(
  repositoryRoot: string
): Promise<FindActiveSessionResult> {
  for (const sessionId of await listSessions(repositoryRoot)) {
    const loaded = await loadSession(repositoryRoot, sessionId);
    if (!loaded.ok) {
      return {
        ok: false,
        reason: `${loaded.reason} Repair or remove ${INTAKE_ROOT}/${sessionId}, or name a different session with --session.`
      };
    }
    if (loaded.session.status === "active") return { ok: true, session: loaded.session };
  }
  return { ok: true, session: undefined };
}

/**
 * Whether a session ID is already taken.
 *
 * IDs derive from the creation instant, so an explicit `--created-at` (or two
 * starts inside one millisecond) can collide with a session already on disk.
 * Overwriting it would erase a durable decision record and leave the earlier
 * requirement set's trace references pointing at a different interview.
 */
export async function intakeSessionExists(
  repositoryRoot: string,
  sessionId: string
): Promise<boolean> {
  try {
    await readFile(sessionFilePath(repositoryRoot, sessionId), "utf8");
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    // Unreadable for any other reason still means occupied: claiming the ID
    // would overwrite whatever is there.
    return true;
  }
}

/** An unused session ID at or after `createdAt`, salting until one is free. */
export async function allocateSessionId(
  repositoryRoot: string,
  createdAt: UtcTimestamp
): Promise<string> {
  const base = intakeSessionIdFor(createdAt);
  if (!(await intakeSessionExists(repositoryRoot, base))) return base;
  for (let attempt = 1; attempt <= 999; attempt += 1) {
    const candidate = intakeSessionIdFor(createdAt, `-${attempt}`);
    if (!(await intakeSessionExists(repositoryRoot, candidate))) return candidate;
  }
  throw new Error(`Could not allocate an intake session ID for ${createdAt}.`);
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
