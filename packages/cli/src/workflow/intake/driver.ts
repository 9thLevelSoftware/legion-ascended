/**
 * `legion start` as a session driver.
 *
 * Every invocation is stateless: it reads the session from disk, does one
 * thing, writes it back, and exits. Nothing about the interview lives in the
 * caller's memory, which is what makes an agent that has lost its context a
 * safe participant — it can only advance the interview by asking the CLI what
 * comes next, and the CLI answers from the file rather than from anything the
 * agent believes.
 *
 * The JSON payload is the contract a host renders. The human text beside it is
 * a fallback, not a second implementation of the interview.
 */

import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { initProject, updateConstitution, writeRequirementSet } from "@legion/artifacts";
import {
  LEGION_PROTOCOL_VERSION,
  projectSchema,
  type IntakeSession,
  type ProjectId
} from "@legion/protocol";

import {
  failure,
  hasFlag,
  stringOption,
  success,
  usageError,
  type CliContext,
  type CliResult
} from "../../runtime.js";
import { createdAtOption, ownerActor, repositoryReference, slugFromName } from "../input.js";
import { nextAction, renderNextAction } from "../render.js";
import { buildRequirements, renderConstitution, renderRoadmap } from "./finalize.js";
import { INTAKE_GRAPH_VERSION, findNode, nextNode, type IntakeNode } from "./graph.js";
import { loadExploration, listExplorations } from "./exploration-source.js";
import { renderIntakeDiagnostics, renderQuestion, renderSessionStatus } from "./render.js";
import {
  abortSession,
  allocateSessionId,
  createSession,
  finalizeSession,
  findActiveSession,
  graphVersionMismatch,
  loadSession,
  nowTimestamp,
  recordAnswer,
  releaseSessionId,
  saveSession,
  stepBack,
  withDiagnostics,
  type ExplorationProposal
} from "./session.js";
import { validateAnswer, validateAnswerSet, type IntakeDiagnostic } from "./validators.js";

const ROADMAP_MARKER = "<!-- Rendered by `legion start --finalize`";
const ROADMAP_FILE = "ROADMAP.md";

interface ResolvedSession {
  readonly session: IntakeSession;
  readonly proposals: ReadonlyMap<string, ExplorationProposal>;
  readonly created: boolean;
  /** Non-fatal notes about the seeding exploration, surfaced to the operator. */
  readonly notes: readonly string[];
}

function intakeSessionArtifactPath(sessionId: string): string {
  return `.legion/project/intake/${sessionId}/session.json`;
}

function questionPayload(node: IntakeNode, proposal: ExplorationProposal | undefined): Record<string, unknown> {
  return {
    nodeId: node.id,
    section: node.section,
    slot: node.slot,
    prompt: node.prompt,
    ...(node.help === undefined ? {} : { help: node.help }),
    kind: node.kind,
    required: node.required,
    ...(node.options === undefined ? {} : { options: node.options }),
    ...(node.injected === true ? { injected: true } : {}),
    ...(proposal === undefined
      ? {}
      : {
          proposal: {
            value: proposal.value,
            rationale: proposal.rationale,
            confidence: proposal.confidence,
            runId: proposal.runId,
            anchor: proposal.anchor
          }
        })
  };
}

function sessionPayload(session: IntakeSession, answered: number, total: number): Record<string, unknown> {
  return {
    id: session.id,
    status: session.status,
    graphVersion: session.graphVersion,
    answered,
    total,
    ...(session.cursor === undefined ? {} : { cursor: session.cursor }),
    ...(session.explorationRef === undefined
      ? {}
      : { explorationRunId: session.explorationRef.runId }),
    injectedNodes: session.injectedNodes.length
  };
}

interface LoadedProposals {
  readonly proposals: ReadonlyMap<string, ExplorationProposal>;
  readonly diagnostics: readonly string[];
}

/**
 * Reload the proposals a seeded session may offer.
 *
 * The recorded artifact hash is checked, not merely stored. `--accept-proposal`
 * writes `source: proposed-accepted` together with the exploration it came
 * from, and that provenance is worthless if the bytes it names have changed
 * since — the session would attest to a value the exploration no longer
 * contains.
 *
 * A mismatch drops every proposal rather than offering the new ones. Dropping
 * degrades to asking the operator, which is the safe direction and the same
 * asymmetry `parseExploration` already applies: a lost suggestion costs a
 * question, an unnoticed substitution costs a decision.
 */
async function proposalsFor(
  repositoryRoot: string,
  session: IntakeSession
): Promise<LoadedProposals> {
  const reference = session.explorationRef;
  if (reference === undefined) return { proposals: new Map(), diagnostics: [] };

  const loaded = await loadExploration(repositoryRoot, reference.runId);
  if (!loaded.ok) {
    return {
      proposals: new Map(),
      diagnostics: [`Exploration ${reference.runId} could not be reloaded, so its proposals are unavailable: ${loaded.reason}`]
    };
  }

  if (loaded.loaded.artifact.sha256 !== reference.artifact.sha256) {
    return {
      proposals: new Map(),
      diagnostics: [
        `Exploration ${reference.runId} has changed since this session was seeded, so its proposals were withheld. ` +
          `The remaining questions are asked normally; start a new session to use the updated exploration.`
      ]
    };
  }

  const proposals = new Map<string, ExplorationProposal>();
  for (const proposal of loaded.loaded.exploration.proposals) {
    proposals.set(proposal.slot, {
      value: proposal.value,
      rationale: proposal.rationale,
      anchor: proposal.anchor,
      confidence: proposal.confidence,
      runId: loaded.loaded.exploration.runId
    });
  }
  return { proposals, diagnostics: [] };
}

/**
 * Find the session this invocation acts on.
 *
 * `--session <id>` names one explicitly; otherwise the most recent active
 * session is resumed. A new session is created only when `create` is set, so
 * that `--answer` against a finished interview reports that fact rather than
 * quietly opening a fresh one and losing the answer.
 *
 * `allowStaleGraph` is for the commands that neither advance the interview nor
 * write artifacts from it. Without it the pin deadlocks: the mismatch message
 * tells the operator to run `legion start --abort --session <id>`, and that
 * command resolved the same session through the same check, so the only
 * documented way out was refused by the thing it was escaping — and every later
 * `legion start` failed on the same stale session.
 */
async function resolveSession(
  context: CliContext,
  options: {
    readonly create: boolean;
    readonly allowStaleGraph?: boolean;
    readonly proposals?: boolean;
  }
): Promise<ResolvedSession | CliResult> {
  const wantsProposals = options.proposals !== false;
  const explicitId = stringOption(context, "session");
  if (explicitId !== undefined) {
    const loaded = await loadSession(context.repositoryRoot, explicitId);
    if (!loaded.ok) return usageError(loaded.reason);
    if (options.allowStaleGraph !== true) {
      const stale = graphVersionMismatch(loaded.session);
      if (stale !== undefined) return usageError(stale);
    }
    const seeded = wantsProposals
      ? await proposalsFor(context.repositoryRoot, loaded.session)
      : { proposals: new Map<string, ExplorationProposal>(), diagnostics: [] };
    return {
      session: loaded.session,
      proposals: seeded.proposals,
      created: false,
      notes: seeded.diagnostics
    };
  }

  const explorationRunId = stringOption(context, "from-exploration");
  const found = await findActiveSession(context.repositoryRoot);
  // A corrupt session stops everything rather than being stepped over: resuming
  // an older interview, or quietly opening a new one, would have the operator
  // answering a different session than the record on disk describes.
  if (!found.ok) return failure({ ok: false, status: "invalid_session", diagnostics: [{ code: "corrupt_session", message: found.reason }] }, found.reason);

  const active = found.session;
  if (active !== undefined) {
    // `--from-exploration` only applies at session creation, and the no-argument
    // start prints exactly this command when it finds explorations. Resuming
    // before reading the option meant following that advice silently discarded
    // the chosen exploration — every proposal and every open question with it.
    if (explorationRunId !== undefined && active.explorationRef?.runId !== explorationRunId) {
      if (active.answers.length > 0) {
        return usageError(
          `Session ${active.id} is already in progress with ${active.answers.length} answer(s), and seeding only applies when a session is created. ` +
            `Run legion start --abort --session ${active.id} first if you want to restart from exploration ${explorationRunId}.`
        );
      }
      // Nothing has been answered, so replacing it loses no work. Abort rather
      // than delete: the abandoned session stays on disk as a record.
      await saveSession(context.repositoryRoot, abortSession(active));
    } else {
      if (options.allowStaleGraph !== true) {
        const stale = graphVersionMismatch(active);
        if (stale !== undefined) return usageError(stale);
      }
      const seeded = wantsProposals
        ? await proposalsFor(context.repositoryRoot, active)
        : { proposals: new Map<string, ExplorationProposal>(), diagnostics: [] };
      return {
        session: active,
        proposals: seeded.proposals,
        created: false,
        notes: seeded.diagnostics
      };
    }
  }

  if (!options.create) {
    return usageError(
      "There is no active intake session. Run legion start to begin one, or pass --session <id>."
    );
  }

  const createdAt = createdAtOption(context) ?? nowTimestamp();

  // Everything that can refuse runs before the ID is claimed. Claiming first
  // and validating after left an `itk_` directory with no `session.json` behind
  // every rejected `--from-exploration`, and that directory then failed to load
  // on every later invocation — one mistyped run ID took `legion start` out of
  // service for the repository.
  let exploration: Awaited<ReturnType<typeof loadExploration>> | undefined;
  if (explorationRunId !== undefined) {
    exploration = await loadExploration(context.repositoryRoot, explorationRunId);
    if (!exploration.ok) return usageError(exploration.reason);
  }

  // Allocated against the filesystem, not derived from the timestamp alone: two
  // starts sharing a `--created-at` would otherwise share an ID, and saving the
  // second would overwrite the first session's durable record.
  const sessionId = await allocateSessionId(context.repositoryRoot, createdAt);
  try {
    const seeded = createSession({
      sessionId,
      createdAt,
      schemaVersion: LEGION_PROTOCOL_VERSION,
      ...(exploration === undefined || !exploration.ok
        ? {}
        : {
            exploration: exploration.loaded.exploration,
            explorationArtifact: exploration.loaded.artifact
          })
    });
    await saveSession(context.repositoryRoot, seeded.session);
    return { session: seeded.session, proposals: seeded.proposals, created: true, notes: [] };
  } catch (error) {
    // The claim only means something once a session sits behind it. Releasing
    // it keeps a failure here from poisoning every later invocation.
    await releaseSessionId(context.repositoryRoot, sessionId);
    throw error;
  }
}

function isCliResult(value: ResolvedSession | CliResult): value is CliResult {
  return "exitCode" in value;
}

/** `legion start` / `legion start --next` — emit the current question. */
export async function handleNextQuestion(context: CliContext): Promise<CliResult> {
  const resolved = await resolveSession(context, { create: true });
  if (isCliResult(resolved)) return resolved;

  const { session, proposals, created } = resolved;
  const { node, answered, total } = nextNode({
    answers: session.answers,
    injectedNodes: session.injectedNodes
  });

  // Offered whenever seeding is still free — a session with no answers — rather
  // than only on the invocation that created it. `commands/start.md` tells the
  // host to act on this field, and an operator who closed the terminal before
  // answering had no way to learn the exploration existed on resume. Seeding
  // only applies at creation, so once an answer is recorded the offer would be
  // advice that cannot be followed, which is the failure this PR keeps hitting.
  const canStillSeed = session.explorationRef === undefined && session.answers.length === 0;
  const explorations = canStillSeed ? await listExplorations(context.repositoryRoot) : [];

  if (node === undefined) {
    const action = nextAction(
      `legion start --finalize --session ${session.id}`,
      "Every question has been answered; finalizing writes the requirement set."
    );
    return success(
      {
        ok: true,
        status: "complete",
        session: sessionPayload(session, answered, total),
        question: null,
        nextAction: action
      },
      `Interview complete: ${answered} of ${total} questions answered.\n${renderNextAction(action)}`
    );
  }

  const proposal = proposals.get(node.slot);
  const action = nextAction(
    `legion start --answer "${node.id}=<value>"`,
    "Record this answer; the next question follows."
  );

  const human: string[] = [];
  for (const note of resolved.notes) human.push(`warning: ${note}`);
  if (resolved.notes.length > 0) human.push("");
  if (created) {
    human.push(`Started intake session ${session.id} (graph ${session.graphVersion}).`);
    if (session.injectedNodes.length > 0) {
      human.push(
        `${session.injectedNodes.length} extra question(s) were added from the exploration's open questions.`
      );
    }
    if (explorations.length > 0) {
      human.push(
        `Recent exploration(s) available to seed from: ${explorations
          .map((entry) => entry.runId)
          .join(", ")}. Restart with --from-exploration <runId> to use one.`
      );
    }
    human.push("");
  }
  human.push(renderQuestion({ node, answered, total, proposal, sessionId: session.id }));

  return success(
    {
      ok: true,
      status: "question",
      session: sessionPayload(session, answered, total),
      question: questionPayload(node, proposal),
      ...(explorations.length > 0
        ? { availableExplorations: explorations.map((entry) => ({ runId: entry.runId, topic: entry.topic })) }
        : {}),
      ...(resolved.notes.length === 0
        ? {}
        : { warnings: resolved.notes.map((note) => ({ code: "exploration_unavailable", message: note })) }),
      nextAction: action
    },
    human.join("\n")
  );
}

interface AnswerTarget {
  readonly node: IntakeNode;
  readonly session: IntakeSession;
  readonly proposals: ReadonlyMap<string, ExplorationProposal>;
}

function resolveAnswerTarget(
  resolved: ResolvedSession,
  nodeId: string | undefined
): AnswerTarget | CliResult {
  const { session, proposals } = resolved;
  const materialize = { answers: session.answers, injectedNodes: session.injectedNodes };

  if (nodeId === undefined) {
    const { node } = nextNode(materialize);
    if (node === undefined) {
      return usageError(
        "Every question has already been answered. Run legion start --finalize, or --back to change an answer."
      );
    }
    return { node, session, proposals };
  }

  const node = findNode(materialize, nodeId);
  if (node === undefined) {
    return usageError(
      `${nodeId} is not a question in this session. Run legion start --next to see what is being asked.`
    );
  }
  return { node, session, proposals };
}

/** `legion start --answer <nodeId>=<value>` — record one answer. */
export async function handleAnswer(context: CliContext): Promise<CliResult> {
  const rawAnswer = stringOption(context, "answer");
  if (rawAnswer === undefined) {
    return usageError('Provide an answer as --answer "<nodeId>=<value>".');
  }

  const separator = rawAnswer.indexOf("=");
  if (separator <= 0) {
    return usageError(
      `Answers are written as --answer "<nodeId>=<value>". Received: ${rawAnswer}`
    );
  }
  const nodeId = rawAnswer.slice(0, separator).trim();
  const rawValue = rawAnswer.slice(separator + 1);

  const resolved = await resolveSession(context, { create: false });
  if (isCliResult(resolved)) return resolved;
  if (resolved.session.status !== "active") {
    return usageError(`Session ${resolved.session.id} is ${resolved.session.status}.`);
  }

  const target = resolveAnswerTarget(resolved, nodeId);
  if ("exitCode" in target) return target;

  return recordAndReport(context, resolved, target.node, rawValue, undefined);
}

/** `legion start --accept-proposal` — take the exploration's suggestion for the current node. */
export async function handleAcceptProposal(context: CliContext): Promise<CliResult> {
  const resolved = await resolveSession(context, { create: false });
  if (isCliResult(resolved)) return resolved;
  if (resolved.session.status !== "active") {
    return usageError(`Session ${resolved.session.id} is ${resolved.session.status}.`);
  }

  const target = resolveAnswerTarget(resolved, stringOption(context, "node"));
  if ("exitCode" in target) return target;

  const proposal = resolved.proposals.get(target.node.slot);
  if (proposal === undefined) {
    return usageError(
      `No exploration proposed a value for ${target.node.slot}. Answer it with --answer instead.`
    );
  }

  // A multi-valued proposal is joined here because every node kind the
  // interview offers a proposal for is answered as text; `validateAnswer` then
  // re-splits it for a multi-select. Accepting the array unchanged would bypass
  // the validator that a typed answer goes through.
  const value: string = Array.isArray(proposal.value)
    ? proposal.value.join(", ")
    : (proposal.value as string);
  return recordAndReport(context, resolved, target.node, value, {
    runId: proposal.runId,
    anchor: proposal.anchor
  });
}

/** `legion start --skip` — decline an optional question. */
export async function handleSkip(context: CliContext): Promise<CliResult> {
  const resolved = await resolveSession(context, { create: false });
  if (isCliResult(resolved)) return resolved;
  if (resolved.session.status !== "active") {
    return usageError(`Session ${resolved.session.id} is ${resolved.session.status}.`);
  }

  const target = resolveAnswerTarget(resolved, stringOption(context, "node"));
  if ("exitCode" in target) return target;

  if (target.node.required) {
    return usageError(
      `${target.node.id} is required and cannot be skipped. Every required question is asked, which is the point of the graph.`
    );
  }

  return recordAndReport(context, resolved, target.node, "", undefined);
}

async function recordAndReport(
  context: CliContext,
  resolved: ResolvedSession,
  node: IntakeNode,
  rawValue: string,
  proposedFrom: { readonly runId: string; readonly anchor: string } | undefined
): Promise<CliResult> {
  const validated = validateAnswer(node, rawValue);
  if (validated.value === undefined) {
    // The real counts, not zeroes: a host renders progress from this payload
    // too, and a rejected answer would otherwise reset the interview to "0 of
    // 0" on the one screen the operator is being asked to look at again.
    const progress = nextNode({
      answers: resolved.session.answers,
      injectedNodes: resolved.session.injectedNodes
    });
    return failure(
      {
        ok: false,
        status: "rejected",
        session: sessionPayload(resolved.session, progress.answered, progress.total),
        question: questionPayload(node, resolved.proposals.get(node.slot)),
        diagnostics: validated.diagnostics
      },
      `${node.prompt}\n${renderIntakeDiagnostics(validated.diagnostics)}`
    );
  }

  const recorded = recordAnswer({
    session: resolved.session,
    nodeId: node.id,
    value: validated.value,
    answeredAt: nowTimestamp(),
    source: proposedFrom === undefined ? "human" : "proposed-accepted",
    ...(proposedFrom === undefined
      ? {}
      : { proposedFrom: { runId: proposedFrom.runId, anchor: proposedFrom.anchor } })
  });
  if (!recorded.ok) {
    return failure(
      { ok: false, status: "rejected", diagnostics: [{ code: "answer_rejected", message: recorded.reason }] },
      recorded.reason
    );
  }

  await saveSession(context.repositoryRoot, recorded.session);

  const following = nextNode({
    answers: recorded.session.answers,
    injectedNodes: recorded.session.injectedNodes
  });

  if (following.node === undefined) {
    const action = nextAction(
      `legion start --finalize --session ${recorded.session.id}`,
      "Every question has been answered."
    );
    return success(
      {
        ok: true,
        status: "complete",
        session: sessionPayload(recorded.session, following.answered, following.total),
        question: null,
        nextAction: action
      },
      `Recorded ${node.id}.\nInterview complete: ${following.answered} of ${following.total} questions answered.\n${renderNextAction(action)}`
    );
  }

  const proposal = resolved.proposals.get(following.node.slot);
  const action = nextAction(
    `legion start --answer "${following.node.id}=<value>"`,
    "Record the next answer."
  );
  return success(
    {
      ok: true,
      status: "question",
      session: sessionPayload(recorded.session, following.answered, following.total),
      question: questionPayload(following.node, proposal),
      nextAction: action
    },
    `Recorded ${node.id}.\n\n${renderQuestion({
      node: following.node,
      answered: following.answered,
      total: following.total,
      proposal,
      sessionId: recorded.session.id
    })}`
  );
}

/** `legion start --back` — undo the most recent answer. */
export async function handleBack(context: CliContext): Promise<CliResult> {
  const resolved = await resolveSession(context, { create: false });
  if (isCliResult(resolved)) return resolved;

  const stepped = stepBack(resolved.session);
  if (!stepped.ok) return usageError(stepped.reason);

  await saveSession(context.repositoryRoot, stepped.session);
  const following = nextNode({
    answers: stepped.session.answers,
    injectedNodes: stepped.session.injectedNodes
  });

  if (following.node === undefined) {
    return success(
      {
        ok: true,
        status: "complete",
        session: sessionPayload(stepped.session, following.answered, following.total),
        question: null,
        undone: stepped.nodeId
      },
      `Undid ${stepped.nodeId}. The interview is still complete.`
    );
  }

  return success(
    {
      ok: true,
      status: "question",
      session: sessionPayload(stepped.session, following.answered, following.total),
      question: questionPayload(following.node, resolved.proposals.get(following.node.slot)),
      undone: stepped.nodeId
    },
    `Undid ${stepped.nodeId}.\n\n${renderQuestion({
      node: following.node,
      answered: following.answered,
      total: following.total,
      proposal: resolved.proposals.get(following.node.slot),
      sessionId: stepped.session.id
    })}`
  );
}

/** `legion start --session-status` — report without changing anything. */
export async function handleSessionStatus(context: CliContext): Promise<CliResult> {
  // Reporting is a read. Refusing it under a graph mismatch would hide the very
  // state the operator has been told to go and inspect.
  const resolved = await resolveSession(context, { create: false, allowStaleGraph: true });
  if (isCliResult(resolved)) return resolved;

  const { session } = resolved;
  const { answered, total } = nextNode({
    answers: session.answers,
    injectedNodes: session.injectedNodes
  });

  return success(
    {
      ok: true,
      status: "session_status",
      session: sessionPayload(session, answered, total),
      answers: session.answers.map((answer) => ({
        nodeId: answer.nodeId,
        slot: answer.slot,
        source: answer.source,
        answeredAt: answer.answeredAt
      })),
      diagnostics: session.diagnostics,
      ...(resolved.notes.length === 0
        ? {}
        : { warnings: resolved.notes.map((note) => ({ code: "exploration_unavailable", message: note })) })
    },
    renderSessionStatus({
      sessionId: session.id,
      status: session.status,
      answered,
      total,
      cursor: session.cursor,
      injectedCount: session.injectedNodes.length,
      explorationRunId: session.explorationRef?.runId
    })
  );
}

/** `legion start --abort` — close a session without finalizing. */
export async function handleAbort(context: CliContext): Promise<CliResult> {
  // Aborting is the documented way out of a session pinned to an older graph,
  // so it cannot be gated on that pin. It writes no artifacts from the answers,
  // only a status, so nothing is reinterpreted under the current graph.
  const resolved = await resolveSession(context, {
    create: false,
    allowStaleGraph: true,
    proposals: false
  });
  if (isCliResult(resolved)) return resolved;

  // Only an interview in progress can be abandoned. A finalized session is the
  // provenance record every requirement's `traceRefs` point at, and overwriting
  // its status would both destroy that record and make the documented
  // `--force-roadmap` retry impossible, since finalize refuses an aborted one.
  if (resolved.session.status !== "active") {
    return usageError(
      `Session ${resolved.session.id} is already ${resolved.session.status} and cannot be aborted.`
    );
  }

  const aborted = abortSession(resolved.session);
  await saveSession(context.repositoryRoot, aborted);
  const action = nextAction("legion start", "Begin a new intake session.");
  return success(
    { ok: true, status: "aborted", session: sessionPayload(aborted, 0, 0), nextAction: action },
    `Aborted ${aborted.id}. The answers are kept on disk for reference.\n${renderNextAction(action)}`
  );
}

/**
 * `legion start --intake <file>` — answer everything at once.
 *
 * The batch entrance runs the same validators in the same order as the
 * interactive one, applying answers through the same state machine rather than
 * writing a session directly. A CI path that could produce a contract the
 * interview would have rejected is a way around the interview, not an
 * alternative to it.
 */
export async function handleBatchIntake(context: CliContext): Promise<CliResult> {
  const filePath = stringOption(context, "intake");
  if (filePath === undefined) return usageError("Provide a file as --intake <file>.");

  let parsed: unknown;
  try {
    const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(context.repositoryRoot, filePath);
    parsed = JSON.parse(await readFile(absolute, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return usageError(`Failed to read intake file ${filePath}: ${message}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return usageError("An intake file must be a JSON object mapping node IDs to answers.");
  }
  const answers = parsed as Record<string, unknown>;

  const resolved = await resolveSession(context, { create: true });
  if (isCliResult(resolved)) return resolved;

  let session = resolved.session;
  const diagnostics: IntakeDiagnostic[] = [];
  const applied: string[] = [];
  const answeredAt = nowTimestamp();

  // Driven by the graph, not by the file's key order: the next question is
  // whatever the answers so far imply, so a file that lists nodes out of order
  // still produces the same session as typing them in.
  for (;;) {
    const { node } = nextNode({ answers: session.answers, injectedNodes: session.injectedNodes });
    if (node === undefined) break;

    const raw = answers[node.id];
    if (raw === undefined) {
      if (!node.required) {
        const skipped = recordAnswer({ session, nodeId: node.id, value: "", answeredAt });
        if (skipped.ok) {
          session = skipped.session;
          continue;
        }
      }
      diagnostics.push({
        code: "missing_answer",
        message: `The intake file has no answer for ${node.id}: ${node.prompt}`,
        nodeId: node.id,
        slot: node.slot
      });
      break;
    }

    // `String(raw)` on a JSON `null` records the literal text "null", and on an
    // object "[object Object]" — both of which pass every free-text validator
    // and land in the constitution and the requirement set as if someone had
    // typed them. A value that is not an answer is refused, not stringified.
    if (raw === null || (typeof raw === "object" && !Array.isArray(raw))) {
      diagnostics.push({
        code: "invalid_answer",
        message: `The intake file's value for ${node.id} is ${raw === null ? "null" : "an object"}; answers must be text, a boolean, or a list.`,
        nodeId: node.id,
        slot: node.slot
      });
      break;
    }

    const value = typeof raw === "boolean" || Array.isArray(raw) ? raw : String(raw);
    const validated = validateAnswer(node, value as never);
    if (validated.value === undefined) {
      diagnostics.push(...validated.diagnostics);
      break;
    }

    const recorded = recordAnswer({ session, nodeId: node.id, value: validated.value, answeredAt });
    if (!recorded.ok) {
      diagnostics.push({ code: "answer_rejected", message: recorded.reason, nodeId: node.id });
      break;
    }
    session = recorded.session;
    applied.push(node.id);
  }

  await saveSession(context.repositoryRoot, session);

  const { answered, total } = nextNode({
    answers: session.answers,
    injectedNodes: session.injectedNodes
  });

  if (diagnostics.length > 0) {
    return failure(
      {
        ok: false,
        status: "incomplete",
        session: sessionPayload(session, answered, total),
        applied,
        diagnostics
      },
      `Applied ${applied.length} answer(s), then stopped.\n${renderIntakeDiagnostics(diagnostics)}`
    );
  }

  const action = nextAction(
    `legion start --finalize --session ${session.id}`,
    "Every question is answered; finalizing writes the requirement set."
  );
  return success(
    {
      ok: true,
      status: "complete",
      session: sessionPayload(session, answered, total),
      applied,
      nextAction: action
    },
    `Applied ${applied.length} answer(s); the interview is complete.\n${renderNextAction(action)}`
  );
}

type RoadmapDestination =
  | { readonly kind: "absent" }
  | { readonly kind: "file" }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Classify the roadmap destination without following it.
 *
 * `access` follows symlinks, so a dangling one reported "absent" and the write
 * created its target outside the repository; an intact one was followed
 * whenever its target happened to carry the Legion marker. `lstat` sees the
 * link itself, which is the only way to refuse it.
 */
async function classifyRoadmap(target: string): Promise<RoadmapDestination> {
  let stats;
  try {
    stats = await lstat(target);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { kind: "absent" };
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    return {
      kind: "refused",
      reason: `${ROADMAP_FILE} is a symbolic link; refusing to write through it. Remove or replace the link with a regular file.`
    };
  }
  if (!stats.isFile()) {
    return { kind: "refused", reason: `${ROADMAP_FILE} exists and is not a regular file.` };
  }
  return { kind: "file" };
}

/** `legion start --finalize` — write the typed artifacts. */
export async function handleFinalize(context: CliContext): Promise<CliResult> {
  const resolved = await resolveSession(context, { create: false });
  if (isCliResult(resolved)) return resolved;

  const session = resolved.session;
  if (session.status === "aborted") {
    return usageError(`Session ${session.id} was aborted and cannot be finalized.`);
  }

  // A finalized session can be finalized again. It has to be: when a
  // hand-written ROADMAP.md is left alone, the warning tells the operator to
  // retry with --force-roadmap, and refusing that retry would make the advice
  // impossible to follow. Re-finalizing rewrites the same artifacts from the
  // same answers, so it is a re-render rather than a second decision.
  const refinalizing = session.status === "finalized";

  // Finalize writes artifacts, so the pinned graph binds here even for a
  // session that is only being re-rendered.
  const staleGraph = graphVersionMismatch(session, { producingArtifacts: true });
  if (staleGraph !== undefined) return usageError(staleGraph);

  const { node, answered, total } = nextNode({
    answers: session.answers,
    injectedNodes: session.injectedNodes
  });
  if (node !== undefined) {
    const action = nextAction(`legion start --answer "${node.id}=<value>"`, "Answer the remaining questions.");
    return failure(
      {
        ok: false,
        status: "incomplete",
        session: sessionPayload(session, answered, total),
        question: questionPayload(node, resolved.proposals.get(node.slot)),
        nextAction: action
      },
      `${answered} of ${total} questions answered; ${node.id} is still open.\n${renderNextAction(action)}`
    );
  }

  const semantic = validateAnswerSet({ answers: session.answers });
  if (semantic.length > 0) {
    return failure(
      {
        ok: false,
        status: "invalid",
        session: sessionPayload(session, answered, total),
        diagnostics: semantic
      },
      `The interview is complete but the answers do not yet make a contract:\n${renderIntakeDiagnostics(semantic)}`
    );
  }

  const answerFor = (nodeId: string): string => {
    const answer = session.answers.find((entry) => entry.nodeId === nodeId);
    return typeof answer?.value === "string" ? answer.value : "";
  };

  const name = answerFor("project-name");
  const summary = answerFor("project-summary");
  const owner = answerFor("project-owner");

  let slug: string;
  try {
    slug = projectSchema.shape.slug.parse(stringOption(context, "slug")?.trim() ?? slugFromName(name));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return usageError(`The project name does not produce a valid slug. Pass --slug explicitly. ${message}`);
  }

  // Always the session's own creation instant. Not "now", and deliberately not
  // `--created-at` either: the documented forced-roadmap retry omits that flag,
  // so honouring it on the first finalize would make the retry write a different
  // timestamp into every requirement and change the requirement set hash — during
  // what this command calls an identical re-render. `--created-at` still selects
  // the session's timestamp when the session is created, which is where it
  // belongs.
  const createdAt = session.createdAt;
  const constitution = renderConstitution({ answers: session.answers });

  const initialized = await initProject({
    repositoryRoot: context.repositoryRoot,
    slug,
    name,
    ...(summary.length === 0 ? {} : { description: summary }),
    repository: repositoryReference(context.repositoryRoot),
    decisionOwners: [ownerActor(owner)],
    createdAt,
    constitutionTemplate: constitution
  });

  if (!initialized.ok) {
    return failure(
      { ...initialized, nextAction: nextAction("legion validate", "Repair project state, then finalize again.") },
      `Project initialization failed.\n${initialized.diagnostics.map((entry) => `  - ${entry.message}`).join("\n")}`
    );
  }

  const projectId: ProjectId = initialized.project.id;
  const notes: string[] = [];

  // `initProject` seeds the constitution only on first init. A re-finalize after
  // the constraints changed would otherwise leave the constitution describing an
  // earlier interview, which is worse than not writing it at all: the document
  // the authority order puts above generated plans would be quietly stale.
  // An interview that reports success while `project.json` keeps a different
  // name or owner is worse than one that refuses: downstream context packs and
  // escalation read the manifest, so the two would disagree silently about who
  // owns the project.
  if (initialized.status === "already_initialized") {
    const existing = initialized.project;
    const conflicts: string[] = [];
    if (existing.name !== name) conflicts.push(`name is "${existing.name}", the interview says "${name}"`);
    if (summary.length > 0 && existing.description !== summary) {
      conflicts.push("summary differs");
    }
    const owners = initialized.manifest.project.policy.decisionOwners ?? [];
    if (
      owner.length > 0 &&
      owners.length > 0 &&
      !owners.some((entry) => entry.id === owner || entry.displayName === owner)
    ) {
      const named = owners.map((entry) => entry.displayName ?? entry.id).join(", ");
      conflicts.push(`decision owner is ${named}, the interview says "${owner}"`);
    }
    if (conflicts.length > 0) {
      return failure(
        {
          ok: false,
          status: "identity_conflict",
          session: sessionPayload(session, answered, total),
          project: existing,
          diagnostics: conflicts.map((message) => ({ code: "identity_conflict", message }))
        },
        [
          "This project was already initialized and the interview disagrees with it:",
          ...conflicts.map((message) => `  - ${message}`),
          "legion start --finalize does not rewrite an existing project identity. Either answer to match, or start from a clean project."
        ].join("\n")
      );
    }
  }

  if (initialized.status === "already_initialized") {
    const updated = await updateConstitution({
      repositoryRoot: context.repositoryRoot,
      expectedManifestRevision: initialized.manifest.revision,
      content: constitution,
      updatedAt: createdAt
    });
    if (!updated.ok) {
      notes.push(
        `The constitution could not be updated: ${updated.diagnostics.map((entry) => entry.message).join("; ")}`
      );
    }
  }

  const requirements = buildRequirements({
    answers: session.answers,
    projectId,
    createdAt,
    schemaVersion: LEGION_PROTOCOL_VERSION,
    intakeSessionPath: intakeSessionArtifactPath(session.id)
  });

  const written = await writeRequirementSet({
    repositoryRoot: context.repositoryRoot,
    projectId,
    requirements,
    intakeSessionId: session.id,
    graphVersion: session.graphVersion,
    createdAt
  });

  const roadmapPath = path.join(context.repositoryRoot, ROADMAP_FILE);
  const roadmap = renderRoadmap({
    projectName: name,
    answers: session.answers,
    requirements,
    intakeSessionId: session.id
  });

  let roadmapWritten = false;
  const destination = await classifyRoadmap(roadmapPath);
  if (destination.kind === "refused") {
    notes.push(destination.reason);
  } else if (destination.kind === "file") {
    const existing = await readFile(roadmapPath, "utf8");
    // Overwriting a hand-written roadmap would destroy work this command never
    // authored. Only a roadmap this command rendered is safe to replace.
    if (existing.includes(ROADMAP_MARKER) || hasFlag(context, "force-roadmap")) {
      await writeFile(roadmapPath, roadmap, "utf8");
      roadmapWritten = true;
    } else {
      notes.push(
        `${ROADMAP_FILE} already exists and was not written by legion start; it was left alone. Replace it with: legion start --finalize --session ${session.id} --force-roadmap`
      );
    }
  } else {
    await writeFile(roadmapPath, roadmap, "utf8");
    roadmapWritten = true;
  }

  if (refinalizing) {
    notes.unshift(`Session ${session.id} was already finalized; its artifacts were rewritten.`);
  }

  const finalized = withDiagnostics(finalizeSession(session, projectId), notes);
  await saveSession(context.repositoryRoot, finalized);

  const action = nextAction("legion plan 1", "The requirement set is written; plan the first phase.");
  const humanLines = [
    `${projectId}: ${initialized.status}.`,
    `Wrote ${requirements.length} requirement(s) to ${written.indexPath}.`,
    `Requirement set hash: ${written.set.requirementSetHash}.`,
    roadmapWritten ? `Rendered ${ROADMAP_FILE}.` : `${ROADMAP_FILE} was left unchanged.`,
    ...notes.map((note) => `warning: ${note}`),
    renderNextAction(action)
  ];

  return success(
    {
      ok: true,
      status: "finalized",
      session: sessionPayload(finalized, answered, total),
      project: initialized.project,
      projectStatus: initialized.status,
      requirementSet: {
        indexPath: written.indexPath,
        requirementSetHash: written.set.requirementSetHash,
        count: requirements.length,
        paths: written.requirementPaths
      },
      roadmap: { path: ROADMAP_FILE, written: roadmapWritten },
      graphVersion: INTAKE_GRAPH_VERSION,
      ...(notes.length === 0 ? {} : { warnings: notes.map((note) => ({ code: "finalize_note", message: note })) }),
      nextAction: action
    },
    humanLines.join("\n")
  );
}
