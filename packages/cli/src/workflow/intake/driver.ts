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

import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  initProject,
  readRequirementSet,
  updateConstitution,
  writeRequirementSet
} from "@legion/artifacts";
import {
  LEGION_PROTOCOL_VERSION,
  projectSchema,
  type IntakeDraft,
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
import {
  AUTHORED_BUILD_CONFIGURATION,
  AUTHORED_DEPENDENCY_MANIFESTS,
  AUTHORED_IGNORED_DIRECTORIES,
  DEFAULT_INTAKE_DRAFT_INPUT_PATH,
  isDocumentationFile
} from "../authored-source.js";
import { humanDecisionAction, nextAction, renderNextAction } from "../render.js";
import { mintPinnedReferences } from "../pinned-references.js";
import {
  buildRequirements,
  declaredSurfacePaths,
  enforcementPolicy,
  renderConstitution,
  renderRoadmap,
  resolvedOpenQuestions
} from "./finalize.js";
import { INTAKE_GRAPH_VERSION, findNode, nextNode, type IntakeNode } from "./graph.js";
import { loadExploration, listExplorations } from "./exploration-source.js";
import {
  acceptStagedDraft,
  degradedCoverageWarning,
  discardStagedDraft,
  findActiveDraft,
  inspectActiveDraftCandidates,
  prepareIntakePreflight,
  pendingAcceptanceRecovered,
  publishDraftReview,
  recoverIntakeLifecycleArtifacts,
  resolveReviewedDraftDecision,
  stageIntakeDraft,
  type IntakePreflightState
} from "./lifecycle.js";
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
const STAGE_DRAFT_COMMAND = `legion start --stage-draft ${DEFAULT_INTAKE_DRAFT_INPUT_PATH}`;

interface ResolvedSession {
  readonly session: IntakeSession;
  readonly proposals: ReadonlyMap<string, ExplorationProposal>;
  readonly created: boolean;
  /** Non-fatal notes about the seeding exploration, surfaced to the operator. */
  readonly notes: readonly string[];
  readonly preflight?: IntakePreflightState;
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
 * Refuse an option supplied without its value.
 *
 * The parser stores `true` for `--session` with nothing after it, and
 * `stringOption` reports that as absent — so the command silently fell through
 * to a default. `legion start --abort --session --json` could abort a different
 * interview than the operator named, and `--from-exploration` with no run ID
 * quietly started an unseeded one.
 *
 * Checked as a set rather than per flag. Fixing `--session` alone left
 * `--from-exploration` broken in exactly the same way, which is the recurring
 * shape of this PR's findings: the case gets closed and the class does not.
 */
const VALUE_REQUIRED_OPTIONS = ["session", "from-exploration", "intake", "answer", "slug", "node", "goal", "map-failed"] as const;

function valuelessOption(context: CliContext): CliResult | undefined {
  for (const key of VALUE_REQUIRED_OPTIONS) {
    if (context.args.options.get(key) === true) {
      return usageError(`Missing required value for --${key}.`);
    }
  }
  return undefined;
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
    readonly automaticExploration?: boolean;
    readonly preparation?: boolean;
  }
): Promise<ResolvedSession | CliResult> {
  const wantsProposals = options.proposals !== false;

  const missingValue = valuelessOption(context);
  if (missingValue !== undefined) return missingValue;

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

  const explicitExplorationRunId = stringOption(context, "from-exploration");
  const withoutExploration = hasFlag(context, "without-exploration");
  if (explicitExplorationRunId !== undefined && withoutExploration) {
    return usageError("--from-exploration and --without-exploration are mutually exclusive.");
  }
  const explicitlyLoaded = explicitExplorationRunId === undefined
    ? undefined
    : await loadExploration(context.repositoryRoot, explicitExplorationRunId);
  if (explicitlyLoaded !== undefined && !explicitlyLoaded.ok) return usageError(explicitlyLoaded.reason);
  const found = await findActiveSession(context.repositoryRoot);
  // A corrupt session stops everything rather than being stepped over: resuming
  // an older interview, or quietly opening a new one, would have the operator
  // answering a different session than the record on disk describes.
  if (!found.ok) return failure({ ok: false, status: "invalid_session", diagnostics: [{ code: "corrupt_session", message: found.reason }] }, found.reason);

  const active = found.session;
  if (active !== undefined) {
    if (options.preparation === true) {
      const recovery = await recoverIntakeLifecycleArtifacts(context.repositoryRoot);
      if (recovery === undefined) {
        const diagnostics = [{
          code: "pending_acceptance_blocked",
          message: "Pending acceptance state could not be inspected under the intake transition lock. Retry after the current transition completes."
        }];
        return failure({ ok: false, status: "rejected", diagnostics }, diagnostics[0]!.message);
      }
      if (!recovery.ok) {
        return failure(
          { ok: false, status: "rejected", diagnostics: recovery.diagnostics },
          recovery.diagnostics.map((diagnostic) => diagnostic.message).join(" ")
        );
      }
      if (recovery.rolledBackDraftIds.length > 0) {
        const diagnostic = pendingAcceptanceRecovered(recovery.rolledBackDraftIds);
        return failure({ ok: false, status: "rejected", diagnostics: [diagnostic] }, diagnostic.message);
      }
    }
    // `--from-exploration` only applies at session creation, and the no-argument
    // start prints exactly this command when it finds explorations. Resuming
    // before reading the option meant following that advice silently discarded
    // the chosen exploration — every proposal and every open question with it.
    const explicitEntityRunId = explicitlyLoaded?.ok === true
      ? explicitlyLoaded.loaded.exploration.runId
      : undefined;
    if (explicitEntityRunId !== undefined && active.explorationRef?.runId !== explicitEntityRunId) {
      if (active.answers.length > 0) {
        return usageError(
          `Session ${active.id} is already in progress with ${active.answers.length} answer(s), and seeding only applies when a session is created. ` +
            `Run legion start --abort --session ${active.id} first if you want to restart from exploration ${explicitExplorationRunId}.`
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

  const draftCandidates = await inspectActiveDraftCandidates(context.repositoryRoot);
  if (!draftCandidates.ok) {
    return failure(
      { ok: false, status: "rejected", diagnostics: draftCandidates.diagnostics },
      "Intake draft artifacts must be repaired before preparation can continue."
    );
  }

  if (!options.create) {
    return usageError(
      "There is no active intake session. Run legion start to begin one, or pass --session <id>."
    );
  }

  const createdAt = createdAtOption(context) ?? nowTimestamp();
  const explicitGoal = stringOption(context, "goal")?.trim();
  const mapFailure = stringOption(context, "map-failed")?.trim();
  if (explicitGoal === "") return usageError("Invalid --goal value. Provide a non-empty initiative.");
  if (mapFailure === "") return usageError("Invalid --map-failed value. Provide the map failure diagnostic.");

  const preflight = await prepareIntakePreflightForCli({
    repositoryRoot: context.repositoryRoot,
    createdAt,
    ...(explicitExplorationRunId === undefined ? {} : { explicitRunId: explicitExplorationRunId }),
    withoutExploration: withoutExploration || (options.automaticExploration === false && explicitExplorationRunId === undefined),
    ...(explicitGoal === undefined ? {} : { explicitGoal }),
    ...(mapFailure === undefined ? {} : { mapFailure })
  });
  if (isCliResult(preflight)) return preflight;
  if (preflight.activeDraftId !== undefined) {
    const stagedDraft = await findActiveDraft(context.repositoryRoot);
    const explicitPreparationChange = explicitGoal !== undefined || mapFailure !== undefined ||
      explicitExplorationRunId !== undefined || withoutExploration;
    if (!explicitPreparationChange && stagedDraft !== undefined) {
      const artifactPath = `.legion/project/intake/drafts/${stagedDraft.id}.json`;
      const reviewed = await publishDraftReview({
        repositoryRoot: context.repositoryRoot,
        draftId: stagedDraft.id,
        updatedAt: createdAt
      });
      if (!reviewed.ok) {
        return failure(
          {
            ok: false,
            status: "rejected",
            preflight,
            draftId: stagedDraft.id,
            diagnostics: reviewed.diagnostics
          },
          `Intake draft ${stagedDraft.id} must be revised before it can be reviewed or accepted.`
        );
      }
      const review = draftReviewPayload({
        draft: reviewed.draft,
        artifactPath,
        draftSha256: reviewed.review.draftSha256,
        preflight
      });
      return success(review.payload, review.human);
    }
    return failure(
      {
        ok: false,
        status: "rejected",
        preflight,
        draftId: preflight.activeDraftId,
        diagnostics: preflight.diagnostics
      },
      `Intake draft ${preflight.activeDraftId} is staged for review; accept or revise it before creating a session.`
    );
  }
  const explorationRunId = withoutExploration
    ? undefined
    : explicitExplorationRunId ?? (options.automaticExploration === false ? undefined : preflight.selectedExplorationRunId);
  if (explicitExplorationRunId !== undefined && explorationRunId === undefined) {
    const message = preflight.diagnostics.find((entry) => entry.runId === explicitExplorationRunId)?.message
      ?? `Exploration ${explicitExplorationRunId} is unavailable.`;
    return usageError(message);
  }
  if (options.preparation !== false) return preparationResult(context.repositoryRoot, preflight);

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
    return {
      session: seeded.session,
      proposals: seeded.proposals,
      created: true,
      notes: preflight.diagnostics.map((entry) => entry.message),
      preflight
    };
  } catch (error) {
    // The claim only means something once a session sits behind it. Releasing
    // it keeps a failure here from poisoning every later invocation.
    await releaseSessionId(context.repositoryRoot, sessionId);
    throw error;
  }
}

function isCliResult(value: object): value is CliResult {
  return "exitCode" in value;
}

async function prepareIntakePreflightForCli(
  input: Parameters<typeof prepareIntakePreflight>[0]
): Promise<IntakePreflightState | CliResult> {
  try {
    return await prepareIntakePreflight(input);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    if (!["EEXIST", "ELEASELOST", "EPENDINGACCEPTANCEBLOCKED", "EPENDINGACCEPTANCERECOVERED"].includes(code ?? "")) throw error;
    const diagnostic = code === "EEXIST"
      ? {
          code: "intake_transition_in_progress",
          message: "Another intake transition owns preparation state; retry after it completes."
        }
      : code === "ELEASELOST"
        ? {
            code: "intake_transition_lease_lost",
            message: "Preparation ownership changed before its durable update; no preflight state was published."
          }
        : code === "EPENDINGACCEPTANCERECOVERED"
          ? {
              code: "pending_acceptance_recovered",
              message: error instanceof Error ? error.message : "Interrupted draft acceptance was recovered; retry preparation explicitly."
            }
          : {
              code: "pending_acceptance_blocked",
              message: error instanceof Error ? error.message : "Pending draft acceptance must be repaired before preparation can continue."
            };
    return failure(
      { ok: false, status: "rejected", diagnostics: [diagnostic] },
      diagnostic.message
    );
  }
}

/** `legion start` / `legion start --next` — emit the current question. */
export async function handleNextQuestion(context: CliContext): Promise<CliResult> {
  // Bare start is the preparation entrance. `--next` and the established
  // explicit exploration entrance retain the legacy interview driver for
  // callers that already own their input collection; generated hosts use bare
  // start and therefore cannot bypass the CLI-owned preparation loop.
  const preparation = !hasFlag(context, "next") && !context.args.options.has("from-exploration");
  const resolved = await resolveSession(context, { create: true, preparation });
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
  // The session is named explicitly. With concurrent starts now preserved rather
  // than overwritten, "the newest active session" and "the session that asked
  // this question" are no longer the same thing, so a follow-up that omits it
  // can record an answer into a different interview.
  const action = nextAction(
    `legion start --session ${session.id} --answer "${node.id}=<value>"`,
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
      ...(resolved.preflight === undefined ? {} : { preflight: resolved.preflight }),
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

const PREPARATION_SOURCE_CLASSES = [
  "README and product documentation",
  "dependency manifests and scripts",
  "application and library entry points",
  "configuration",
  "tests",
  "CI commands"
] as const;

const PREPARATION_PROPOSALS = [
  "compatibility obligations",
  "acceptance criteria",
  "executable proof commands",
  "protected tests",
  "constraints",
  "verification defaults",
  "risk indicators"
] as const;

interface BoundedReviewBounds {
  readonly maxFiles: 24;
  readonly maxDepth: 4;
  readonly selectionOrder: typeof PREPARATION_SOURCE_CLASSES;
  readonly selectedPaths: readonly string[];
}

async function boundedReviewBounds(repositoryRoot: string): Promise<BoundedReviewBounds> {
  const candidates: Array<{ readonly path: string; readonly priority: number }> = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory() && AUTHORED_IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(repositoryRoot, absolute).replace(/\\/gu, "/");
      const basename = entry.name.toLowerCase();
      const segments = relative.toLowerCase().split("/");
      let priority: number | undefined;
      if (basename.startsWith("readme") || isDocumentationFile(relative)) priority = 0;
      else if (AUTHORED_DEPENDENCY_MANIFESTS.has(basename)) priority = 1;
      else if (/^(?:index|main|app|server|cli)\.[a-z0-9]+$/u.test(basename)) priority = 2;
      else if (AUTHORED_BUILD_CONFIGURATION.has(basename) || basename.includes("config")) priority = 3;
      else if (segments.some((segment) => ["test", "tests", "spec", "specs", "__tests__"].includes(segment)) || /\.(?:test|spec)\./u.test(basename)) priority = 4;
      else if (relative.toLowerCase().startsWith(".github/workflows/")) priority = 5;
      if (priority !== undefined) candidates.push({ path: relative, priority });
    }
  }
  await visit(repositoryRoot, 0);
  const ordered = candidates.sort((left, right) => left.priority - right.priority || left.path.localeCompare(right.path));
  const selected: Array<{ readonly path: string; readonly priority: number }> = [];
  const selectedPaths = new Set<string>();
  for (let priority = 0; priority < PREPARATION_SOURCE_CLASSES.length; priority += 1) {
    const representative = ordered.find((candidate) => candidate.priority === priority);
    if (representative === undefined) continue;
    selected.push(representative);
    selectedPaths.add(representative.path);
  }
  for (const candidate of ordered) {
    if (selected.length >= 24) break;
    if (selectedPaths.has(candidate.path)) continue;
    selected.push(candidate);
    selectedPaths.add(candidate.path);
  }
  return {
    maxFiles: 24,
    maxDepth: 4,
    selectionOrder: PREPARATION_SOURCE_CLASSES,
    selectedPaths: selected.map((entry) => entry.path)
  };
}

function preparationReview(bounds?: BoundedReviewBounds) {
  return {
    scope: "initiative",
    inferencePrecedence: [
      "explicit_user_statement_or_edit",
      "selected_exploration",
      "repository_inference"
    ],
    architectureAnalysis: bounds === undefined ? "full" : "full_synthesis",
    repositoryCoverage: bounds === undefined ? "full" : "bounded_degraded",
    ...(bounds === undefined ? {} : { bounds }),
    sourceClasses: PREPARATION_SOURCE_CLASSES,
    propose: PREPARATION_PROPOSALS,
    unrelatedBehavior: "architecture_context_only",
    conflicts: "unresolved_questions",
    unsupportedAssumptions: "unresolved_questions",
    absentNonGoalsAndConstraints: "unresolved_questions"
  } as const;
}

function stablePreflightPayload(
  preflight: IntakePreflightState,
  preparation: Record<string, unknown>
): Record<string, unknown> {
  return {
    preflight,
    projectMode: preflight.projectMode,
    exploration: {
      intent: preflight.explorationSelectionIntent,
      selectedRunId: preflight.selectedExplorationRunId ?? null,
      compatible: preflight.compatibleExplorations
    },
    mapState: preflight.map,
    activeDraft: preflight.activeDraftId === undefined
      ? null
      : { id: preflight.activeDraftId, status: "draft_review" },
    activeSession: preflight.activeSessionId === undefined
      ? null
      : { id: preflight.activeSessionId, status: "interview" },
    initiative: preflight.initiative ?? null,
    reviewContract: "review" in preparation
      ? preparation["review"]
      : preparationReview(),
    preparation,
    warnings: preflight.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message
    })),
    diagnostics: preflight.diagnostics
  };
}

type DraftReviewEntry = IntakeDraft["proposedAnswers"][number];

function reviewEntries(draft: IntakeDraft, predicate: (slot: string) => boolean): readonly DraftReviewEntry[] {
  return draft.proposedAnswers.filter((answer) => predicate(answer.slot));
}

function evidenceSummary(draft: IntakeDraft) {
  const references = [
    ...draft.explorationRefs,
    ...(draft.codebaseMapRef === undefined ? [] : [draft.codebaseMapRef]),
    ...draft.proposedAnswers.flatMap((answer) => answer.evidenceRefs),
    ...draft.unresolvedNodes.flatMap((node) => node.evidenceRefs)
  ];
  const byKind = { exploration: 0, "codebase-map": 0, "repository-file": 0 };
  for (const reference of references) byKind[reference.kind] += 1;
  const unique = [...new Map(references.map((reference) => [JSON.stringify(reference), reference])).values()];
  return { totalReferences: references.length, uniqueReferences: unique.length, byKind, references: unique };
}

function confidenceSummary(draft: IntakeDraft) {
  const summary = { researched: 0, inferred: 0, assumed: 0 };
  for (const answer of draft.proposedAnswers) summary[answer.confidence] += 1;
  return summary;
}

function draftEntityReference(artifactPath: string, draftSha256: string) {
  return {
    path: artifactPath,
    sha256: draftSha256
  };
}

function groupedDraftReview(draft: IntakeDraft) {
  const projectAndProblem = reviewEntries(draft, (slot) =>
    slot.startsWith("project.") || slot.startsWith("problem."));
  const requirements = reviewEntries(draft, (slot) =>
    /^requirements\.\d+\.(?:statement|priority|category)$/u.test(slot));
  const criteriaAndProofs = reviewEntries(draft, (slot) =>
    /^requirements\.\d+\.criteria\.\d+\./u.test(slot));
  const constraints = reviewEntries(draft, (slot) =>
    slot.startsWith("constraints.") || slot === "preferences.notes");
  const nonGoals = reviewEntries(draft, (slot) => slot === "scope.non-goals");
  const risk = reviewEntries(draft, (slot) => slot.startsWith("risk."));
  const budget = reviewEntries(draft, (slot) => slot.startsWith("budget."));
  const verification = reviewEntries(draft, (slot) => slot === "preferences.verification");
  const grouped = new Set([
    ...projectAndProblem, ...requirements, ...criteriaAndProofs, ...constraints,
    ...nonGoals, ...risk, ...budget, ...verification
  ].map((entry) => entry.nodeId));
  const additionalAnswers = draft.proposedAnswers.filter((answer) =>
    !grouped.has(answer.nodeId) && !answer.slot.endsWith(".more"));
  return {
    projectAndProblem,
    requirements,
    criteriaAndProofs,
    constraints,
    nonGoals,
    defaults: { risk, budget, verification },
    additionalAnswers,
    evidence: evidenceSummary(draft),
    confidence: confidenceSummary(draft),
    diagnostics: draft.diagnostics,
    unresolved: draft.unresolvedNodes
  };
}

function renderReviewValue(value: DraftReviewEntry["value"]): string {
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function renderReviewGroup(label: string, entries: readonly DraftReviewEntry[]): string[] {
  return [label, ...(entries.length === 0
    ? ["  none recorded"]
    : entries.map((entry) => `  ${entry.slot}: ${renderReviewValue(entry.value)} [${entry.confidence}]`))];
}

function draftReviewHuman(draft: IntakeDraft, review: ReturnType<typeof groupedDraftReview>): string {
  const lines = [
    `Draft ${draft.id} is staged and unchanged until an explicit decision.`,
    "",
    ...renderReviewGroup("Project and problem", review.projectAndProblem),
    "",
    ...renderReviewGroup("Requirements", review.requirements),
    "",
    ...renderReviewGroup("Criteria and proofs", review.criteriaAndProofs),
    "",
    ...renderReviewGroup("Constraints", review.constraints),
    "",
    ...renderReviewGroup("Non-goals", review.nonGoals),
    "",
    "Risk, budget, and verification defaults",
    ...renderReviewGroup("  Risk", review.defaults.risk).slice(1).map((line) => `  ${line}`),
    ...renderReviewGroup("  Budget", review.defaults.budget).slice(1).map((line) => `  ${line}`),
    ...renderReviewGroup("  Verification", review.defaults.verification).slice(1).map((line) => `  ${line}`),
    ...(review.additionalAnswers.length === 0
      ? []
      : ["", ...renderReviewGroup("Additional reviewed answers", review.additionalAnswers)]),
    "",
    "Evidence and confidence",
    `  ${review.evidence.totalReferences} evidence reference(s); researched ${review.confidence.researched}, inferred ${review.confidence.inferred}, assumed ${review.confidence.assumed}`,
    ...(review.evidence.references.length === 0
      ? ["  no cited evidence"]
      : review.evidence.references.map((reference) => {
          const anchor = "anchor" in reference && reference.anchor !== undefined ? ` @ ${reference.anchor}` : "";
          const source = reference.kind === "codebase-map" ? ` source:${reference.sourceFingerprint}` : "";
          const run = reference.kind === "exploration" ? ` run:${reference.runId}` : "";
          return `  ${reference.kind}: ${reference.artifact.path} ${reference.artifact.sha256}${anchor}${run}${source}`;
        })),
    "",
    "Diagnostics and unresolved items",
    ...(review.diagnostics.length === 0 ? ["  no diagnostics"] : review.diagnostics.map((entry) => `  warning: ${entry}`)),
    ...(review.unresolved.length === 0
      ? ["  no declared unresolved items"]
      : review.unresolved.map((entry) => `  ${entry.nodeId} (${entry.slot}): ${entry.question}`)),
    "",
    "Decision required",
    `  Accept: legion start --accept-draft`,
    `  Revise: ${STAGE_DRAFT_COMMAND}`,
    `  Discard: legion start --discard-draft`
  ];
  return lines.join("\n");
}

function draftReviewPayload(input: {
  readonly draft: IntakeDraft;
  readonly artifactPath: string;
  readonly draftSha256: string;
  readonly preflight: IntakePreflightState;
  readonly replacesDraft?: IntakeDraft;
}): { readonly payload: Record<string, unknown>; readonly human: string } {
  const review = groupedDraftReview(input.draft);
  const entity = draftEntityReference(input.artifactPath, input.draftSha256);
  const action = humanDecisionAction(
    "The displayed immutable draft requires an explicit human accept, revise, or discard decision.",
    [
      { id: "accept", command: "legion start --accept-draft" },
      { id: "revise", command: STAGE_DRAFT_COMMAND },
      { id: "discard", command: "legion start --discard-draft" }
    ]
  );
  return {
    payload: {
      ok: true,
      status: "draft_review",
      draft: input.draft,
      draftSummary: {
        id: input.draft.id,
        status: input.draft.status,
        graphVersion: input.draft.graphVersion,
        projectMode: input.draft.projectMode,
        initiative: input.draft.initiative,
        entity
      },
      artifactPath: input.artifactPath,
      preflight: input.preflight,
      review,
      unresolvedItems: review.unresolved,
      warnings: input.draft.diagnostics.map((message) => ({ code: "draft_diagnostic", message })),
      diagnostics: [],
      confidenceSummary: review.confidence,
      evidenceSummary: review.evidence,
      actions: {
        accept: { command: "legion start --accept-draft", draftId: input.draft.id },
        revise: { command: STAGE_DRAFT_COMMAND, replacesDraftId: input.draft.id },
        discard: { command: "legion start --discard-draft", draftId: input.draft.id }
      },
      ...(input.replacesDraft === undefined ? {} : {
        replacesDraft: { id: input.replacesDraft.id, status: input.replacesDraft.status }
      }),
      nextAction: action
    },
    human: draftReviewHuman(input.draft, review)
  };
}

async function preparationResult(repositoryRoot: string, preflight: IntakePreflightState): Promise<CliResult> {
  const mapState = "freshness" in preflight.map ? preflight.map : undefined;
  const mapReadError = "error" in preflight.map ? preflight.map.error : undefined;
  const mapSkipped = preflight.projectMode !== "brownfield";
  const mapFailure = preflight.mapFailure?.message ?? mapReadError;
  const mapAction = mapSkipped
    ? { action: "skip", coverage: "not_applicable", scope: "." }
    : mapState?.freshness === "fresh"
      ? {
          action: "use_fresh",
          coverage: "full",
          scope: ".",
          sourceFingerprint: mapState.sourceFingerprint,
          ...(mapState.mapArtifact === null || mapState.mapArtifact === undefined ? {} : { artifact: mapState.mapArtifact })
        }
      : mapFailure !== undefined
        ? {
            action: "bounded_direct_review",
            coverage: "degraded",
            scope: ".",
            warning: degradedCoverageWarning(mapFailure)
          }
        : { action: "refresh", coverage: "pending", scope: "." };

  if (preflight.initiative === undefined) {
    const action = nextAction(
      "legion start --goal \"<initiative>\"",
      "One initiative is required before repository synthesis."
    );
    const preparation = {
      status: "initiative_required",
      initiativeQuestion: {
        kind: "free-text",
        prompt: "What initiative should this project intake prepare?"
      },
      map: mapAction
    };
    return success(
      { ok: true, status: "preflight", ...stablePreflightPayload(preflight, preparation), nextAction: action },
      `What initiative should this project intake prepare?\n${renderNextAction(action)}`
    );
  }

  if (!mapSkipped && mapAction.action === "refresh") {
    const action = nextAction(
      "legion map --refresh --scope .",
      `Brownfield intake requires a fresh full-project map; the current map is ${mapState?.freshness ?? "unreadable"}.`
    );
    const preparation = {
      status: "map_refresh_required",
      initiative: preflight.initiative,
      map: mapAction
    };
    return success(
      { ok: true, status: "preflight", ...stablePreflightPayload(preflight, preparation), nextAction: action },
      `Brownfield preparation requires a fresh full-project map.\n${renderNextAction(action)}`
    );
  }

  const action = nextAction(
    STAGE_DRAFT_COMMAND,
    "Review the repository against the initiative, compose a protocol-valid intake draft with evidence hashes, and stage it through the CLI."
  );
  const degradedBounds = mapAction.action === "bounded_direct_review"
    ? await boundedReviewBounds(repositoryRoot)
    : undefined;
  const preparation = {
    status: "repository_review_required",
    initiative: preflight.initiative,
    map: mapAction,
    review: preparationReview(degradedBounds)
  };
  return success(
    { ok: true, status: "preflight", ...stablePreflightPayload(preflight, preparation), nextAction: action },
    `${mapAction.action === "bounded_direct_review" ? `${mapAction.warning}\n` : ""}Review the repository against the initiative and stage an intake draft.\n${renderNextAction(action)}`
  );
}

interface StageDraftHooks {
  readonly afterPreparationBeforeStage?: () => Promise<void> | void;
}

/** Stage a protocol intake draft without allocating an interview session. */
export async function handleStageDraft(
  context: CliContext,
  hooks: StageDraftHooks = {}
): Promise<CliResult> {
  const draftFile = stringOption(context, "draft") ?? stringOption(context, "stage-draft");
  if (draftFile === undefined) return usageError("Provide a draft file with --draft <file>.");
  const foundSession = await findActiveSession(context.repositoryRoot);
  if (!foundSession.ok) return usageError(foundSession.reason);
  if (foundSession.session !== undefined) {
    const diagnostics = [{
      code: "active_session",
      message: `Session ${foundSession.session.id} is already active; accepted draft answers must be revised through the interview, not by staging another draft.`
    }];
    return failure(
      { ok: false, status: "rejected", diagnostics },
      diagnostics[0]!.message
    );
  }
  const createdAt = createdAtOption(context) ?? nowTimestamp();
  const explicitRunId = stringOption(context, "from-exploration");
  const withoutExploration = hasFlag(context, "without-exploration");
  const explicitGoal = stringOption(context, "goal")?.trim();
  const mapFailure = stringOption(context, "map-failed")?.trim();
  if (explicitGoal === "") return usageError("Invalid --goal value. Provide a non-empty initiative.");
  if (mapFailure === "") return usageError("Invalid --map-failed value. Provide the map failure diagnostic.");
  if (explicitRunId !== undefined && withoutExploration) {
    return usageError("Use either --from-exploration <id> or --without-exploration, not both.");
  }
  if (explicitRunId !== undefined || withoutExploration || explicitGoal !== undefined || mapFailure !== undefined) {
    const overridePreflight = await prepareIntakePreflightForCli({
      repositoryRoot: context.repositoryRoot,
      createdAt,
      ...(explicitRunId === undefined ? {} : { explicitRunId }),
      ...(withoutExploration ? { withoutExploration: true } : {}),
      ...(explicitGoal === undefined ? {} : { explicitGoal }),
      ...(mapFailure === undefined ? {} : { mapFailure })
    });
    if (isCliResult(overridePreflight)) return overridePreflight;
    if (explicitRunId !== undefined) {
      const loaded = await loadExploration(context.repositoryRoot, explicitRunId);
      const canonicalRunId = loaded.ok ? loaded.loaded.candidate.runId : explicitRunId;
      const blocking = overridePreflight.diagnostics.filter((diagnostic) =>
        diagnostic.runId === canonicalRunId && diagnostic.code !== "competing_candidate"
      );
      const selectedMatches = loaded.ok && overridePreflight.selectedExplorationRunId === canonicalRunId;
      if (!selectedMatches || blocking.length > 0) {
        const diagnostics = blocking.length > 0
          ? blocking.filter((diagnostic, index) => blocking.findIndex((candidate) =>
              candidate.code === diagnostic.code && candidate.message === diagnostic.message
            ) === index)
          : [{
              code: "preflight_exploration_mismatch",
              message: `Explicit exploration ${explicitRunId} did not resolve to a compatible readable start handoff.`
            }];
        return failure(
          { ok: false, status: "rejected", preflight: overridePreflight, diagnostics },
          `Explicit exploration ${explicitRunId} cannot be used to stage this draft.`
        );
      }
    }
  }
  await hooks.afterPreparationBeforeStage?.();
  const staged = await stageIntakeDraft({ repositoryRoot: context.repositoryRoot, draftFile, createdAt });
  if (!staged.ok) {
    return failure({ ok: false, status: "rejected", diagnostics: staged.diagnostics }, "The intake draft needs revision before it can be staged.");
  }
  const preflight = await prepareIntakePreflightForCli({ repositoryRoot: context.repositoryRoot, createdAt });
  if (isCliResult(preflight)) return preflight;
  const reviewed = await publishDraftReview({ repositoryRoot: context.repositoryRoot, draftId: staged.draft.id, updatedAt: createdAt });
  if (!reviewed.ok) {
    return failure({ ok: false, status: "rejected", draftId: staged.draft.id, diagnostics: reviewed.diagnostics }, "The staged draft could not be published as the active review.");
  }
  const review = draftReviewPayload({
    draft: reviewed.draft,
    artifactPath: staged.artifactPath,
    draftSha256: reviewed.review.draftSha256,
    preflight,
    ...(staged.replacesDraft === undefined ? {} : { replacesDraft: staged.replacesDraft })
  });
  return success(review.payload, review.human);
}

/** Accept one staged draft into one fully populated session record. */
export async function handleAcceptDraft(context: CliContext): Promise<CliResult> {
  const explicitDraftId = stringOption(context, "accept-draft");
  const createdAt = createdAtOption(context) ?? nowTimestamp();
  const accepted = await acceptStagedDraft({
    repositoryRoot: context.repositoryRoot,
    createdAt,
    requireReviewed: true,
    ...(explicitDraftId === undefined ? {} : { draftId: explicitDraftId })
  });
  if (!accepted.ok) {
    return failure(
      {
        ok: false,
        status: "rejected",
        ...(explicitDraftId === undefined ? {} : { draftId: explicitDraftId }),
        diagnostics: accepted.diagnostics
      },
      explicitDraftId === undefined ? "The intake draft remains in review." : `Draft ${explicitDraftId} remains in review.`
    );
  }
  const draftId = accepted.draft.id;
  return success(
    { ok: true, status: accepted.status, draft: accepted.draft, session: accepted.session },
    `Accepted intake draft ${draftId} into session ${accepted.session.id}.`
  );
}

/** Discard the active (or compatibility-ID) draft without creating a session. */
export async function handleDiscardDraft(context: CliContext): Promise<CliResult> {
  const explicitDraftId = stringOption(context, "discard-draft");
  const target = await resolveReviewedDraftDecision({
    repositoryRoot: context.repositoryRoot,
    ...(explicitDraftId === undefined ? {} : { explicitDraftId })
  });
  if (!target.ok) return failure({ ok: false, status: "rejected", diagnostics: target.diagnostics }, "A displayed draft review is required before discard.");
  const draftId = target.draftId;
  const discarded = await discardStagedDraft({ repositoryRoot: context.repositoryRoot, draftId, requireReviewed: true });
  if (!discarded.ok) {
    return failure(
      { ok: false, status: "rejected", draftId, diagnostics: discarded.diagnostics },
      `Draft ${draftId} remains in review.`
    );
  }
  const createdAt = createdAtOption(context) ?? nowTimestamp();
  const preflight = await prepareIntakePreflightForCli({ repositoryRoot: context.repositoryRoot, createdAt });
  if (isCliResult(preflight)) return preflight;
  const prepared = await preparationResult(context.repositoryRoot, preflight);
  return success(
    {
      ...prepared.payload,
      discardedDraft: { id: discarded.draft.id, status: discarded.draft.status },
      activeDraft: null,
      activeSession: null
    },
    `Discarded intake draft ${draftId}.\n${prepared.human}`
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
    `legion start --session ${recorded.session.id} --answer "${following.node.id}=<value>"`,
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

  const resolved = await resolveSession(context, { create: true, automaticExploration: false, preparation: false });
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
  await recoverIntakeLifecycleArtifacts(context.repositoryRoot);
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
    const action = nextAction(
      `legion start --session ${session.id} --answer "${node.id}=<value>"`,
      "Answer the remaining questions."
    );
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

  // Every declared verification-surface path is hashed here, before anything is
  // written, through the same resolver `legion ship` re-checks the pin with.
  //
  // A path that will not resolve is a refusal rather than a dropped declaration.
  // Dropping it would give an operator who explicitly said "this crosses a
  // boundary" the same ship verdict as one who said nothing — `unevaluable` —
  // which is the fail-open this gate exists to close, arriving through the
  // authoring path before any gate runs. Refusing costs nothing: the answers are
  // still in the session, one `--answer` repairs the path, and `--finalize` runs
  // again having written nothing in between.
  const declaredPins = declaredSurfacePaths(session.answers);
  const mintPin = await mintPinnedReferences({
    repositoryRoot: context.repositoryRoot,
    paths: declaredPins.map((entry) => entry.path)
  });
  const unpinnable: IntakeDiagnostic[] = [];
  for (const declared of declaredPins) {
    if (mintPin(declared.path) !== undefined) continue;
    unpinnable.push({
      code: "unpinnable_surface",
      message:
        `Requirement ${declared.requirementIndex}, criterion ${declared.criterionIndex}: no readable file is at ` +
        `"${declared.path}", so the surface it pins cannot be recorded. A surface pin is what makes the ` +
        `declaration falsifiable; name a file that exists, or skip ` +
        `req-${declared.requirementIndex}-ac-${declared.criterionIndex}-surface-kind to leave the surface undeclared.`,
      nodeId: `req-${declared.requirementIndex}-ac-${declared.criterionIndex}-surface-pins`,
      slot: `requirements.${declared.requirementIndex}.criteria.${declared.criterionIndex}.surface.pins`
    });
  }
  if (unpinnable.length > 0) {
    return failure(
      {
        ok: false,
        status: "invalid",
        session: sessionPayload(session, answered, total),
        diagnostics: unpinnable
      },
      `The interview is complete but a declared verification surface pins a file that could not be read:\n${renderIntakeDiagnostics(unpinnable)}`
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
    intakeSessionPath: intakeSessionArtifactPath(session.id),
    mintPin
  });

  // Two sessions can now both reach finalize, because the allocator preserves
  // concurrent starts and --session can complete either. Writing unconditionally
  // meant the second replaced the first's requirement set and deleted its
  // unmatched req_*.json files — two valid interviews silently overwriting each
  // other's durable contracts.
  const existingSet = await readRequirementSet(context.repositoryRoot);
  if (
    existingSet.ok &&
    existingSet.set.intakeSessionId !== undefined &&
    existingSet.set.intakeSessionId !== session.id
  ) {
    return failure(
      {
        ok: false,
        status: "requirement_set_conflict",
        session: sessionPayload(session, answered, total),
        diagnostics: [
          {
            code: "requirement_set_conflict",
            message:
              `This project's requirement set was written by intake session ${existingSet.set.intakeSessionId}. ` +
              `Finalizing ${session.id} would replace it and delete requirements it authored. ` +
              `Abort one of the interviews, or start from a clean project.`
          }
        ]
      },
      `Refusing to replace the requirement set written by ${existingSet.set.intakeSessionId}.`
    );
  }

  // The risk tier, budgets and verification command the operator chose are
  // recorded with the requirement set, because planning reads them from there.
  // Left in the session they would be answers nobody consumes.
  const enforcement = enforcementPolicy(session.answers);
  if (enforcement === undefined) {
    notes.push(
      "The enforcement answers could not be read back, so planning will fall back to repository defaults. Re-run the risk and budget questions."
    );
  }

  const written = await writeRequirementSet({
    repositoryRoot: context.repositoryRoot,
    projectId,
    requirements,
    intakeSessionId: session.id,
    graphVersion: session.graphVersion,
    ...(enforcement === undefined ? {} : { enforcement }),
    resolvedQuestions: resolvedOpenQuestions(session),
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

  // `renderRoadmap` emits no `## Phase 1:` heading when every requirement is
  // `wont`, and `legion plan 1` needs that heading. Routing there anyway would
  // be the fourth time in this PR that emitted advice named a command the code
  // then refuses.
  const buildable = requirements.some((requirement) => requirement.priority !== "wont");
  const action = buildable
    ? nextAction("legion plan 1", "The requirement set is written; plan the first phase.")
    : nextAction(
        "legion start",
        "Every requirement was recorded as out of scope, so there is nothing to plan. Start a new interview to add one."
      );
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
