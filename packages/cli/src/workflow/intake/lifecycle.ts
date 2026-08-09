import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { link, lstat, open, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureProjectArtifactParent, intakePreflightStateSchema, resolveProjectArtifactPath, type IntakePreflightState } from "@legion/artifacts";
export type { IntakePreflightState } from "@legion/artifacts";
import {
  LEGION_PROTOCOL_VERSION,
  explorationSchema,
  intakeDraftIdSchema,
  intakeDraftSchema,
  intakeSessionIdSchema,
  intakeSessionSchema,
  utcTimestampSchema,
  type IntakeDraft,
  type IntakeDraftAnswer,
  type IntakeProjectMode,
  type IntakeSession
} from "@legion/protocol";

import { discoverGuidanceRuns } from "../guidance-run.js";
import { currentCodebaseFingerprint, resolveMapState } from "../codebase-map.js";
import { isAuthoredCodeOrBuildFile, isDocumentationFile, shouldTraverseAuthoredDirectory } from "../authored-source.js";
import { INTAKE_GRAPH_VERSION, allGraphSlots, answersByNodeId, findNode, isNodeApplicable } from "./graph.js";
import { listExplorations, loadExploration, type LoadedExploration } from "./exploration-source.js";
import { allocateSessionId, createSession, findActiveSession, intakeSessionArtifactPath, intakeSessionBytes, loadSession, normalizeInjectedNodes, recordAnswer, rollbackSessionCreation, saveSession } from "./session.js";
import { validateAnswer, type IntakeDiagnostic } from "./validators.js";

async function repositoryFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !shouldTraverseAuthoredDirectory(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).replace(/\\/gu, "/"));
    }
  }
  await visit(root);
  return files;
}

/** Classify only authored repository inputs; generated/runtime trees never influence mode. */
export async function classifyProjectMode(repositoryRoot: string): Promise<IntakeProjectMode> {
  const files = await repositoryFiles(repositoryRoot);
  if (files.some(isAuthoredCodeOrBuildFile)) return "brownfield";

  if (files.some(isDocumentationFile)) return "documentation-only";

  return "greenfield";
}

export interface ExplorationSelectionDiagnostic {
  readonly runId: string;
  readonly code: "not_completed" | "unrelated_next_action" | "unreadable" | "competing_candidate";
  readonly message: string;
}

export interface ExplorationSelection {
  readonly selected?: LoadedExploration;
  readonly diagnostics: readonly ExplorationSelectionDiagnostic[];
}

/** Resolve an exploration before any intake session ID is allocated. */
export async function resolveExplorationSelection(input: {
  readonly repositoryRoot: string;
  readonly explicitRunId?: string;
  readonly withoutExploration?: boolean;
}): Promise<ExplorationSelection> {
  const discovery = await discoverGuidanceRuns({
    repositoryRoot: input.repositoryRoot,
    workflows: ["explore"],
    limitPerWorkflow: Number.MAX_SAFE_INTEGER
  });
  const diagnostics: ExplorationSelectionDiagnostic[] = discovery.diagnostics.map((entry) => ({
    runId: entry.runId,
    code: "unreadable",
    message: entry.message
  }));
  let selected: LoadedExploration | undefined;
  for (const run of discovery.runs) {
    if (run.status !== "completed") {
      diagnostics.push({
        runId: run.runId,
        code: "not_completed",
        message: `Exploration ${run.runId} is ${run.status}, not completed.`
      });
      continue;
    }
    if (run.nextAction.command.trim() !== "legion start") {
      diagnostics.push({
        runId: run.runId,
        code: "unrelated_next_action",
        message: `Exploration ${run.runId} hands off to ${run.nextAction.command}, not legion start.`
      });
      continue;
    }
    const loaded = await loadExploration(input.repositoryRoot, run.runId);
    if (!loaded.ok) {
      diagnostics.push({ runId: run.runId, code: "unreadable", message: loaded.reason });
      continue;
    }
    if (selected === undefined) {
      selected = loaded.loaded;
      continue;
    }
    diagnostics.push({
      runId: run.runId,
      code: "competing_candidate",
      message: `Exploration ${run.runId} is compatible but older than selected exploration ${selected.candidate.runId}.`
    });
  }
  if (input.withoutExploration === true) return { diagnostics };
  if (input.explicitRunId !== undefined) {
    const loaded = await loadExploration(input.repositoryRoot, input.explicitRunId);
    if (!loaded.ok) {
      return { diagnostics: [...diagnostics, { runId: input.explicitRunId, code: "unreadable", message: loaded.reason }] };
    }
    const incompatible = diagnostics.some((diagnostic) =>
      diagnostic.runId === loaded.loaded.candidate.runId && diagnostic.code !== "competing_candidate"
    );
    return incompatible ? { diagnostics } : { selected: loaded.loaded, diagnostics };
  }
  return { ...(selected === undefined ? {} : { selected }), diagnostics };
}

export interface DraftStagingDiagnostic extends IntakeDiagnostic {
  readonly code: string;
}

export type StageIntakeDraftResult =
  | {
      readonly ok: true;
      readonly draft: IntakeDraft;
      readonly previewSession: IntakeSession;
      readonly diagnostics: readonly [];
      readonly artifactPath: string;
      readonly replacesDraft?: IntakeDraft;
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly DraftStagingDiagnostic[];
    };

export interface ActiveDraftReview {
  readonly schemaVersion: 1;
  readonly state: "reviewed" | "unreviewed" | "consumed";
  readonly draftId: string;
  readonly draftSha256: string;
  readonly token: string;
  readonly updatedAt: string;
}

export type PublishDraftReviewResult =
  | { readonly ok: true; readonly draft: IntakeDraft; readonly review: ActiveDraftReview; readonly artifactPath: string }
  | { readonly ok: false; readonly diagnostics: readonly DraftStagingDiagnostic[] };

const ACTIVE_REVIEW_ARTIFACT_PATH = ".legion/project/intake/active-review.json";
const INTAKE_TRANSITION_KEY = "intake-transition";
const REPLACEMENT_JOURNAL_ARTIFACT_PATH = ".legion/project/intake/transactions/draft-replacement.json";

interface DraftReplacementJournal {
  readonly schemaVersion: 1;
  readonly kind: "draft-replacement";
  readonly priorDraftId: string;
  readonly priorDraftSha256: string;
  readonly replacement: IntakeDraft;
}

export function degradedCoverageWarning(mapFailure: string): string {
  return `DEGRADED COVERAGE: full-project mapping failed (${mapFailure}). Review only the bounded high-signal sources and preserve this warning in the draft diagnostics.`;
}

async function validateDraftPreflightBinding(input: {
  readonly repositoryRoot: string;
  readonly draft: IntakeDraft;
  readonly now?: string;
}, lease: DraftAcceptanceLease): Promise<readonly DraftStagingDiagnostic[]> {
  const preflight = await readPreflight(input.repositoryRoot, lease);
  if (preflight === undefined || preflight.initiative === undefined) {
    return [{ code: "preflight_required", message: "Run legion start preflight to completion before staging an intake draft." }];
  }

  const diagnostics: DraftStagingDiagnostic[] = [];
  const projectMode = await classifyProjectMode(input.repositoryRoot);
  if (projectMode !== preflight.projectMode || input.draft.projectMode !== preflight.projectMode) {
    diagnostics.push({
      code: "preflight_project_mode_mismatch",
      message: `Draft project mode ${input.draft.projectMode} does not match current preflight mode ${preflight.projectMode} (repository now classifies as ${projectMode}).`
    });
  }
  if (input.draft.initiative !== preflight.initiative.value) {
    diagnostics.push({
      code: "preflight_initiative_mismatch",
      message: "The draft initiative does not match the current explicit/exploration initiative; revise and restage the draft."
    });
  }

  if (preflight.explorationSelectionIntent.mode === "explicit") {
    const selection = await resolveExplorationSelection({
      repositoryRoot: input.repositoryRoot,
      explicitRunId: preflight.explorationSelectionIntent.runId
    });
    const loaded = selection.selected;
    const reference = input.draft.explorationRefs[0];
    if (loaded === undefined || preflight.selectedExplorationRunId !== loaded.candidate.runId ||
        input.draft.explorationRefs.length !== 1 || reference === undefined ||
        reference.runId !== loaded.exploration.runId ||
        reference.artifact.path !== loaded.artifact.path ||
        reference.artifact.sha256 !== loaded.artifact.sha256) {
      diagnostics.push({
        code: "preflight_exploration_mismatch",
        message: `Explicit exploration ${preflight.explorationSelectionIntent.runId} must resolve compatibly and be cited exactly by the draft.`
      });
    }
  } else if (preflight.selectedExplorationRunId === undefined) {
    if (input.draft.explorationRefs.length !== 0) {
      diagnostics.push({ code: "preflight_exploration_mismatch", message: "The current preflight selected no exploration, but the draft cites one." });
    }
  } else {
    const loaded = await loadExploration(input.repositoryRoot, preflight.selectedExplorationRunId);
    const reference = input.draft.explorationRefs[0];
    if (!loaded.ok || input.draft.explorationRefs.length !== 1 || reference === undefined ||
        reference.runId !== loaded.loaded.exploration.runId ||
        reference.artifact.path !== loaded.loaded.artifact.path ||
        reference.artifact.sha256 !== loaded.loaded.artifact.sha256) {
      diagnostics.push({
        code: "preflight_exploration_mismatch",
        message: `The draft must cite exactly the exploration selected by current preflight (${preflight.selectedExplorationRunId}).`
      });
    }
  }

  const now = input.now ?? preflight.updatedAt;
  const map = await resolveMapState(input.repositoryRoot, undefined, now);
  if (preflight.projectMode === "brownfield") {
    if (preflight.mapFailure !== undefined) {
      const warning = degradedCoverageWarning(preflight.mapFailure.message);
      if (!("error" in map) && map.freshness === "fresh") {
        diagnostics.push({
          code: "preflight_map_mismatch",
          message: "A fresh full-project map now exists; revise the degraded draft to cite its exact artifact, hash, and source fingerprint."
        });
      } else if (input.draft.codebaseMapRef !== undefined || !input.draft.diagnostics.includes(warning)) {
        diagnostics.push({
          code: "preflight_degraded_coverage_mismatch",
          message: "A degraded brownfield draft must omit full-map evidence and preserve the current degraded-coverage warning verbatim."
        });
      }
    } else {
      const reference = input.draft.codebaseMapRef;
      if ("error" in map || map.freshness !== "fresh" || map.scope !== "." || map.mapArtifact === null ||
          reference === undefined || reference.sourceFingerprint !== map.sourceFingerprint ||
          reference.artifact.path !== map.mapArtifact.path || reference.artifact.sha256 !== map.mapArtifact.sha256) {
        diagnostics.push({
          code: "preflight_map_mismatch",
          message: "A brownfield draft requires the exact current fresh full-project map artifact, hash, and source fingerprint."
        });
      }
    }
  } else if (input.draft.codebaseMapRef !== undefined) {
    diagnostics.push({ code: "preflight_map_mismatch", message: "Greenfield and documentation-only drafts must not claim codebase-map coverage." });
  }

  return diagnostics;
}

function draftArtifactPath(draftId: string): string {
  return `.legion/project/intake/drafts/${draftId}.json`;
}

function draftBytes(draft: IntakeDraft): string {
  return `${JSON.stringify(intakeDraftSchema.parse(draft), undefined, 2)}\n`;
}

function sha256(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function parseActiveDraftReview(value: unknown): ActiveDraftReview {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid active review");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["draftId", "draftSha256", "schemaVersion", "state", "token", "updatedAt"];
  if (keys.length !== expected.length || !expected.every((key, index) => keys[index] === key)) throw new Error("invalid active review");
  if (record["schemaVersion"] !== 1 || !["reviewed", "unreviewed", "consumed"].includes(String(record["state"])) ||
      typeof record["draftId"] !== "string" || !/^itd_[a-z0-9-]+$/u.test(record["draftId"]) ||
      typeof record["draftSha256"] !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record["draftSha256"]) ||
      typeof record["token"] !== "string" || record["token"].length === 0 ||
      !utcTimestampSchema.safeParse(record["updatedAt"]).success) throw new Error("invalid active review");
  return record as unknown as ActiveDraftReview;
}

async function readActiveDraftReview(repositoryRoot: string): Promise<{ readonly review?: ActiveDraftReview; readonly hash?: string }> {
  try {
    const resolved = await resolveProjectArtifactPath({ repositoryRoot, artifactPath: ACTIVE_REVIEW_ARTIFACT_PATH });
    const bytes = await readFile(resolved.absolutePath);
    return { review: parseActiveDraftReview(JSON.parse(bytes.toString("utf8"))), hash: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeActiveDraftReviewCas(
  repositoryRoot: string,
  review: ActiveDraftReview,
  lease: DraftAcceptanceLease,
  expectedHash?: string
): Promise<void> {
  await assertTransitionLeaseOwned(lease);
  const resolved = await ensureProjectArtifactParent({ repositoryRoot, artifactPath: ACTIVE_REVIEW_ARTIFACT_PATH });
  if (expectedHash !== undefined) {
    const current = await readFile(resolved.absolutePath);
    if (createHash("sha256").update(current).digest("hex") !== expectedHash) throw new Error("active review changed during transition");
  } else {
    try {
      await readFile(resolved.absolutePath);
      throw new Error("active review changed during transition");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  const temporary = `${resolved.absolutePath}.${randomUUID()}.tmp`;
  await assertTransitionLeaseOwned(lease);
  await writeFile(temporary, `${JSON.stringify(review, undefined, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await assertTransitionLeaseOwned(lease);
    await rename(temporary, resolved.absolutePath);
  } catch (error) {
    if (await renewAndValidateLease(lease)) await rm(temporary, { force: true });
    throw error;
  }
}

async function markActiveReview(
  repositoryRoot: string,
  input: { readonly state: ActiveDraftReview["state"]; readonly draftId: string; readonly draftSha256: string; readonly updatedAt?: string },
  lease: DraftAcceptanceLease
): Promise<ActiveDraftReview> {
  const current = await readActiveDraftReview(repositoryRoot);
  const review: ActiveDraftReview = {
    schemaVersion: 1,
    state: input.state,
    draftId: input.draftId,
    draftSha256: input.draftSha256,
    token: randomUUID(),
    updatedAt: utcTimestampSchema.parse(input.updatedAt ?? new Date().toISOString())
  };
  await writeActiveDraftReviewCas(repositoryRoot, review, lease, current.hash);
  return review;
}

async function consumeActiveReviewForDraft(repositoryRoot: string, draftId: string, lease: DraftAcceptanceLease): Promise<void> {
  const current = await readActiveDraftReview(repositoryRoot);
  if (current.review?.draftId !== draftId) return;
  const resolved = await resolveProjectArtifactPath({ repositoryRoot, artifactPath: ACTIVE_REVIEW_ARTIFACT_PATH });
  const bytes = await readFile(resolved.absolutePath);
  if (createHash("sha256").update(bytes).digest("hex") !== current.hash) throw new Error("active review changed during transition");
  await assertTransitionLeaseOwned(lease);
  await rm(resolved.absolutePath);
}

export async function findActiveDraftReview(repositoryRoot: string): Promise<ActiveDraftReview | undefined> {
  return (await readActiveDraftReview(repositoryRoot)).review;
}

async function writeDraftExclusive(
  repositoryRoot: string,
  draft: IntakeDraft,
  lease: DraftAcceptanceLease,
  beforePublish?: () => Promise<void> | void,
  afterPublish?: () => Promise<void> | void
): Promise<string> {
  const artifactPath = draftArtifactPath(draft.id);
  await assertTransitionLeaseOwned(lease);
  const resolved = await ensureProjectArtifactParent({ repositoryRoot, artifactPath });
  const temporary = `${resolved.absolutePath}.${randomUUID()}.tmp`;
  await assertTransitionLeaseOwned(lease);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(draftBytes(draft), "utf8");
    await handle.sync();
    await handle.close();
    await beforePublish?.();
    await assertTransitionLeaseOwned(lease);
    await link(temporary, resolved.absolutePath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (await renewAndValidateLease(lease)) await rm(temporary, { force: true });
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      await removeDraftPublishTemps(resolved.absolutePath, lease);
    }
    throw error;
  }
  await afterPublish?.();
  await removeDraftPublishTemps(resolved.absolutePath, lease);
  return artifactPath;
}

async function removeDraftPublishTemps(finalPath: string, lease: DraftAcceptanceLease): Promise<void> {
  const directory = path.dirname(finalPath);
  const prefix = `${path.basename(finalPath)}.`;
  for (const name of await readdir(directory)) {
    if (name.startsWith(prefix) && name.endsWith(".tmp")) {
      await assertTransitionLeaseOwned(lease);
      await rm(path.join(directory, name), { force: true }).catch(() => undefined);
    }
  }
}

async function writeDraftCas(repositoryRoot: string, draft: IntakeDraft, expectedHash: string, lease: DraftAcceptanceLease): Promise<string> {
  const artifactPath = draftArtifactPath(draft.id);
  await assertTransitionLeaseOwned(lease);
  const resolved = await ensureProjectArtifactParent({ repositoryRoot, artifactPath });
  const current = await readFile(resolved.absolutePath);
  const actualHash = createHash("sha256").update(current).digest("hex");
  if (actualHash !== expectedHash) throw new Error("draft changed during acceptance");
  const temporary = `${resolved.absolutePath}.${process.pid}.${Date.now()}.tmp`;
  await assertTransitionLeaseOwned(lease);
  await writeFile(temporary, draftBytes(draft), { encoding: "utf8", flag: "wx" });
  try {
    await assertTransitionLeaseOwned(lease);
    await rename(temporary, resolved.absolutePath);
  } catch (error) {
    if (await renewAndValidateLease(lease)) await rm(temporary, { force: true });
    throw error;
  }
  return artifactPath;
}

async function writeReplacementJournal(repositoryRoot: string, journal: DraftReplacementJournal, lease: DraftAcceptanceLease): Promise<void> {
  await assertTransitionLeaseOwned(lease);
  const resolved = await ensureProjectArtifactParent({ repositoryRoot, artifactPath: REPLACEMENT_JOURNAL_ARTIFACT_PATH });
  const temporary = `${resolved.absolutePath}.${randomUUID()}.tmp`;
  await assertTransitionLeaseOwned(lease);
  await writeFile(temporary, `${JSON.stringify(journal, undefined, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await assertTransitionLeaseOwned(lease);
    await rename(temporary, resolved.absolutePath);
  } catch (error) {
    if (await renewAndValidateLease(lease)) await rm(temporary, { force: true });
    throw error;
  }
}

async function removeReplacementJournal(repositoryRoot: string, lease: DraftAcceptanceLease): Promise<void> {
  const resolved = await resolveProjectArtifactPath({ repositoryRoot, artifactPath: REPLACEMENT_JOURNAL_ARTIFACT_PATH });
  await assertTransitionLeaseOwned(lease);
  await rm(resolved.absolutePath, { force: true });
}

async function readReplacementJournal(repositoryRoot: string): Promise<DraftReplacementJournal | undefined> {
  let value: unknown;
  try {
    const resolved = await resolveProjectArtifactPath({ repositoryRoot, artifactPath: REPLACEMENT_JOURNAL_ARTIFACT_PATH });
    value = JSON.parse(await readFile(resolved.absolutePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid draft replacement journal");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["kind", "priorDraftId", "priorDraftSha256", "replacement", "schemaVersion"];
  if (keys.length !== expected.length || !expected.every((key, index) => keys[index] === key) ||
      record["schemaVersion"] !== 1 || record["kind"] !== "draft-replacement" ||
      typeof record["priorDraftId"] !== "string" || !/^itd_[a-z0-9-]+$/u.test(record["priorDraftId"]) ||
      typeof record["priorDraftSha256"] !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record["priorDraftSha256"])) {
    throw new Error("invalid draft replacement journal");
  }
  return {
    schemaVersion: 1,
    kind: "draft-replacement",
    priorDraftId: record["priorDraftId"],
    priorDraftSha256: record["priorDraftSha256"],
    replacement: intakeDraftSchema.parse(record["replacement"])
  };
}

async function recoverDraftReplacement(repositoryRoot: string, lease: DraftAcceptanceLease): Promise<void> {
  await assertTransitionLeaseOwned(lease);
  const journal = await readReplacementJournal(repositoryRoot);
  if (journal === undefined) return;
  const candidates = await inspectActiveDraftCandidates(repositoryRoot);
  if (!candidates.ok) throw new Error(candidates.diagnostics.map((entry) => entry.message).join(" "));
  const conflicting = candidates.drafts.filter((draft) =>
    draft.id !== journal.priorDraftId && draft.id !== journal.replacement.id
  );
  if (conflicting.length > 0) {
    throw new Error(`replacement recovery conflicts with open draft(s): ${conflicting.map((draft) => draft.id).join(", ")}`);
  }
  const priorResolved = await resolveProjectArtifactPath({ repositoryRoot, artifactPath: draftArtifactPath(journal.priorDraftId) });
  const priorRaw = await readFile(priorResolved.absolutePath);
  const prior = intakeDraftSchema.parse(JSON.parse(priorRaw.toString("utf8")));
  if (prior.status === "accepted" || prior.status === "discarded") {
    const replacement = await loadStagedDraft(repositoryRoot, journal.replacement.id);
    if (replacement?.status === "draft") {
      const replacementResolved = await resolveProjectArtifactPath({ repositoryRoot, artifactPath: draftArtifactPath(replacement.id) });
      const replacementRaw = await readFile(replacementResolved.absolutePath);
      await assertTransitionLeaseOwned(lease);
      await writeDraftCas(repositoryRoot, intakeDraftSchema.parse({ ...replacement, status: "invalidated" }), createHash("sha256").update(replacementRaw).digest("hex"), lease);
    }
    await assertTransitionLeaseOwned(lease);
    await removeReplacementJournal(repositoryRoot, lease);
    return;
  }
  if (prior.status === "draft") {
    if (sha256(priorRaw) !== journal.priorDraftSha256) throw new Error("prior draft changed during replacement recovery");
    await assertTransitionLeaseOwned(lease);
    await writeDraftCas(repositoryRoot, intakeDraftSchema.parse({ ...prior, status: "invalidated" }), createHash("sha256").update(priorRaw).digest("hex"), lease);
  } else if (prior.status !== "invalidated") {
    throw new Error(`prior draft ${prior.id} has unsupported replacement state ${prior.status}`);
  }
  const existing = await loadStagedDraft(repositoryRoot, journal.replacement.id);
  if (existing === undefined) {
    await assertTransitionLeaseOwned(lease);
    await writeDraftExclusive(repositoryRoot, journal.replacement, lease);
  } else if (draftBytes(existing) !== draftBytes(journal.replacement)) {
    throw new Error(`replacement draft ${journal.replacement.id} conflicts with its journal`);
  }
  await assertTransitionLeaseOwned(lease);
  await markActiveReview(repositoryRoot, {
    state: "unreviewed",
    draftId: journal.replacement.id,
    draftSha256: sha256(draftBytes(journal.replacement))
  }, lease);
  await assertTransitionLeaseOwned(lease);
  await removeReplacementJournal(repositoryRoot, lease);
}

function diagnosticForProposal(
  proposal: IntakeDraftAnswer,
  code: string,
  message: string
): DraftStagingDiagnostic {
  return { code, message, nodeId: proposal.nodeId, slot: proposal.slot };
}

type ReplayDraftResult =
  | { readonly ok: true; readonly previewSession: IntakeSession }
  | { readonly ok: false; readonly diagnostics: readonly DraftStagingDiagnostic[] };

/** The single graph/validator replay used by staging, acceptance, and recovery. */
async function replayDraft(
  repositoryRoot: string,
  draft: IntakeDraft
): Promise<ReplayDraftResult> {
  if (draft.graphVersion !== INTAKE_GRAPH_VERSION) {
    return {
      ok: false,
      diagnostics: [{
        code: "draft_graph_mismatch",
        message: `Draft ${draft.id} targets intake graph ${draft.graphVersion}, but this CLI ships ${INTAKE_GRAPH_VERSION}.`
      }]
    };
  }

  const base = createSession({
    sessionId: "itk_19700101-000000000",
    createdAt: draft.createdAt,
    schemaVersion: LEGION_PROTOCOL_VERSION
  }).session;
  const injectedNodes = normalizeInjectedNodes(draft.injectedQuestions);
  const occupiedSlots = new Set(allGraphSlots());
  for (const question of injectedNodes) {
    if (occupiedSlots.has(question.slot)) {
      return { ok: false, diagnostics: [{ code: "injected_slot_conflict", message: `Injected question ${question.nodeId} collides with slot ${question.slot}.` }] };
    }
    occupiedSlots.add(question.slot);
  }
  for (const question of injectedNodes) {
    const evidence = draft.explorationRefs.find((reference) => reference.runId === question.origin.runId);
    let verified = evidence !== undefined && await evidenceMatches(repositoryRoot, evidence);
    if (verified && evidence !== undefined) {
      try {
        const resolved = await resolveProjectArtifactPath({ repositoryRoot, artifactPath: evidence.artifact.path });
        const exploration = explorationSchema.parse(JSON.parse(await readFile(resolved.absolutePath, "utf8")));
        verified = exploration.runId === question.origin.runId && exploration.openQuestions.some((candidate) =>
          candidate.slot === question.origin.anchor && candidate.slot === question.slot && candidate.question === question.prompt
        );
      } catch {
        verified = false;
      }
    }
    if (!verified) {
      return { ok: false, diagnostics: [{ code: "unverified_injected_origin", message: `Injected question ${question.nodeId} does not resolve to cited exploration ${question.origin.runId} at ${question.origin.anchor}.` }] };
    }
  }
  let session = intakeSessionSchema.parse({
    ...base,
    injectedNodes
  });
  const pending = [...draft.proposedAnswers];
  const diagnostics: DraftStagingDiagnostic[] = [];

  while (pending.length > 0) {
    let progressed = false;
    for (let index = 0; index < pending.length;) {
      const proposal = pending[index]!;
      const node = findNode({ answers: session.answers, injectedNodes: session.injectedNodes }, proposal.nodeId);
      if (node === undefined) {
        index += 1;
        continue;
      }
      if (node.slot !== proposal.slot) {
        diagnostics.push(diagnosticForProposal(
          proposal,
          "conflicting_slot",
          `${proposal.nodeId} belongs to ${node.slot}, not the proposed slot ${proposal.slot}.`
        ));
        pending.splice(index, 1);
        progressed = true;
        continue;
      }
      const answerMap = answersByNodeId(session.answers);
      if (!isNodeApplicable(node, answerMap)) {
        const dependencyAnswered = node.dependsOn === undefined || answerMap.has(node.dependsOn.nodeId);
        if (dependencyAnswered) {
          diagnostics.push(diagnosticForProposal(
            proposal,
            "inapplicable_answer",
            `${proposal.nodeId} is not applicable because ${node.dependsOn?.nodeId ?? "the graph"} rules it out.`
          ));
          pending.splice(index, 1);
          progressed = true;
          continue;
        }
        index += 1;
        continue;
      }

      const validated = validateAnswer(node, proposal.value);
      if (validated.value === undefined || validated.diagnostics.length > 0) {
        diagnostics.push(...validated.diagnostics);
        pending.splice(index, 1);
        progressed = true;
        continue;
      }
      const recorded = recordAnswer({
        session,
        nodeId: node.id,
        value: validated.value,
        answeredAt: draft.createdAt,
        source: "draft-accepted",
        draftAcceptedFrom: { draftId: draft.id, answerAnchor: proposal.answerAnchor }
      });
      if (!recorded.ok) {
        diagnostics.push(diagnosticForProposal(proposal, "conflicting_answer", recorded.reason));
      } else {
        session = recorded.session;
      }
      pending.splice(index, 1);
      progressed = true;
    }
    if (progressed) continue;
    for (const proposal of pending.splice(0)) {
      const materialized = findNode({ answers: session.answers, injectedNodes: session.injectedNodes }, proposal.nodeId);
      diagnostics.push(diagnosticForProposal(
        proposal,
        materialized === undefined ? "unknown_node" : "inapplicable_answer",
        materialized === undefined
          ? `${proposal.nodeId} is not a question materialized by the current intake graph.`
          : `${proposal.nodeId} depends on an unresolved earlier answer.`
      ));
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };

  for (const unresolved of draft.unresolvedNodes) {
    const node = findNode({ answers: session.answers, injectedNodes: session.injectedNodes }, unresolved.nodeId);
    if (node === undefined) {
      diagnostics.push({
        code: "unknown_unresolved_node",
        message: `${unresolved.nodeId} is not a question materialized by the current intake graph.`,
        nodeId: unresolved.nodeId,
        slot: unresolved.slot
      });
      continue;
    }
    if (node.slot !== unresolved.slot) {
      diagnostics.push({
        code: "conflicting_unresolved_slot",
        message: `${unresolved.nodeId} belongs to ${node.slot}, not unresolved slot ${unresolved.slot}.`,
        nodeId: unresolved.nodeId,
        slot: unresolved.slot
      });
      continue;
    }
    if (session.answers.some((answer) => answer.nodeId === unresolved.nodeId || answer.slot === unresolved.slot)) {
      diagnostics.push({
        code: "resolved_node_marked_unresolved",
        message: `${unresolved.nodeId} already has a validated proposed answer and cannot also be unresolved.`,
        nodeId: unresolved.nodeId,
        slot: unresolved.slot
      });
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, previewSession: session };
}

/**
 * Replays proposed answers through the CLI graph and validators without writing
 * a session. Successful replay is the staging gate; the persisted draft stays
 * independent until an explicit acceptance creates one session record.
 */
export async function stageIntakeDraft(input: {
  readonly repositoryRoot: string;
  readonly draftFile: string;
  /** Internal acceptance replay: validate durable bytes without persisting them again. */
  readonly persist?: boolean;
  readonly beforeDraftPublish?: () => Promise<void> | void;
  readonly afterDraftPublish?: () => Promise<void> | void;
  readonly afterLeaseAcquired?: (leasePath: string) => Promise<void> | void;
  readonly afterReplacementJournal?: () => Promise<void> | void;
  readonly afterPriorInvalidated?: () => Promise<void> | void;
  readonly afterReplacementPublished?: () => Promise<void> | void;
  readonly createdAt?: string;
}): Promise<StageIntakeDraftResult> {
  const absoluteSource = path.resolve(input.repositoryRoot, input.draftFile);
  const relativeSource = path.relative(input.repositoryRoot, absoluteSource);
  if (relativeSource.startsWith("..") || path.isAbsolute(relativeSource)) {
    return { diagnostics: [{ code: "draft_path_outside_repository", message: "The intake draft file must stay inside the repository." }], ok: false };
  }

  let json: unknown;
  try {
    if ((await lstat(absoluteSource)).isSymbolicLink()) throw new Error("The intake draft file cannot be a symbolic link.");
    const [rootRealPath, sourceRealPath] = await Promise.all([
      realpath(path.resolve(input.repositoryRoot)),
      realpath(absoluteSource)
    ]);
    const contained = path.relative(rootRealPath, sourceRealPath);
    if (contained.startsWith("..") || path.isAbsolute(contained)) {
      throw new Error("The intake draft file escapes the repository through a symbolic-link ancestor.");
    }
    json = JSON.parse(await readFile(sourceRealPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { diagnostics: [{ code: "invalid_draft", message: `The intake draft could not be read as JSON: ${message}` }], ok: false };
  }
  const parsed = intakeDraftSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: parsed.error.issues.map((issue) => ({
        code: "invalid_draft",
        message: `${issue.path.join(".")}: ${issue.message}`
      }))
    };
  }
  const draft = parsed.data;
  if (draft.status !== "draft") {
    return { ok: false, diagnostics: [{ code: "draft_not_open", message: `Draft ${draft.id} is ${draft.status}, not open for staging.` }] };
  }
  let replayed: { readonly ok: true; readonly previewSession: IntakeSession } | undefined;
  let artifactPath = draftArtifactPath(draft.id);
  let replacesDraft: IntakeDraft | undefined;
  if (input.persist === false) {
    let lease: DraftAcceptanceLease;
    try {
      lease = await acquireDraftAcceptanceLease(input.repositoryRoot, draft.id);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return {
        ok: false,
        diagnostics: [{ code: "draft_transition_in_progress", message: "Another intake draft transition is in progress." }]
      };
      throw error;
    }
    try {
      const acceptance = await reconcilePendingAcceptanceJournals(input.repositoryRoot, lease);
      if (!acceptance.ok) return { ok: false, diagnostics: acceptance.diagnostics };
      if (acceptance.rolledBackDraftIds.length > 0) return {
        ok: false,
        diagnostics: [pendingAcceptanceRecovered(acceptance.rolledBackDraftIds)]
      };
      const bindingDiagnostics = await validateDraftPreflightBinding({
        repositoryRoot: input.repositoryRoot,
        draft,
        ...(input.createdAt === undefined ? {} : { now: input.createdAt })
      }, lease);
      if (bindingDiagnostics.length > 0) return { ok: false, diagnostics: bindingDiagnostics };
      const evidenceDiagnostics = await validateDraftEvidence(input.repositoryRoot, draft);
      if (evidenceDiagnostics.length > 0) return { ok: false, diagnostics: evidenceDiagnostics };
      const validatedReplay = await replayDraft(input.repositoryRoot, draft);
      if (!validatedReplay.ok) return validatedReplay;
      replayed = validatedReplay;
    } finally {
      await releaseDraftAcceptanceLease(lease);
    }
  } else {
    let lease: DraftAcceptanceLease;
    try {
      lease = await acquireDraftAcceptanceLease(input.repositoryRoot, draft.id);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return {
        ok: false,
        diagnostics: [{ code: "draft_transition_in_progress", message: "Another intake draft transition is in progress." }]
      };
      throw error;
    }
    try {
      await input.afterLeaseAcquired?.(lease.path);
      if (!await renewAndValidateLease(lease)) return {
        ok: false,
        diagnostics: [{ code: "draft_transition_lease_lost", message: "The intake transition lock changed before staging." }]
      };
      const acceptance = await reconcilePendingAcceptanceJournals(input.repositoryRoot, lease);
      if (!acceptance.ok) return { ok: false, diagnostics: acceptance.diagnostics };
      if (acceptance.rolledBackDraftIds.length > 0) return {
        ok: false,
        diagnostics: [pendingAcceptanceRecovered(acceptance.rolledBackDraftIds)]
      };
      await recoverDraftReplacement(input.repositoryRoot, lease);
      await assertTransitionLeaseOwned(lease);
      const bindingDiagnostics = await validateDraftPreflightBinding({
        repositoryRoot: input.repositoryRoot,
        draft,
        ...(input.createdAt === undefined ? {} : { now: input.createdAt })
      }, lease);
      if (bindingDiagnostics.length > 0) return { ok: false, diagnostics: bindingDiagnostics };
      const evidenceDiagnostics = await validateDraftEvidence(input.repositoryRoot, draft);
      if (evidenceDiagnostics.length > 0) return { ok: false, diagnostics: evidenceDiagnostics };
      const validatedReplay = await replayDraft(input.repositoryRoot, draft);
      if (!validatedReplay.ok) return validatedReplay;
      replayed = validatedReplay;
      try {
        const target = await resolveProjectArtifactPath({
          repositoryRoot: input.repositoryRoot,
          artifactPath: draftArtifactPath(draft.id)
        });
        await lstat(target.absolutePath);
        return {
          ok: false,
          diagnostics: [{ code: "draft_already_exists", message: `Draft ${draft.id} already exists and cannot be overwritten.` }]
        };
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
      const foundSession = await findActiveSession(input.repositoryRoot);
      if (!foundSession.ok) return {
        ok: false,
        diagnostics: [{ code: "invalid_session", message: foundSession.reason }]
      };
      if (foundSession.session !== undefined) return {
        ok: false,
        diagnostics: [{
          code: "active_session",
          message: `Session ${foundSession.session.id} is already active; accepted draft answers must be revised through the interview, not by staging another draft.`
        }]
      };
      const scanned = await inspectActiveDraftCandidates(input.repositoryRoot);
      if (!scanned.ok) return scanned;
      const open = scanned.drafts;
      if (open.length > 1) return {
        ok: false,
        diagnostics: [{ code: "ambiguous_active_drafts", message: "Multiple open intake drafts exist; resolve them before staging a replacement." }]
      };
      const previous = open[0];
      if (previous !== undefined && previous.id !== draft.id && previous.status === "draft") {
        const previousResolved = await resolveProjectArtifactPath({
          repositoryRoot: input.repositoryRoot,
          artifactPath: draftArtifactPath(previous.id)
        });
        const previousBytes = await readFile(previousResolved.absolutePath);
        const previousHash = createHash("sha256").update(previousBytes).digest("hex");
        replacesDraft = intakeDraftSchema.parse({ ...previous, status: "invalidated" });
        try {
          const replacementResolved = await resolveProjectArtifactPath({ repositoryRoot: input.repositoryRoot, artifactPath: draftArtifactPath(draft.id) });
          await lstat(replacementResolved.absolutePath);
          return { ok: false, diagnostics: [{ code: "draft_already_exists", message: `Draft ${draft.id} already exists and cannot be overwritten.` }] };
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
        }
        await assertTransitionLeaseOwned(lease);
        await markActiveReview(input.repositoryRoot, {
          state: "unreviewed",
          draftId: previous.id,
          draftSha256: sha256(previousBytes),
          ...(input.createdAt === undefined ? {} : { updatedAt: input.createdAt })
        }, lease);
        await assertTransitionLeaseOwned(lease);
        await writeReplacementJournal(input.repositoryRoot, {
          schemaVersion: 1,
          kind: "draft-replacement",
          priorDraftId: previous.id,
          priorDraftSha256: sha256(previousBytes),
          replacement: draft
        }, lease);
        await input.afterReplacementJournal?.();
        await assertTransitionLeaseOwned(lease);
        await writeDraftCas(input.repositoryRoot, replacesDraft, previousHash, lease);
        await input.afterPriorInvalidated?.();
        await assertTransitionLeaseOwned(lease);
        artifactPath = await writeDraftExclusive(input.repositoryRoot, draft, lease, async () => {
          await input.beforeDraftPublish?.();
          await assertTransitionLeaseOwned(lease);
        }, input.afterDraftPublish);
        await input.afterReplacementPublished?.();
        await assertTransitionLeaseOwned(lease);
        await markActiveReview(input.repositoryRoot, {
          state: "unreviewed",
          draftId: draft.id,
          draftSha256: sha256(draftBytes(draft)),
          ...(input.createdAt === undefined ? {} : { updatedAt: input.createdAt })
        }, lease);
        await assertTransitionLeaseOwned(lease);
        await removeReplacementJournal(input.repositoryRoot, lease);
      } else {
        try {
          await assertTransitionLeaseOwned(lease);
          artifactPath = await writeDraftExclusive(input.repositoryRoot, draft, lease, async () => {
            await input.beforeDraftPublish?.();
            await assertTransitionLeaseOwned(lease);
          }, input.afterDraftPublish);
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
            return {
              ok: false,
              diagnostics: [{ code: "draft_already_exists", message: `Draft ${draft.id} already exists and cannot be overwritten.` }]
            };
          }
          throw error;
        }
        await assertTransitionLeaseOwned(lease);
        await markActiveReview(input.repositoryRoot, {
          state: "unreviewed",
          draftId: draft.id,
          draftSha256: sha256(draftBytes(draft)),
          ...(input.createdAt === undefined ? {} : { updatedAt: input.createdAt })
        }, lease);
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ELEASELOST") return {
        ok: false,
        diagnostics: [{ code: "draft_transition_lease_lost", message: "The intake transition lock changed before staging completed." }]
      };
      throw error;
    } finally {
      await releaseDraftAcceptanceLease(lease);
    }
  }
  if (replayed === undefined) throw new Error("draft staging completed without validator replay");
  return {
    ok: true,
    draft,
    previewSession: replayed.previewSession,
    diagnostics: [],
    artifactPath,
    ...(replacesDraft === undefined ? {} : { replacesDraft })
  };
}

async function loadStagedDraft(repositoryRoot: string, draftId: string): Promise<IntakeDraft | undefined> {
  try {
    const resolved = await resolveProjectArtifactPath({ repositoryRoot, artifactPath: draftArtifactPath(draftId) });
    return intakeDraftSchema.parse(JSON.parse(await readFile(resolved.absolutePath, "utf8")));
  } catch {
    return undefined;
  }
}

export async function findActiveDraft(repositoryRoot: string): Promise<IntakeDraft | undefined> {
  return activeDraft(repositoryRoot);
}

async function artifactMatches(
  repositoryRoot: string,
  artifact: { readonly path: string; readonly sha256: string }
): Promise<boolean> {
  try {
    const resolved = await resolveProjectArtifactPath({ repositoryRoot, artifactPath: artifact.path });
    const bytes = await readFile(resolved.absolutePath);
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}` === artifact.sha256;
  } catch {
    return false;
  }
}

async function evidenceMatches(
  repositoryRoot: string,
  evidence: IntakeDraftAnswer["evidenceRefs"][number]
): Promise<boolean> {
  if (evidence.kind === "exploration") {
    const loaded = await loadExploration(repositoryRoot, evidence.runId);
    return loaded.ok &&
      loaded.loaded.artifact.path === evidence.artifact.path &&
      loaded.loaded.artifact.sha256 === evidence.artifact.sha256;
  }
  if (evidence.kind === "repository-file") {
    try {
      const absolute = path.resolve(repositoryRoot, evidence.artifact.path);
      const relative = path.relative(path.resolve(repositoryRoot), absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative) || (await lstat(absolute)).isSymbolicLink()) return false;
      const [rootRealPath, evidenceRealPath] = await Promise.all([realpath(path.resolve(repositoryRoot)), realpath(absolute)]);
      const contained = path.relative(rootRealPath, evidenceRealPath);
      if (contained.startsWith("..") || path.isAbsolute(contained)) return false;
      return sha256(await readFile(evidenceRealPath)) === evidence.artifact.sha256;
    } catch {
      return false;
    }
  }
  if (!await artifactMatches(repositoryRoot, evidence.artifact)) return false;
  if (evidence.kind === "codebase-map") {
    try {
      const current = await currentCodebaseFingerprint({ repositoryRoot });
      return current.sourceFingerprint === evidence.sourceFingerprint;
    } catch {
      return false;
    }
  }
  return true;
}

async function validateDraftEvidence(
  repositoryRoot: string,
  draft: IntakeDraft
): Promise<readonly DraftStagingDiagnostic[]> {
  const diagnostics: DraftStagingDiagnostic[] = [];
  const inspect = async (
    references: readonly IntakeDraftAnswer["evidenceRefs"][number][],
    owner: { readonly nodeId?: string; readonly slot?: string; readonly label: string }
  ): Promise<void> => {
    for (const reference of references) {
      if (await evidenceMatches(repositoryRoot, reference)) continue;
      diagnostics.push({
        code: "evidence_drift",
        message: `${owner.label} cites changed or unreadable ${reference.kind} evidence at ${reference.artifact.path}.`,
        ...(owner.nodeId === undefined ? {} : { nodeId: owner.nodeId }),
        ...(owner.slot === undefined ? {} : { slot: owner.slot })
      });
    }
  };
  await inspect(draft.explorationRefs, { label: `Draft ${draft.id}` });
  if (draft.codebaseMapRef !== undefined) await inspect([draft.codebaseMapRef], { label: `Draft ${draft.id}` });
  for (const answer of draft.proposedAnswers) {
    await inspect(answer.evidenceRefs, { label: answer.nodeId, nodeId: answer.nodeId, slot: answer.slot });
  }
  for (const unresolved of draft.unresolvedNodes) {
    await inspect(unresolved.evidenceRefs, { label: unresolved.nodeId, nodeId: unresolved.nodeId, slot: unresolved.slot });
  }
  return diagnostics.filter((diagnostic, index) => diagnostics.findIndex((candidate) =>
    candidate.code === diagnostic.code && candidate.message === diagnostic.message &&
    candidate.nodeId === diagnostic.nodeId && candidate.slot === diagnostic.slot
  ) === index);
}

export type AcceptStagedDraftResult =
  | { readonly ok: true; readonly status: "interview"; readonly draft: IntakeDraft; readonly session: IntakeSession }
  | { readonly ok: false; readonly status: "draft_review"; readonly diagnostics: readonly DraftStagingDiagnostic[] };

class DraftDecisionValidationError extends Error {
  readonly diagnostics: readonly DraftStagingDiagnostic[];

  constructor(diagnostics: readonly DraftStagingDiagnostic[]) {
    super(diagnostics.map((diagnostic) => diagnostic.message).join(" "));
    this.name = "DraftDecisionValidationError";
    this.diagnostics = diagnostics;
  }
}

interface DraftAcceptanceLease {
  readonly path: string;
  readonly journalPath: string;
  readonly token: string;
  readonly generation: number;
  readonly pid: number;
}

const ACCEPTANCE_LEASE_MS = 5 * 60 * 1000;

interface LeaseClaim extends DraftAcceptanceLease {
  readonly expiresAt: number;
}

interface PublishedLeaseClaim {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly token: string;
  readonly pid: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

const PUBLISHED_LEASE_CLAIM_KEYS = [
  "createdAt",
  "expiresAt",
  "generation",
  "pid",
  "schemaVersion",
  "token"
] as const;

/** One strict decoder owns the published-claim contract for acquisition and recovery. */
function parsePublishedLeaseClaim(input: {
  readonly bytes: string;
  readonly claimPath: string;
  readonly journalPath: string;
}): LeaseClaim {
  const value: unknown = JSON.parse(input.bytes);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("malformed lease");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== PUBLISHED_LEASE_CLAIM_KEYS.length ||
      !PUBLISHED_LEASE_CLAIM_KEYS.every((key, index) => keys[index] === key)) {
    throw new Error("malformed lease");
  }
  if (record["schemaVersion"] !== 1 ||
      !Number.isSafeInteger(record["generation"]) || Number(record["generation"]) < 1 ||
      typeof record["token"] !== "string" || record["token"].length === 0 ||
      !Number.isSafeInteger(record["pid"]) || Number(record["pid"]) < 1) {
    throw new Error("malformed lease");
  }
  const createdAt = utcTimestampSchema.safeParse(record["createdAt"]);
  const expiresAt = utcTimestampSchema.safeParse(record["expiresAt"]);
  if (!createdAt.success || !expiresAt.success) throw new Error("malformed lease");

  const filename = path.basename(input.claimPath);
  const prefix = `${path.basename(input.journalPath)}.lock.`;
  if (!filename.startsWith(prefix)) throw new Error("malformed lease");
  const suffix = filename.slice(prefix.length);
  const filenameClaim = /^(\d{8,})\.([^.]+)\.json$/u.exec(suffix);
  const generation = Number(record["generation"]);
  const token = record["token"];
  if (filenameClaim === null || Number(filenameClaim[1]) !== generation || filenameClaim[2] !== token) {
    throw new Error("malformed lease");
  }

  const metadata: PublishedLeaseClaim = {
    schemaVersion: 1,
    generation,
    token,
    pid: Number(record["pid"]),
    createdAt: createdAt.data,
    expiresAt: expiresAt.data
  };
  return {
    path: input.claimPath,
    journalPath: input.journalPath,
    token: metadata.token,
    pid: metadata.pid,
    generation: metadata.generation,
    expiresAt: Date.parse(metadata.expiresAt)
  };
}

async function leaseClaims(journalAbsolutePath: string): Promise<readonly LeaseClaim[]> {
  const directory = path.dirname(journalAbsolutePath);
  const prefix = `${path.basename(journalAbsolutePath)}.lock.`;
  const claims: LeaseClaim[] = [];
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const claimPath = path.join(directory, name);
    try {
      claims.push(parsePublishedLeaseClaim({
        bytes: await readFile(claimPath, "utf8"),
        claimPath,
        journalPath: journalAbsolutePath
      }));
    } catch {
      const error = new Error("A malformed published acceptance lease is present.") as Error & { code: string };
      error.code = "EEXIST";
      throw error;
    }
  }
  return claims.sort((left, right) => right.generation - left.generation || right.token.localeCompare(left.token));
}

interface TransitionLockMetadata {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly token: string;
  readonly createdAt: string;
}

const TRANSITION_LOCK_KEYS = ["createdAt", "pid", "schemaVersion", "token"] as const;

function parseTransitionLock(bytes: string): TransitionLockMetadata {
  const value: unknown = JSON.parse(bytes);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed transition lock");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== TRANSITION_LOCK_KEYS.length || !TRANSITION_LOCK_KEYS.every((key, index) => keys[index] === key) ||
      record["schemaVersion"] !== 1 || !Number.isSafeInteger(record["pid"]) || Number(record["pid"]) < 1 ||
      typeof record["token"] !== "string" || record["token"].length === 0 ||
      !utcTimestampSchema.safeParse(record["createdAt"]).success) throw new Error("malformed transition lock");
  return {
    schemaVersion: 1,
    pid: Number(record["pid"]),
    token: record["token"],
    createdAt: String(record["createdAt"])
  };
}

function transitionLockBytes(metadata: TransitionLockMetadata): string {
  return `${JSON.stringify(metadata)}\n`;
}

function processDefinitelyAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH";
  }
}

function transitionBusyError(): Error & { code: string } {
  const error = new Error("An intake transition is already owned or cannot be recovered safely.") as Error & { code: string };
  error.code = "EEXIST";
  return error;
}

async function reclaimDeadTransitionLock(lockPath: string): Promise<boolean> {
  let observed: TransitionLockMetadata;
  try {
    observed = parseTransitionLock(await readFile(lockPath, "utf8"));
  } catch {
    throw transitionBusyError();
  }
  if (!processDefinitelyAbsent(observed.pid)) throw transitionBusyError();
  const quarantine = `${lockPath}.reclaim.${randomUUID()}`;
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
  let moved: TransitionLockMetadata;
  try {
    moved = parseTransitionLock(await readFile(quarantine, "utf8"));
  } catch {
    // The bytes changed between inspection and atomic quarantine. Retain them:
    // incomplete or malformed ownership is deliberately migration-required.
    try { await rename(quarantine, lockPath); } catch {
      // A newer owner already occupies the constant path; retaining the
      // quarantined bytes is the only conservative outcome.
    }
    throw transitionBusyError();
  }
  if (moved.token !== observed.token || moved.pid !== observed.pid || !processDefinitelyAbsent(moved.pid)) {
    try { await rename(quarantine, lockPath); } catch {
      // A newer constant owner already exists. The quarantined owner can no
      // longer validate the constant path and therefore cannot publish.
    }
    throw transitionBusyError();
  }
  await rm(quarantine);
  return true;
}

async function acquireDraftAcceptanceLease(repositoryRoot: string, draftId: string): Promise<DraftAcceptanceLease> {
  const resolved = await ensureProjectArtifactParent({ repositoryRoot, artifactPath: `.legion/project/intake/transactions/${INTAKE_TRANSITION_KEY}.lock` });
  // Published releases used a per-draft lease. Treat one as a competing claim
  // during migration so an older process can never race the global transition.
  if (draftId !== INTAKE_TRANSITION_KEY) {
    const legacy = await ensureProjectArtifactParent({
      repositoryRoot,
      artifactPath: `.legion/project/intake/transactions/${draftId}.json`
    });
    const legacyClaims = await leaseClaims(legacy.absolutePath);
    if (legacyClaims.some((claim) => claim.expiresAt > Date.now())) {
      const error = new Error("Draft acceptance is already leased.") as Error & { code: string };
      error.code = "EEXIST";
      throw error;
    }
  }
  const legacyGlobal = path.join(path.dirname(resolved.absolutePath), `${INTAKE_TRANSITION_KEY}.json`);
  const legacyGlobalClaims = await leaseClaims(legacyGlobal);
  if (legacyGlobalClaims.some((claim) => claim.expiresAt > Date.now())) throw transitionBusyError();

  for (;;) {
    const token = randomUUID();
    const metadata: TransitionLockMetadata = {
      schemaVersion: 1,
      pid: process.pid,
      token,
      createdAt: new Date().toISOString()
    };
    let handle;
    try {
      handle = await open(resolved.absolutePath, "wx", 0o600);
      await handle.writeFile(transitionLockBytes(metadata), "utf8");
      await handle.sync();
      await handle.close();
      const lease = { path: resolved.absolutePath, journalPath: resolved.absolutePath, token, generation: 1, pid: process.pid };
      if (!await renewAndValidateLease(lease)) throw transitionBusyError();
      return lease;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      if (!await reclaimDeadTransitionLock(resolved.absolutePath)) throw transitionBusyError();
    }
  }
}

async function renewAndValidateLease(lease: DraftAcceptanceLease): Promise<boolean> {
  try {
    const current = parseTransitionLock(await readFile(lease.path, "utf8"));
    return current.token === lease.token && current.pid === lease.pid;
  } catch {
    return false;
  }
}

async function assertTransitionLeaseOwned(lease: DraftAcceptanceLease): Promise<void> {
  if (await renewAndValidateLease(lease)) return;
  const error = new Error("The intake transition lock changed before the durable boundary.") as Error & { code: string };
  error.code = "ELEASELOST";
  throw error;
}

async function releaseDraftAcceptanceLease(
  lease: DraftAcceptanceLease,
  beforeRemove?: () => Promise<void> | void,
  beforeRename?: () => Promise<void> | void
): Promise<void> {
  await beforeRemove?.();
  if (!await renewAndValidateLease(lease)) return;
  await beforeRename?.();
  if (!await renewAndValidateLease(lease)) return;
  const quarantine = `${lease.path}.release.${lease.token}`;
  try {
    await rename(lease.path, quarantine);
    let metadata: TransitionLockMetadata;
    try {
      metadata = parseTransitionLock(await readFile(quarantine, "utf8"));
    } catch {
      try { await rename(quarantine, lease.path); } catch {
        // A successor already owns the constant path. Preserve the malformed
        // quarantined record rather than deleting state we cannot attribute.
      }
      return;
    }
    if (metadata.token === lease.token && metadata.pid === lease.pid) await rm(quarantine);
    else {
      try { await rename(quarantine, lease.path); } catch {
        // A successor already owns the constant path. Retain the quarantined
        // bytes rather than deleting ownership we do not hold.
      }
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  try {
    const transactionsDirectory = path.dirname(lease.path);
    await rmdir(transactionsDirectory);
    let ancestor = path.dirname(transactionsDirectory);
    for (let index = 0; index < 3; index += 1) {
      try { await rmdir(ancestor); } catch (error) {
        if (error && typeof error === "object" && "code" in error && ["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String(error.code))) break;
        throw error;
      }
      ancestor = path.dirname(ancestor);
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && ["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String(error.code)))) throw error;
  }
}

function acceptanceJournalPath(draftId: string): string {
  return `.legion/project/intake/transactions/${draftId}.json`;
}

function acceptanceJournalPublicationPath(draftId: string): string {
  return `${acceptanceJournalPath(draftId)}.tmp`;
}

function acceptanceRollbackMarkerPath(draftId: string): string {
  return `${acceptanceJournalPath(draftId)}.rollback`;
}

interface LegacyDraftAcceptanceJournal {
  readonly schemaVersion: 1;
  readonly draftId: string;
  readonly sessionId: string;
}

interface PublishingSessionAcceptanceJournal {
  readonly schemaVersion: 2;
  readonly phase: "publishing-session";
  readonly draftId: string;
  readonly sessionId: string;
  readonly draftSha256: string;
  readonly acceptedDraftSha256: string;
  readonly sessionSha256: string;
}

type DraftAcceptanceJournal = LegacyDraftAcceptanceJournal | PublishingSessionAcceptanceJournal;

type AcceptanceReservationState = "empty" | "missing" | "session-temporary" | "session-published";

interface PreparedAcceptanceRecovery {
  readonly kind: "prepared";
  readonly phase: "publishing-journal" | "prepared" | "publishing-session" | "rolling-back";
  readonly journal: DraftAcceptanceJournal;
  readonly journalPath: string;
  readonly rollbackMarkerPath: string;
  readonly journalRaw: Buffer;
  readonly draft: IntakeDraft;
  readonly draftRaw: Buffer;
  readonly reservationPath: string;
  readonly reservationState: AcceptanceReservationState;
  readonly sessionArtifactPath?: string;
  readonly sessionRaw?: Buffer;
  readonly reviewHash: string;
}

interface CommittedAcceptanceRecovery {
  readonly kind: "committed";
  readonly journal: DraftAcceptanceJournal;
  readonly journalPath: string;
  readonly journalRaw: Buffer;
  readonly draft: IntakeDraft;
  readonly draftRaw: Buffer;
  readonly session: IntakeSession;
  readonly sessionDirectoryPath: string;
  readonly sessionPath: string;
  readonly sessionRaw: Buffer;
}

type AcceptanceRecoveryCandidate = PreparedAcceptanceRecovery | CommittedAcceptanceRecovery;

interface LegacyAcceptanceOwnershipRecovery {
  readonly kind: "publication-temp" | "published-claim";
  readonly artifactPath: string;
  readonly journalPath: string;
  readonly raw: Buffer;
  readonly mtimeMs: number;
}

type AcceptanceRecoveryScope =
  | { readonly kind: "bare-acceptance" }
  | { readonly kind: "explicit-acceptance"; readonly draftId: string };

export type PendingAcceptanceRecoveryResult =
  | {
      readonly ok: true;
      readonly rolledBackDraftIds: readonly string[];
      readonly committed: readonly { readonly draft: IntakeDraft; readonly session: IntakeSession }[];
      readonly stoppedAfterMixedRecovery: boolean;
    }
  | { readonly ok: false; readonly diagnostics: readonly DraftStagingDiagnostic[] };

const LEGACY_ACCEPTANCE_JOURNAL_KEYS = ["draftId", "schemaVersion", "sessionId"] as const;
const PUBLISHING_SESSION_JOURNAL_KEYS = [
  "acceptedDraftSha256",
  "draftId",
  "draftSha256",
  "phase",
  "schemaVersion",
  "sessionId",
  "sessionSha256"
] as const;

function legacyAcceptanceOwnershipName(name: string): {
  readonly kind: "publication-temp" | "published-claim";
  readonly journalName: string;
} | undefined {
  const publication = /^((?:itd_[a-z0-9-]+|intake-transition)\.json)\.lock\.[0-9a-f-]{36}\.tmp$/u.exec(name);
  if (publication !== null) return { kind: "publication-temp", journalName: publication[1]! };
  const claim = /^((?:itd_[a-z0-9-]+|intake-transition)\.json)\.lock\.\d{8,}\.[^.]+\.json$/u.exec(name);
  return claim === null ? undefined : { kind: "published-claim", journalName: claim[1]! };
}

function pendingAcceptanceBlocked(message: string): DraftStagingDiagnostic {
  return { code: "pending_acceptance_blocked", message };
}

export function pendingAcceptanceRecovered(draftIds: readonly string[]): DraftStagingDiagnostic {
  return {
    code: "pending_acceptance_recovered",
    message: `Recovered interrupted acceptance for ${draftIds.join(", ")} by removing only its strictly verified journaled session publication, reservation, and transaction record. Retry the requested draft transition explicitly.`
  };
}

function pendingAcceptanceLifecycleError(
  code: "EPENDINGACCEPTANCEBLOCKED" | "EPENDINGACCEPTANCERECOVERED",
  diagnostics: readonly DraftStagingDiagnostic[]
): Error & { readonly code: string } {
  const error = new Error(diagnostics.map((diagnostic) => diagnostic.message).join(" ")) as Error & { code: string };
  error.code = code;
  return error;
}

function parseAcceptanceJournal(bytes: Buffer, filenameDraftId: string): DraftAcceptanceJournal {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("journal is not an object");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const draftId = intakeDraftIdSchema.parse(record["draftId"]);
  const sessionId = intakeSessionIdSchema.parse(record["sessionId"]);
  if (draftId !== filenameDraftId) throw new Error(`journal draft ${draftId} does not match filename ${filenameDraftId}`);
  if (record["schemaVersion"] === 1) {
    if (keys.length !== LEGACY_ACCEPTANCE_JOURNAL_KEYS.length ||
        !LEGACY_ACCEPTANCE_JOURNAL_KEYS.every((key, index) => keys[index] === key)) {
      throw new Error("journal shape is invalid");
    }
    return { schemaVersion: 1, draftId, sessionId };
  }
  if (record["schemaVersion"] !== 2 ||
      keys.length !== PUBLISHING_SESSION_JOURNAL_KEYS.length ||
      !PUBLISHING_SESSION_JOURNAL_KEYS.every((key, index) => keys[index] === key) ||
      record["phase"] !== "publishing-session" ||
      typeof record["draftSha256"] !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record["draftSha256"]) ||
      typeof record["acceptedDraftSha256"] !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record["acceptedDraftSha256"]) ||
      typeof record["sessionSha256"] !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record["sessionSha256"])) {
    throw new Error("journal shape is invalid");
  }
  return {
    schemaVersion: 2,
    phase: "publishing-session",
    draftId,
    sessionId,
    draftSha256: record["draftSha256"],
    acceptedDraftSha256: record["acceptedDraftSha256"],
    sessionSha256: record["sessionSha256"]
  };
}

async function assertCommittedSessionDirectoryShape(sessionDirectoryPath: string, sessionPath: string): Promise<void> {
  const directoryInfo = await lstat(sessionDirectoryPath);
  if (!directoryInfo.isDirectory()) throw new Error("committed session parent is not a regular directory");
  const entries = await readdir(sessionDirectoryPath, { withFileTypes: true });
  if (entries.length !== 1 || entries[0]?.name !== path.basename(sessionPath) || !entries[0].isFile()) {
    throw new Error("committed session directory contains unexpected state");
  }
  const sessionInfo = await lstat(sessionPath);
  if (!sessionInfo.isFile()) throw new Error("committed session is not a regular file");
}

async function inspectOpenAcceptanceReservation(input: {
  readonly repositoryRoot: string;
  readonly journal: DraftAcceptanceJournal;
  readonly draft: IntakeDraft;
  readonly reservationPath: string;
  readonly phase: PreparedAcceptanceRecovery["phase"];
}): Promise<{
  readonly reservationState: AcceptanceReservationState;
  readonly sessionArtifactPath?: string;
  readonly sessionRaw?: Buffer;
}> {
  let entries: Dirent[];
  try {
    const reservationInfo = await lstat(input.reservationPath);
    if (!reservationInfo.isDirectory()) throw new Error("session reservation is not a regular directory");
    entries = await readdir(input.reservationPath, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      const attributableSessionRollback = input.journal.schemaVersion === 2 && input.phase === "publishing-session";
      if (!["publishing-journal", "rolling-back"].includes(input.phase) && !attributableSessionRollback) {
        throw new Error("open-draft acceptance reservation is missing without a rollback marker");
      }
      return { reservationState: "missing" };
    }
    throw error;
  }
  if (entries.length === 0) return { reservationState: "empty" };
  if (input.journal.schemaVersion !== 2 || !["publishing-session", "rolling-back"].includes(input.phase)) {
    throw new Error("open-draft acceptance reservation contains unexpected state");
  }
  if (entries.length !== 1 || !entries[0]!.isFile() ||
      !["session.json.tmp", "session.json"].includes(entries[0]!.name)) {
    throw new Error("open-draft acceptance reservation contains unexpected state");
  }
  const isTemporary = entries[0]!.name === "session.json.tmp";
  const artifactPath = `${intakeSessionArtifactPath(input.journal.sessionId)}${isTemporary ? ".tmp" : ""}`;
  const resolved = await resolveProjectArtifactPath({ repositoryRoot: input.repositoryRoot, artifactPath });
  const info = await lstat(resolved.absolutePath);
  if (!info.isFile()) throw new Error("journaled session publication is not a regular file");
  const sessionRaw = await readFile(resolved.absolutePath);
  if (sha256(sessionRaw) !== input.journal.sessionSha256) {
    throw new Error("journaled session publication bytes do not match their transaction hash");
  }
  const session = intakeSessionSchema.parse(JSON.parse(sessionRaw.toString("utf8")));
  if (session.id !== input.journal.sessionId || !await sessionMatchesAcceptedDraft(input.repositoryRoot, session, input.draft)) {
    throw new Error("journaled session publication does not match draft provenance");
  }
  return {
    reservationState: isTemporary ? "session-temporary" : "session-published",
    sessionArtifactPath: resolved.absolutePath,
    sessionRaw
  };
}

async function acceptanceTransactionsDirectory(repositoryRoot: string): Promise<string> {
  const sentinel = await resolveProjectArtifactPath({
    repositoryRoot,
    artifactPath: ".legion/project/intake/transactions/.acceptance-scan"
  });
  return path.dirname(sentinel.absolutePath);
}

async function scanAcceptanceRecoveryCandidates(
  repositoryRoot: string,
  lease: DraftAcceptanceLease
): Promise<{
  readonly candidates: readonly AcceptanceRecoveryCandidate[];
  readonly ownershipArtifacts: readonly LegacyAcceptanceOwnershipRecovery[];
  readonly diagnostics: readonly DraftStagingDiagnostic[];
}> {
  await assertTransitionLeaseOwned(lease);
  const transactions = await acceptanceTransactionsDirectory(repositoryRoot);
  let entries: Dirent[];
  try {
    entries = await readdir(transactions, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { candidates: [], ownershipArtifacts: [], diagnostics: [] };
    }
    return {
      candidates: [],
      ownershipArtifacts: [],
      diagnostics: [pendingAcceptanceBlocked("Pending acceptance transactions cannot be inspected safely.")]
    };
  }

  const candidates: AcceptanceRecoveryCandidate[] = [];
  const ownershipArtifacts: LegacyAcceptanceOwnershipRecovery[] = [];
  const diagnostics: DraftStagingDiagnostic[] = [];
  const seenDraftIds = new Set<string>();
  const seenSessionIds = new Set<string>();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const ownership = legacyAcceptanceOwnershipName(entry.name);
    if (ownership !== undefined) {
      const artifactPath = path.join(transactions, entry.name);
      try {
        if (!entry.isFile()) throw new Error("ownership artifact is not a regular file");
        const info = await lstat(artifactPath);
        if (!info.isFile()) throw new Error("ownership artifact is not a regular file");
        const raw = await readFile(artifactPath);
        if (ownership.kind === "publication-temp") {
          if (Date.now() - info.mtimeMs <= ACCEPTANCE_LEASE_MS) {
            throw new Error("lease publication may still have a live owner");
          }
        } else {
          const claim = parsePublishedLeaseClaim({
            bytes: raw.toString("utf8"),
            claimPath: artifactPath,
            journalPath: path.join(transactions, ownership.journalName)
          });
          if (claim.expiresAt > Date.now()) throw new Error("published lease still has a live owner");
        }
        ownershipArtifacts.push({
          kind: ownership.kind,
          artifactPath,
          journalPath: path.join(transactions, ownership.journalName),
          raw,
          mtimeMs: info.mtimeMs
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        diagnostics.push(pendingAcceptanceBlocked(`Acceptance ownership artifact ${entry.name} cannot be crossed safely: ${message}.`));
      }
      continue;
    }
    if (!entry.name.startsWith("itd_")) continue;
    const publicationMatch = /^(itd_[a-z0-9-]+)\.json\.tmp$/u.exec(entry.name);
    const journalMatch = /^(itd_[a-z0-9-]+)\.json$/u.exec(entry.name);
    const rollbackMatch = /^(itd_[a-z0-9-]+)\.json\.rollback$/u.exec(entry.name);
    const match = publicationMatch ?? journalMatch ?? rollbackMatch;
    if (match === null) {
      diagnostics.push(pendingAcceptanceBlocked(`Acceptance-like transaction ${entry.name} is not a recognized journal, rollback marker, or ownership artifact.`));
      continue;
    }
    if (!entry.isFile()) {
      diagnostics.push(pendingAcceptanceBlocked(`Acceptance transaction ${entry.name} is not a strictly named regular journal.`));
      continue;
    }
    const filenameDraftId = match[1]!;
    try {
      const unresolvedPhase: PreparedAcceptanceRecovery["phase"] = publicationMatch !== null
        ? "publishing-journal"
        : rollbackMatch !== null
          ? "rolling-back"
          : "prepared";
      const resolvedJournal = await resolveProjectArtifactPath({
        repositoryRoot,
        artifactPath: publicationMatch !== null
          ? acceptanceJournalPublicationPath(filenameDraftId)
          : rollbackMatch !== null
            ? acceptanceRollbackMarkerPath(filenameDraftId)
            : acceptanceJournalPath(filenameDraftId)
      });
      const resolvedRollbackMarker = await resolveProjectArtifactPath({
        repositoryRoot,
        artifactPath: acceptanceRollbackMarkerPath(filenameDraftId)
      });
      const journalRaw = await readFile(resolvedJournal.absolutePath);
      const journal = parseAcceptanceJournal(journalRaw, filenameDraftId);
      const phase: PreparedAcceptanceRecovery["phase"] = unresolvedPhase === "prepared" && journal.schemaVersion === 2
        ? "publishing-session"
        : unresolvedPhase;
      if (seenDraftIds.has(journal.draftId) || seenSessionIds.has(journal.sessionId)) {
        diagnostics.push(pendingAcceptanceBlocked(`Acceptance transaction ${entry.name} duplicates a draft or session claim.`));
        continue;
      }
      seenDraftIds.add(journal.draftId);
      seenSessionIds.add(journal.sessionId);

      const resolvedDraft = await resolveProjectArtifactPath({
        repositoryRoot,
        artifactPath: draftArtifactPath(journal.draftId)
      });
      const draftInfo = await lstat(resolvedDraft.absolutePath);
      if (!draftInfo.isFile()) throw new Error("referenced draft is not a regular file");
      const draftRaw = await readFile(resolvedDraft.absolutePath);
      const draft = intakeDraftSchema.parse(JSON.parse(draftRaw.toString("utf8")));
      if (draft.id !== journal.draftId) throw new Error(`referenced draft declares ${draft.id}`);
      if (journal.schemaVersion === 2) {
        const expectedDraftSha256 = draft.status === "accepted" ? journal.acceptedDraftSha256 : journal.draftSha256;
        if (sha256(draftRaw) !== expectedDraftSha256) throw new Error("referenced draft bytes do not match their transaction hash");
      }

      const resolvedSession = await resolveProjectArtifactPath({
        repositoryRoot,
        artifactPath: intakeSessionArtifactPath(journal.sessionId)
      });
      const reservationPath = path.dirname(resolvedSession.absolutePath);
      if (draft.status === "draft") {
        const reservation = await inspectOpenAcceptanceReservation({
          repositoryRoot,
          journal,
          draft,
          reservationPath,
          phase
        });
        const active = await readActiveDraftReview(repositoryRoot);
        if (active.review === undefined || active.hash === undefined || active.review.state === "consumed" ||
            active.review.draftId !== draft.id || active.review.draftSha256 !== sha256(draftRaw)) {
          throw new Error("open draft is not bound to its exact active review");
        }
        candidates.push({
          kind: "prepared",
          phase,
          journal,
          journalPath: resolvedJournal.absolutePath,
          rollbackMarkerPath: resolvedRollbackMarker.absolutePath,
          journalRaw,
          draft,
          draftRaw,
          reservationPath,
          ...reservation,
          reviewHash: active.hash
        });
        continue;
      }
      if (phase === "rolling-back") throw new Error(`rollback marker references ${draft.status} draft`);
      if (phase === "publishing-journal") throw new Error(`journal publication temporary references ${draft.status} draft`);
      if (draft.status !== "accepted") throw new Error(`referenced draft is ${draft.status}`);
      await assertCommittedSessionDirectoryShape(reservationPath, resolvedSession.absolutePath);
      const sessionRaw = await readFile(resolvedSession.absolutePath);
      if (journal.schemaVersion === 2 && sha256(sessionRaw) !== journal.sessionSha256) {
        throw new Error("committed session bytes do not match their transaction hash");
      }
      const session = intakeSessionSchema.parse(JSON.parse(sessionRaw.toString("utf8")));
      if (session.id !== journal.sessionId || !await sessionMatchesAcceptedDraft(repositoryRoot, session, draft)) {
        throw new Error("committed session does not match accepted draft provenance");
      }
      candidates.push({
        kind: "committed",
        journal,
        journalPath: resolvedJournal.absolutePath,
        journalRaw,
        draft,
        draftRaw,
        session,
        sessionDirectoryPath: reservationPath,
        sessionPath: resolvedSession.absolutePath,
        sessionRaw
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ELEASELOST") throw error;
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push(pendingAcceptanceBlocked(`Acceptance transaction ${entry.name} is not recoverable automatically: ${message}`));
    }
  }
  if (candidates.filter((candidate) => candidate.kind === "prepared").length > 1) {
    diagnostics.push(pendingAcceptanceBlocked("Multiple prepared acceptance journals are present; their ownership is ambiguous."));
  }
  await assertTransitionLeaseOwned(lease);
  return { candidates, ownershipArtifacts, diagnostics };
}

async function assertLegacyAcceptanceOwnershipUnchanged(
  artifact: LegacyAcceptanceOwnershipRecovery,
  lease: DraftAcceptanceLease
): Promise<void> {
  await assertTransitionLeaseOwned(lease);
  const info = await lstat(artifact.artifactPath);
  if (!info.isFile() || info.mtimeMs !== artifact.mtimeMs) {
    throw new Error("acceptance ownership artifact changed during recovery");
  }
  const raw = await readFile(artifact.artifactPath);
  if (!raw.equals(artifact.raw)) throw new Error("acceptance ownership artifact changed during recovery");
  if (artifact.kind === "publication-temp") {
    if (Date.now() - info.mtimeMs <= ACCEPTANCE_LEASE_MS) {
      throw new Error("acceptance lease publication became live during recovery");
    }
  } else {
    const claim = parsePublishedLeaseClaim({
      bytes: raw.toString("utf8"),
      claimPath: artifact.artifactPath,
      journalPath: artifact.journalPath
    });
    if (claim.expiresAt > Date.now()) throw new Error("acceptance lease became live during recovery");
  }
  await assertTransitionLeaseOwned(lease);
}

async function assertAcceptanceRecoveryCandidateUnchanged(
  repositoryRoot: string,
  candidate: AcceptanceRecoveryCandidate,
  lease: DraftAcceptanceLease
): Promise<void> {
  await assertTransitionLeaseOwned(lease);
  if (!(await readFile(candidate.journalPath)).equals(candidate.journalRaw)) throw new Error("acceptance journal changed during recovery");
  const resolvedDraft = await resolveProjectArtifactPath({
    repositoryRoot,
    artifactPath: draftArtifactPath(candidate.journal.draftId)
  });
  if (!(await readFile(resolvedDraft.absolutePath)).equals(candidate.draftRaw)) throw new Error("acceptance draft changed during recovery");
  if (candidate.kind === "prepared") {
    const active = await readActiveDraftReview(repositoryRoot);
    if (active.hash !== candidate.reviewHash) throw new Error("active review changed during acceptance recovery");
    if (candidate.reservationState === "missing") {
      try {
        await lstat(candidate.reservationPath);
        throw new Error("acceptance reservation reappeared during recovery");
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
    } else {
      const info = await lstat(candidate.reservationPath);
      if (!info.isDirectory()) throw new Error("acceptance reservation changed during recovery");
      const entries = await readdir(candidate.reservationPath, { withFileTypes: true });
      if (candidate.reservationState === "empty") {
        if (entries.length !== 0) throw new Error("acceptance reservation changed during recovery");
      } else {
        if (candidate.sessionArtifactPath === undefined || candidate.sessionRaw === undefined || entries.length !== 1 ||
            !entries[0]!.isFile() || path.join(candidate.reservationPath, entries[0]!.name) !== candidate.sessionArtifactPath ||
            !(await readFile(candidate.sessionArtifactPath)).equals(candidate.sessionRaw)) {
          throw new Error("journaled session publication changed during recovery");
        }
      }
    }
  } else {
    await assertCommittedSessionDirectoryShape(candidate.sessionDirectoryPath, candidate.sessionPath);
    if (!(await readFile(candidate.sessionPath)).equals(candidate.sessionRaw)) {
      throw new Error("committed acceptance session changed during recovery");
    }
  }
  await assertTransitionLeaseOwned(lease);
}

async function reconcilePendingAcceptanceJournals(
  repositoryRoot: string,
  lease: DraftAcceptanceLease,
  hooks: {
    readonly beforeMutation?: () => Promise<void> | void;
    readonly afterReservationRemoved?: () => Promise<void> | void;
    readonly scope?: AcceptanceRecoveryScope;
  } = {}
): Promise<PendingAcceptanceRecoveryResult> {
  const scanned = await scanAcceptanceRecoveryCandidates(repositoryRoot, lease);
  if (scanned.diagnostics.length > 0) return { ok: false, diagnostics: scanned.diagnostics };

  const preparedCandidates = scanned.candidates.filter(
    (candidate): candidate is PreparedAcceptanceRecovery => candidate.kind === "prepared"
  );
  const committedCandidates = scanned.candidates.filter(
    (candidate): candidate is CommittedAcceptanceRecovery => candidate.kind === "committed"
  );
  const mixedAcceptanceState = preparedCandidates.length > 0 && committedCandidates.length > 0;
  let candidates: readonly AcceptanceRecoveryCandidate[] = mixedAcceptanceState
    ? preparedCandidates
    : scanned.candidates;
  const scope = hooks.scope;
  if (!mixedAcceptanceState && scope?.kind === "bare-acceptance") {
    if (committedCandidates.length > 1) {
      return {
        ok: false,
        diagnostics: [pendingAcceptanceBlocked("Multiple committed acceptance journals are present; name the draft to replay its session.")]
      };
    }
    if (committedCandidates.length === 1) candidates = committedCandidates;
  } else if (!mixedAcceptanceState && scope?.kind === "explicit-acceptance" && committedCandidates.length > 0) {
    const selected = committedCandidates.find((candidate) => candidate.draft.id === scope.draftId);
    if (selected === undefined) {
      return {
        ok: false,
        diagnostics: [pendingAcceptanceBlocked(`Committed acceptance journals exist, but none belongs to requested draft ${scope.draftId}.`)]
      };
    }
    candidates = [selected];
  }

  for (const artifact of scanned.ownershipArtifacts) {
    try {
      await hooks.beforeMutation?.();
      await assertLegacyAcceptanceOwnershipUnchanged(artifact, lease);
      await assertTransitionLeaseOwned(lease);
      await rm(artifact.artifactPath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ELEASELOST") throw error;
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        diagnostics: [pendingAcceptanceBlocked(`Acceptance ownership artifact ${path.basename(artifact.artifactPath)} changed before recovery: ${message}`)]
      };
    }
  }

  const rolledBackDraftIds: string[] = [];
  const committed: { draft: IntakeDraft; session: IntakeSession }[] = [];
  for (const candidate of candidates) {
    try {
      await hooks.beforeMutation?.();
      if (candidate.kind === "prepared") {
        let rollback = candidate;
        if (candidate.phase !== "rolling-back") {
          await assertAcceptanceRecoveryCandidateUnchanged(repositoryRoot, candidate, lease);
          await assertTransitionLeaseOwned(lease);
          await rename(candidate.journalPath, candidate.rollbackMarkerPath);
          rollback = {
            ...candidate,
            phase: "rolling-back",
            journalPath: candidate.rollbackMarkerPath
          };
        }
        if (rollback.reservationState === "session-temporary" || rollback.reservationState === "session-published") {
          await assertAcceptanceRecoveryCandidateUnchanged(repositoryRoot, rollback, lease);
          if (rollback.sessionArtifactPath === undefined) throw new Error("journaled session publication path is missing");
          await assertTransitionLeaseOwned(lease);
          await rm(rollback.sessionArtifactPath);
          const {
            sessionArtifactPath: _removedSessionArtifactPath,
            sessionRaw: _removedSessionRaw,
            ...withoutSessionPublication
          } = rollback;
          rollback = {
            ...withoutSessionPublication,
            reservationState: "empty"
          };
        }
        if (rollback.reservationState === "empty") {
          await assertAcceptanceRecoveryCandidateUnchanged(repositoryRoot, rollback, lease);
          await assertTransitionLeaseOwned(lease);
          await rmdir(rollback.reservationPath);
          await hooks.afterReservationRemoved?.();
          rollback = { ...rollback, reservationState: "missing" };
        }
        await assertAcceptanceRecoveryCandidateUnchanged(repositoryRoot, rollback, lease);
        await assertTransitionLeaseOwned(lease);
        await rm(rollback.journalPath);
        rolledBackDraftIds.push(rollback.draft.id);
      } else {
        await assertAcceptanceRecoveryCandidateUnchanged(repositoryRoot, candidate, lease);
        await assertTransitionLeaseOwned(lease);
        await rm(candidate.journalPath);
        committed.push({ draft: candidate.draft, session: candidate.session });
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ELEASELOST") throw error;
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        diagnostics: [pendingAcceptanceBlocked(`Acceptance transaction ${candidate.journal.draftId} changed before recovery: ${message}`)]
      };
    }
  }
  return { ok: true, rolledBackDraftIds, committed, stoppedAfterMixedRecovery: mixedAcceptanceState };
}

async function writeAcceptanceJournal(
  repositoryRoot: string,
  journal: PublishingSessionAcceptanceJournal,
  lease: DraftAcceptanceLease,
  afterTemporaryWrite?: () => Promise<void> | void
): Promise<void> {
  const validated = parseAcceptanceJournal(
    Buffer.from(`${JSON.stringify(journal)}\n`, "utf8"),
    journal.draftId
  );
  if (validated.schemaVersion !== 2) throw new Error("acceptance journal did not retain its publication phase");
  await assertTransitionLeaseOwned(lease);
  const resolved = await ensureProjectArtifactParent({ repositoryRoot, artifactPath: acceptanceJournalPath(journal.draftId) });
  const temporaryResolved = await resolveProjectArtifactPath({
    repositoryRoot,
    artifactPath: acceptanceJournalPublicationPath(journal.draftId)
  });
  const temporary = temporaryResolved.absolutePath;
  await assertTransitionLeaseOwned(lease);
  await rm(temporary, { force: true });
  await assertTransitionLeaseOwned(lease);
  await writeFile(temporary, `${JSON.stringify(validated)}\n`, { encoding: "utf8", flag: "wx" });
  await afterTemporaryWrite?.();
  await assertTransitionLeaseOwned(lease);
  await rename(temporary, resolved.absolutePath);
}

async function removeAcceptanceJournal(repositoryRoot: string, draftId: string, lease: DraftAcceptanceLease): Promise<void> {
  const resolved = await resolveProjectArtifactPath({ repositoryRoot, artifactPath: acceptanceJournalPath(draftId) });
  await assertTransitionLeaseOwned(lease);
  await rm(resolved.absolutePath, { force: true });
}

async function sessionMatchesAcceptedDraft(
  repositoryRoot: string,
  session: IntakeSession,
  draft: IntakeDraft
): Promise<boolean> {
  const replayed = await replayDraft(repositoryRoot, draft);
  if (!replayed.ok || session.answers.length !== replayed.previewSession.answers.length) return false;
  return replayed.previewSession.answers.every((expected) => session.answers.some((answer) =>
    answer.nodeId === expected.nodeId && answer.slot === expected.slot &&
    JSON.stringify(answer.value) === JSON.stringify(expected.value) &&
    answer.source === "draft-accepted" &&
    answer.draftAcceptedFrom?.draftId === expected.draftAcceptedFrom?.draftId &&
    answer.draftAcceptedFrom?.answerAnchor === expected.draftAcceptedFrom?.answerAnchor
  ));
}

/** Recover only lifecycle artifacts whose outcome is already unambiguous. */
async function recoverIntakeLifecycleArtifactsWithLease(
  repositoryRoot: string,
  recoveryLease: DraftAcceptanceLease,
  hooks: {
    readonly beforeAcceptanceJournalCleanup?: () => Promise<void> | void;
    readonly afterAcceptanceReservationRemoved?: () => Promise<void> | void;
  } = {}
): Promise<PendingAcceptanceRecoveryResult> {
  const acceptance = await reconcilePendingAcceptanceJournals(repositoryRoot, recoveryLease, {
    ...(hooks.beforeAcceptanceJournalCleanup === undefined
      ? {}
      : { beforeMutation: hooks.beforeAcceptanceJournalCleanup }),
    ...(hooks.afterAcceptanceReservationRemoved === undefined
      ? {}
      : { afterReservationRemoved: hooks.afterAcceptanceReservationRemoved })
  });
  if (!acceptance.ok) return acceptance;
  if (acceptance.rolledBackDraftIds.length > 0) return acceptance;
  try {
    await assertTransitionLeaseOwned(recoveryLease);
    await recoverDraftReplacement(repositoryRoot, recoveryLease);
    await assertTransitionLeaseOwned(recoveryLease);
    try {
      const review = (await readActiveDraftReview(repositoryRoot)).review;
      if (review !== undefined) {
        const draft = await loadStagedDraft(repositoryRoot, review.draftId);
        if (draft !== undefined && draft.status !== "draft") {
          await consumeActiveReviewForDraft(repositoryRoot, review.draftId, recoveryLease);
        }
      }
    } catch {
      // Retain malformed or concurrently changed review state for explicit repair.
    }

    // A published final makes same-draft staging temporaries unambiguously abandoned.
    const drafts = path.join(repositoryRoot, ".legion", "project", "intake", "drafts");
    try {
      const names = await readdir(drafts);
      for (const name of names) {
        const match = /^(itd_[a-z0-9-]+\.json)\.[^.]+\.tmp$/u.exec(name);
        if (match === null || !names.includes(match[1]!)) continue;
        await assertTransitionLeaseOwned(recoveryLease);
        await rm(path.join(drafts, name), { force: true });
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
  } catch {
    // Live, malformed, incomplete, or conflicting ownership and replacement
    // state stays blocking; recovery never guesses through it.
  }
  return acceptance;
}

export async function recoverIntakeLifecycleArtifacts(
  repositoryRoot: string,
  hooks: {
    readonly beforeAcceptanceJournalCleanup?: () => Promise<void> | void;
    readonly afterAcceptanceReservationRemoved?: () => Promise<void> | void;
  } = {}
): Promise<PendingAcceptanceRecoveryResult | undefined> {
  let recoveryLease: DraftAcceptanceLease | undefined;
  try {
    recoveryLease = await acquireDraftAcceptanceLease(repositoryRoot, INTAKE_TRANSITION_KEY);
    return await recoverIntakeLifecycleArtifactsWithLease(repositoryRoot, recoveryLease, hooks);
  } catch {
    // A public best-effort recovery never steals or waits for another owner.
    // Mutation-capable callers that need a hard busy result acquire the lease
    // themselves and pass it to the owned recovery path above.
    return undefined;
  } finally {
    if (recoveryLease !== undefined) await releaseDraftAcceptanceLease(recoveryLease);
  }
}

export async function publishDraftReview(input: {
  readonly repositoryRoot: string;
  readonly draftId: string;
  readonly updatedAt?: string;
  readonly beforeReviewPublication?: () => Promise<void> | void;
}): Promise<PublishDraftReviewResult> {
  let lease: DraftAcceptanceLease;
  try {
    lease = await acquireDraftAcceptanceLease(input.repositoryRoot, input.draftId);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return {
      ok: false,
      diagnostics: [{ code: "draft_transition_in_progress", message: "Another intake draft transition is in progress." }]
    };
    throw error;
  }
  try {
    const acceptance = await reconcilePendingAcceptanceJournals(input.repositoryRoot, lease);
    if (!acceptance.ok) return { ok: false, diagnostics: acceptance.diagnostics };
    if (acceptance.rolledBackDraftIds.length > 0) return {
      ok: false,
      diagnostics: [pendingAcceptanceRecovered(acceptance.rolledBackDraftIds)]
    };
    const scanned = await inspectActiveDraftCandidates(input.repositoryRoot);
    if (!scanned.ok) return scanned;
    const open = scanned.drafts;
    if (open.length > 1) return {
      ok: false,
      diagnostics: [{ code: "ambiguous_active_drafts", message: "Multiple open intake drafts exist; no review can be selected safely." }]
    };
    if (open[0]?.id !== input.draftId) return {
      ok: false,
      diagnostics: [{ code: "draft_not_open", message: `Draft ${input.draftId} is not the single open draft.` }]
    };
    const resolved = await resolveProjectArtifactPath({ repositoryRoot: input.repositoryRoot, artifactPath: draftArtifactPath(input.draftId) });
    const raw = await readFile(resolved.absolutePath);
    const draft = intakeDraftSchema.parse(JSON.parse(raw.toString("utf8")));
    const binding = await validateDraftPreflightBinding(
      { repositoryRoot: input.repositoryRoot, draft, ...(input.updatedAt === undefined ? {} : { now: input.updatedAt }) },
      lease
    );
    const evidence = await validateDraftEvidence(input.repositoryRoot, draft);
    const drift = [...binding, ...evidence];
    if (drift.length > 0) {
      const invalidated = intakeDraftSchema.parse({ ...draft, status: "invalidated" });
      await assertTransitionLeaseOwned(lease);
      await writeDraftCas(input.repositoryRoot, invalidated, createHash("sha256").update(raw).digest("hex"), lease);
      await assertTransitionLeaseOwned(lease);
      await markActiveReview(input.repositoryRoot, {
        state: "unreviewed",
        draftId: draft.id,
        draftSha256: sha256(raw),
        ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt })
      }, lease);
      return {
        ok: false,
        diagnostics: [...drift, { code: "replacement_draft_required", message: `Draft ${draft.id} was invalidated without changing its content; stage and display a new draft ID.` }]
      };
    }
    const replayed = await replayDraft(input.repositoryRoot, draft);
    if (!replayed.ok) return replayed;
    await input.beforeReviewPublication?.();
    await assertTransitionLeaseOwned(lease);
    const review = await markActiveReview(input.repositoryRoot, {
      state: "reviewed",
      draftId: draft.id,
      draftSha256: sha256(raw),
      ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt })
    }, lease);
    return { ok: true, draft, review, artifactPath: draftArtifactPath(draft.id) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      diagnostics: [{
        code: error && typeof error === "object" && "code" in error && error.code === "ELEASELOST"
          ? "draft_transition_lease_lost"
          : "invalid_draft",
        message
      }]
    };
  } finally {
    await releaseDraftAcceptanceLease(lease);
  }
}

export async function resolveReviewedDraftDecision(input: {
  readonly repositoryRoot: string;
  readonly explicitDraftId?: string;
}): Promise<{ readonly ok: true; readonly draftId: string } | { readonly ok: false; readonly diagnostics: readonly DraftStagingDiagnostic[] }> {
  const scanned = await inspectActiveDraftCandidates(input.repositoryRoot);
  if (!scanned.ok) return scanned;
  const open = scanned.drafts;
  if (open.length > 1) return {
    ok: false,
    diagnostics: [{ code: "ambiguous_active_drafts", message: "Multiple open intake drafts exist; name and repair them before making a decision." }]
  };
  let active: ActiveDraftReview | undefined;
  try { active = (await readActiveDraftReview(input.repositoryRoot)).review; } catch {
    return { ok: false, diagnostics: [{ code: "invalid_active_review", message: "The active review record is unreadable and must be repaired." }] };
  }
  if (active === undefined || active.state !== "reviewed") return {
    ok: false,
    diagnostics: [{ code: "draft_review_required", message: "Display a fully validated draft review before accepting or discarding it." }]
  };
  if (input.explicitDraftId !== undefined && input.explicitDraftId !== active.draftId) return {
    ok: false,
    diagnostics: [{ code: "stale_draft_decision", message: `Draft ${input.explicitDraftId} is not the currently displayed draft ${active.draftId}.` }]
  };
  if (open[0]?.id !== active.draftId) return {
    ok: false,
    diagnostics: [{ code: "stale_draft_decision", message: `Displayed draft ${active.draftId} is no longer the single open draft.` }]
  };
  return { ok: true, draftId: active.draftId };
}

interface ReviewedDraftBinding {
  readonly recordHash: string;
  readonly review: ActiveDraftReview;
}

type ReviewedBindingValidation =
  | { readonly ok: true; readonly binding: ReviewedDraftBinding }
  | { readonly ok: false; readonly diagnostics: readonly DraftStagingDiagnostic[] };

async function validateReviewedBinding(
  repositoryRoot: string,
  draftId: string,
  raw: Buffer,
  lease: DraftAcceptanceLease,
  beforeMismatchRebind?: () => Promise<void> | void,
  expected?: ReviewedDraftBinding
): Promise<ReviewedBindingValidation> {
  const scanned = await inspectActiveDraftCandidates(repositoryRoot);
  if (!scanned.ok) return { ok: false, diagnostics: scanned.diagnostics };
  const open = scanned.drafts;
  if (open.length > 1) return {
    ok: false,
    diagnostics: [{ code: "ambiguous_active_drafts", message: "Multiple open intake drafts exist; no decision is safe." }]
  };
  const current = await readActiveDraftReview(repositoryRoot);
  const review = current.review;
  if (review === undefined || current.hash === undefined || review.state !== "reviewed") return {
    ok: false,
    diagnostics: [{ code: "draft_review_required", message: "Display this draft review before making a decision." }]
  };
  if (review.draftId !== draftId) return {
    ok: false,
    diagnostics: [{ code: "stale_draft_decision", message: `Draft ${draftId} is not the currently displayed draft ${review.draftId}.` }]
  };
  if (review.draftSha256 !== sha256(raw)) {
    await beforeMismatchRebind?.();
    if (!await renewAndValidateLease(lease)) return {
      ok: false,
      diagnostics: [{
        code: "draft_transition_lease_lost",
        message: `Draft ${draftId} transition ownership changed before the review binding could be updated.`
      }]
    };
    await markActiveReview(repositoryRoot, { state: "unreviewed", draftId: review.draftId, draftSha256: review.draftSha256 }, lease);
    return {
      ok: false,
      diagnostics: [{ code: "displayed_draft_changed", message: `Draft ${draftId} bytes changed after display; display a new validated review.` }]
    };
  }
  const binding = { recordHash: current.hash, review };
  if (expected !== undefined && (
    binding.recordHash !== expected.recordHash ||
    binding.review.token !== expected.review.token ||
    binding.review.state !== expected.review.state ||
    binding.review.draftId !== expected.review.draftId ||
    binding.review.draftSha256 !== expected.review.draftSha256
  )) {
    return {
      ok: false,
      diagnostics: [{ code: "stale_draft_decision", message: `The displayed review binding for draft ${draftId} changed before the decision boundary.` }]
    };
  }
  return { ok: true, binding };
}

async function revalidateDraftDecisionBoundary(input: {
  readonly repositoryRoot: string;
  readonly draft: IntakeDraft;
  readonly expectedRaw: Buffer;
  readonly lease: DraftAcceptanceLease;
  readonly now?: string;
  readonly requireReviewed: boolean;
  readonly expectedReviewedBinding?: ReviewedDraftBinding;
}): Promise<ReplayDraftResult> {
  await assertTransitionLeaseOwned(input.lease);
  const resolved = await resolveProjectArtifactPath({
    repositoryRoot: input.repositoryRoot,
    artifactPath: draftArtifactPath(input.draft.id)
  });
  let currentRaw: Buffer;
  try {
    currentRaw = await readFile(resolved.absolutePath);
  } catch {
    return {
      ok: false,
      diagnostics: [{ code: "draft_not_found", message: `No staged intake draft ${input.draft.id} exists.` }]
    };
  }
  if (!currentRaw.equals(input.expectedRaw)) {
    return {
      ok: false,
      diagnostics: [{ code: "displayed_draft_changed", message: `Draft ${input.draft.id} bytes changed before the decision boundary.` }]
    };
  }
  const reviewed = input.requireReviewed
    ? await validateReviewedBinding(
        input.repositoryRoot,
        input.draft.id,
        currentRaw,
        input.lease,
        undefined,
        input.expectedReviewedBinding
      )
    : undefined;
  const reviewDiagnostics = reviewed === undefined || reviewed.ok ? [] : reviewed.diagnostics;
  const bindingDiagnostics = await validateDraftPreflightBinding({
    repositoryRoot: input.repositoryRoot,
    draft: input.draft,
    ...(input.now === undefined ? {} : { now: input.now })
  }, input.lease);
  const evidenceDiagnostics = await validateDraftEvidence(input.repositoryRoot, input.draft);
  const diagnostics = [...reviewDiagnostics, ...bindingDiagnostics, ...evidenceDiagnostics];
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  const replayed = await replayDraft(input.repositoryRoot, input.draft);
  await assertTransitionLeaseOwned(input.lease);
  return replayed;
}

export type DiscardStagedDraftResult =
  | { readonly ok: true; readonly status: "discarded"; readonly draft: IntakeDraft }
  | { readonly ok: false; readonly status: "draft_review"; readonly diagnostics: readonly DraftStagingDiagnostic[] };

/** Durably close one exact staged draft without allocating or modifying a session. */
export async function discardStagedDraft(input: {
  readonly repositoryRoot: string;
  readonly draftId: string;
  readonly requireReviewed?: boolean;
  readonly afterLeaseAcquired?: (leasePath: string) => Promise<void> | void;
  readonly beforeActiveReviewMismatchRebind?: () => Promise<void> | void;
  readonly beforeLeaseReleaseRename?: () => Promise<void> | void;
  readonly afterInitialBindingValidation?: () => Promise<void> | void;
}): Promise<DiscardStagedDraftResult> {
  let lease: DraftAcceptanceLease;
  try {
    lease = await acquireDraftAcceptanceLease(input.repositoryRoot, input.draftId);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      return {
        ok: false,
        status: "draft_review",
        diagnostics: [{ code: "draft_transition_in_progress", message: `Draft ${input.draftId} is already being accepted or discarded.` }]
      };
    }
    throw error;
  }

  try {
    await input.afterLeaseAcquired?.(lease.path);
    const acceptance = await reconcilePendingAcceptanceJournals(input.repositoryRoot, lease);
    if (!acceptance.ok) return { ok: false, status: "draft_review", diagnostics: acceptance.diagnostics };
    if (acceptance.rolledBackDraftIds.length > 0) return {
      ok: false,
      status: "draft_review",
      diagnostics: [pendingAcceptanceRecovered(acceptance.rolledBackDraftIds)]
    };
    const foundSession = await findActiveSession(input.repositoryRoot);
    if (!foundSession.ok) {
      return { ok: false, status: "draft_review", diagnostics: [{ code: "invalid_session", message: foundSession.reason }] };
    }
    if (foundSession.session !== undefined) {
      return {
        ok: false,
        status: "draft_review",
        diagnostics: [{ code: "active_session", message: `Session ${foundSession.session.id} is already active; a draft cannot be discarded after session creation.` }]
      };
    }

    const resolved = await resolveProjectArtifactPath({
      repositoryRoot: input.repositoryRoot,
      artifactPath: draftArtifactPath(input.draftId)
    });
    let bytes: Buffer;
    let draft: IntakeDraft;
    try {
      bytes = await readFile(resolved.absolutePath);
      draft = intakeDraftSchema.parse(JSON.parse(bytes.toString("utf8")));
    } catch {
      return {
        ok: false,
        status: "draft_review",
        diagnostics: [{ code: "draft_not_found", message: `No staged intake draft ${input.draftId} exists.` }]
      };
    }
    if (draft.status !== "draft") {
      return {
        ok: false,
        status: "draft_review",
        diagnostics: [{ code: "draft_not_open", message: `Draft ${draft.id} is ${draft.status}, not open for discard.` }]
      };
    }
    let reviewedBinding: ReviewedDraftBinding | undefined;
    if (input.requireReviewed === true) {
      const reviewed = await validateReviewedBinding(
        input.repositoryRoot,
        draft.id,
        bytes,
        lease,
        input.beforeActiveReviewMismatchRebind
      );
      if (!reviewed.ok) return { ok: false, status: "draft_review", diagnostics: reviewed.diagnostics };
      reviewedBinding = reviewed.binding;
    }
    await input.afterInitialBindingValidation?.();
    const finalStaged = await revalidateDraftDecisionBoundary({
      repositoryRoot: input.repositoryRoot,
      draft,
      expectedRaw: bytes,
      lease,
      requireReviewed: input.requireReviewed === true,
      ...(reviewedBinding === undefined ? {} : { expectedReviewedBinding: reviewedBinding })
    });
    if (!finalStaged.ok) return { ok: false, status: "draft_review", diagnostics: finalStaged.diagnostics };
    const discarded = intakeDraftSchema.parse({ ...draft, status: "discarded" });
    await writeDraftCas(input.repositoryRoot, discarded, createHash("sha256").update(bytes).digest("hex"), lease);
    if (await renewAndValidateLease(lease)) await consumeActiveReviewForDraft(input.repositoryRoot, draft.id, lease);
    return { ok: true, status: "discarded", draft: discarded };
  } finally {
    await releaseDraftAcceptanceLease(lease, undefined, input.beforeLeaseReleaseRename);
  }
}

/** Recheck evidence, then create one fully populated session file. */
export async function acceptStagedDraft(input: {
  readonly repositoryRoot: string;
  readonly draftId?: string;
  readonly createdAt: IntakeSession["createdAt"];
  readonly requireReviewed?: boolean;
  readonly beforeDraftCommit?: () => Promise<void> | void;
  readonly afterLeaseAcquired?: (leasePath: string) => Promise<void> | void;
  readonly afterDraftCommit?: () => Promise<void> | void;
  readonly beforeJournalCleanup?: () => Promise<void> | void;
  readonly afterAcceptanceJournal?: () => Promise<void> | void;
  readonly afterAcceptanceJournalTemporaryWrite?: () => Promise<void> | void;
  readonly beforeLeaseRelease?: () => Promise<void> | void;
  readonly beforeLeaseReleaseRename?: () => Promise<void> | void;
  readonly beforeAcceptanceRecoveryMutation?: () => Promise<void> | void;
  readonly beforeActiveReviewMismatchRebind?: () => Promise<void> | void;
  readonly beforeSessionPublish?: () => Promise<void> | void;
  readonly afterSessionTemporaryWrite?: () => Promise<void> | void;
  readonly afterSessionPublish?: () => Promise<void> | void;
  readonly afterInitialBindingValidation?: () => Promise<void> | void;
}): Promise<AcceptStagedDraftResult> {
  const requestedDraftId = input.draftId;
  const requestedLabel = requestedDraftId === undefined ? "The reviewed draft" : `Draft ${requestedDraftId}`;
  let lease: DraftAcceptanceLease;
  try {
    lease = await acquireDraftAcceptanceLease(input.repositoryRoot, requestedDraftId ?? INTAKE_TRANSITION_KEY);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      return {
        ok: false,
        status: "draft_review",
        diagnostics: [{ code: "draft_acceptance_in_progress", message: `${requestedLabel} is already being accepted.` }]
      };
    }
    throw error;
  }

  try {
  await input.afterLeaseAcquired?.(lease.path);
  if (!await renewAndValidateLease(lease)) {
    return { ok: false, status: "draft_review", diagnostics: [{ code: "draft_acceptance_lease_lost", message: `${requestedLabel} acceptance lease was superseded.` }] };
  }
  let acceptance: PendingAcceptanceRecoveryResult;
  try {
    acceptance = await reconcilePendingAcceptanceJournals(input.repositoryRoot, lease, {
      scope: requestedDraftId === undefined
        ? { kind: "bare-acceptance" }
        : { kind: "explicit-acceptance", draftId: requestedDraftId },
      ...(input.beforeAcceptanceRecoveryMutation === undefined
        ? {}
        : { beforeMutation: input.beforeAcceptanceRecoveryMutation })
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ELEASELOST") {
      return {
        ok: false,
        status: "draft_review",
        diagnostics: [{ code: "draft_acceptance_lease_lost", message: `${requestedLabel} acceptance ownership changed during recovery.` }]
      };
    }
    throw error;
  }
  if (!acceptance.ok) return { ok: false, status: "draft_review", diagnostics: acceptance.diagnostics };
  if (acceptance.stoppedAfterMixedRecovery) {
    return {
      ok: false,
      status: "draft_review",
      diagnostics: [pendingAcceptanceRecovered(acceptance.rolledBackDraftIds)]
    };
  }
  const committedAcceptance = requestedDraftId === undefined
    ? acceptance.committed.length === 1 ? acceptance.committed[0] : undefined
    : acceptance.committed.find((candidate) => candidate.draft.id === requestedDraftId);
  if (committedAcceptance !== undefined) {
    return { ok: true, status: "interview", draft: committedAcceptance.draft, session: committedAcceptance.session };
  }
  if (acceptance.rolledBackDraftIds.length > 0 && requestedDraftId !== undefined && !acceptance.rolledBackDraftIds.includes(requestedDraftId)) {
    return {
      ok: false,
      status: "draft_review",
      diagnostics: [pendingAcceptanceRecovered(acceptance.rolledBackDraftIds)]
    };
  }
  let draftId = requestedDraftId;
  if (input.requireReviewed === true) {
    await assertTransitionLeaseOwned(lease);
    const target = await resolveReviewedDraftDecision({
      repositoryRoot: input.repositoryRoot,
      ...(requestedDraftId === undefined ? {} : { explicitDraftId: requestedDraftId })
    });
    await assertTransitionLeaseOwned(lease);
    if (!target.ok) return { ok: false, status: "draft_review", diagnostics: target.diagnostics };
    draftId = target.draftId;
  }
  if (draftId === undefined) {
    return {
      ok: false,
      status: "draft_review",
      diagnostics: [{ code: "draft_not_found", message: "Name a staged draft for acceptance." }]
    };
  }
  const draftResolved = await resolveProjectArtifactPath({
    repositoryRoot: input.repositoryRoot,
    artifactPath: draftArtifactPath(draftId)
  });
  let draftRaw: Buffer;
  let draft: IntakeDraft | undefined;
  try {
    draftRaw = await readFile(draftResolved.absolutePath);
    draft = intakeDraftSchema.parse(JSON.parse(draftRaw.toString("utf8")));
  } catch {
    draftRaw = Buffer.alloc(0);
    draft = undefined;
  }
  if (draft === undefined) {
    return {
      ok: false,
      status: "draft_review",
      diagnostics: [{ code: "draft_not_found", message: `No staged intake draft ${draftId} exists.` }]
    };
  }
  if (draft.status !== "draft") {
    return {
      ok: false,
      status: "draft_review",
      diagnostics: [{ code: "draft_not_open", message: `Draft ${draft.id} is ${draft.status}, not open for acceptance.` }]
    };
  }
  let reviewedBinding: ReviewedDraftBinding | undefined;
  if (input.requireReviewed === true) {
    const reviewed = await validateReviewedBinding(
      input.repositoryRoot,
      draft.id,
      draftRaw,
      lease,
      input.beforeActiveReviewMismatchRebind
    );
    if (!reviewed.ok) return { ok: false, status: "draft_review", diagnostics: reviewed.diagnostics };
    reviewedBinding = reviewed.binding;
  }

  const foundSession = await findActiveSession(input.repositoryRoot);
  if (!foundSession.ok) {
    return { ok: false, status: "draft_review", diagnostics: [{ code: "invalid_session", message: foundSession.reason }] };
  }
  if (foundSession.session !== undefined) {
    return {
      ok: false,
      status: "draft_review",
      diagnostics: [{ code: "active_session", message: `Session ${foundSession.session.id} is already active; abort it before accepting ${draft.id}.` }]
    };
  }

  const bindingDiagnostics = await validateDraftPreflightBinding({
    repositoryRoot: input.repositoryRoot,
    draft,
    now: input.createdAt
  }, lease);
  const expectedDraftHash = createHash("sha256").update(draftRaw).digest("hex");
  const evidenceDiagnostics = await validateDraftEvidence(input.repositoryRoot, draft);
  const driftDiagnostics = [...bindingDiagnostics, ...evidenceDiagnostics];
  if (driftDiagnostics.length > 0) {
    const invalidated = intakeDraftSchema.parse({ ...draft, status: "invalidated" });
    if (!await renewAndValidateLease(lease)) {
      return { ok: false, status: "draft_review", diagnostics: [{ code: "draft_acceptance_lease_lost", message: `Draft ${draft.id} acceptance lease was superseded before evidence-drift update.` }] };
    }
    await writeDraftCas(input.repositoryRoot, invalidated, expectedDraftHash, lease);
    if (input.requireReviewed === true && await renewAndValidateLease(lease)) {
      await markActiveReview(input.repositoryRoot, { state: "unreviewed", draftId: draft.id, draftSha256: sha256(draftRaw) }, lease);
    }
    return {
      ok: false,
      status: "draft_review",
      diagnostics: [...driftDiagnostics, { code: "replacement_draft_required", message: `Draft ${draft.id} was invalidated without changing its content; stage and display a new draft ID.` }]
    };
  }

  // Re-run the graph/answer staging gate while the caller still owns the
  // global transition lease. Calling the public staging entry here would
  // attempt to reacquire that same non-reentrant lease.
  const staged = await replayDraft(input.repositoryRoot, draft);
  if (!staged.ok) return { ok: false, status: "draft_review", diagnostics: staged.diagnostics };
  await input.afterInitialBindingValidation?.();
  await assertTransitionLeaseOwned(lease);

  // Preparation uses this same global lease, so the repeated read both proves
  // the durable binding survived the initial validation and fences it through
  // the session/draft commit below. Evidence is re-read as well because those
  // source artifacts are not themselves transition records.
  const finalStaged = await revalidateDraftDecisionBoundary({
    repositoryRoot: input.repositoryRoot,
    draft,
    expectedRaw: draftRaw,
    lease,
    now: input.createdAt,
    requireReviewed: input.requireReviewed === true,
    ...(reviewedBinding === undefined ? {} : { expectedReviewedBinding: reviewedBinding })
  });
  if (!finalStaged.ok) return { ok: false, status: "draft_review", diagnostics: finalStaged.diagnostics };

  const mutationFence = () => assertTransitionLeaseOwned(lease);
  const sessionId = await allocateSessionId(input.repositoryRoot, input.createdAt, mutationFence);
  let committed = false;
  let committedDraft: IntakeDraft | undefined;
  let committedSession: IntakeSession | undefined;
  try {
    const explorationRef = draft.explorationRefs[0];
    const session = intakeSessionSchema.parse({
      ...finalStaged.previewSession,
      id: sessionId,
      createdAt: input.createdAt,
      answers: finalStaged.previewSession.answers.map((answer) => ({ ...answer, answeredAt: input.createdAt })),
      ...(explorationRef === undefined
        ? {}
          : { explorationRef: { runId: explorationRef.runId, artifact: explorationRef.artifact } })
    });
    const acceptedDraft = intakeDraftSchema.parse({ ...draft, status: "accepted" });
    const journal: PublishingSessionAcceptanceJournal = {
      schemaVersion: 2,
      phase: "publishing-session",
      draftId: draft.id,
      sessionId,
      draftSha256: sha256(draftRaw),
      acceptedDraftSha256: sha256(draftBytes(acceptedDraft)),
      sessionSha256: sha256(intakeSessionBytes(session))
    };
    if (!await renewAndValidateLease(lease)) throw new Error("draft acceptance lease was superseded before journal write");
    await writeAcceptanceJournal(
      input.repositoryRoot,
      journal,
      lease,
      input.afterAcceptanceJournalTemporaryWrite
    );
    await input.afterAcceptanceJournal?.();
    if (!await renewAndValidateLease(lease)) throw new Error("draft acceptance lease was superseded before session write");
    await input.beforeSessionPublish?.();
    const beforeSessionBoundary = await revalidateDraftDecisionBoundary({
      repositoryRoot: input.repositoryRoot,
      draft,
      expectedRaw: draftRaw,
      lease,
      now: input.createdAt,
      requireReviewed: input.requireReviewed === true,
      ...(reviewedBinding === undefined ? {} : { expectedReviewedBinding: reviewedBinding })
    });
    if (!beforeSessionBoundary.ok) throw new DraftDecisionValidationError(beforeSessionBoundary.diagnostics);
    await saveSession(input.repositoryRoot, session, {
      beforeMutation: mutationFence,
      ...(input.afterSessionTemporaryWrite === undefined ? {} : { afterTemporaryWrite: input.afterSessionTemporaryWrite }),
      ...(input.afterSessionPublish === undefined ? {} : { afterPublish: input.afterSessionPublish })
    });
    await input.beforeDraftCommit?.();
    if (!await renewAndValidateLease(lease)) throw new Error("draft acceptance lease was superseded before draft commit");
    const beforeDraftBoundary = await revalidateDraftDecisionBoundary({
      repositoryRoot: input.repositoryRoot,
      draft,
      expectedRaw: draftRaw,
      lease,
      now: input.createdAt,
      requireReviewed: input.requireReviewed === true,
      ...(reviewedBinding === undefined ? {} : { expectedReviewedBinding: reviewedBinding })
    });
    if (!beforeDraftBoundary.ok) throw new DraftDecisionValidationError(beforeDraftBoundary.diagnostics);
    await writeDraftCas(input.repositoryRoot, acceptedDraft, expectedDraftHash, lease);
    committed = true;
    committedDraft = acceptedDraft;
    committedSession = session;
    if (!await renewAndValidateLease(lease)) return { ok: true, status: "interview", draft: acceptedDraft, session };
    await consumeActiveReviewForDraft(input.repositoryRoot, draft.id, lease);
    await input.afterDraftCommit?.();
    await input.beforeJournalCleanup?.();
    if (!await renewAndValidateLease(lease)) return { ok: true, status: "interview", draft: acceptedDraft, session };
    await removeAcceptanceJournal(input.repositoryRoot, draft.id, lease);
    return { ok: true, status: "interview", draft: acceptedDraft, session };
  } catch (error) {
    if (committed && committedDraft !== undefined && committedSession !== undefined) {
      return { ok: true, status: "interview", draft: committedDraft, session: committedSession };
    }
    await rollbackSessionCreation(input.repositoryRoot, sessionId, mutationFence).catch(() => undefined);
    await removeAcceptanceJournal(input.repositoryRoot, draft.id, lease).catch(() => undefined);
    if (error instanceof DraftDecisionValidationError) {
      return { ok: false, status: "draft_review", diagnostics: error.diagnostics };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: "draft_review", diagnostics: [{ code: "draft_acceptance_failed", message }] };
  }
  } finally {
    await releaseDraftAcceptanceLease(lease, input.beforeLeaseRelease, input.beforeLeaseReleaseRename);
  }
}

const PREFLIGHT_ARTIFACT_PATH = ".legion/project/intake/preflight.json";

async function readPreflight(
  repositoryRoot: string,
  lease: DraftAcceptanceLease
): Promise<IntakePreflightState | undefined> {
  await assertTransitionLeaseOwned(lease);
  try {
    const resolved = await resolveProjectArtifactPath({ repositoryRoot, artifactPath: PREFLIGHT_ARTIFACT_PATH });
    const value = JSON.parse(await readFile(resolved.absolutePath, "utf8"));
    const parsed = intakePreflightStateSchema.safeParse(value);
    await assertTransitionLeaseOwned(lease);
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ELEASELOST") throw error;
    await assertTransitionLeaseOwned(lease);
    return undefined;
  }
}

async function writePreflight(
  repositoryRoot: string,
  state: IntakePreflightState,
  lease: DraftAcceptanceLease,
  hooks: {
    readonly beforeWrite?: () => Promise<void> | void;
    readonly beforePublish?: () => Promise<void> | void;
  } = {}
): Promise<void> {
  const validated = intakePreflightStateSchema.parse(state);
  await assertTransitionLeaseOwned(lease);
  const resolved = await ensureProjectArtifactParent({ repositoryRoot, artifactPath: PREFLIGHT_ARTIFACT_PATH });
  const temporary = `${resolved.absolutePath}.${randomUUID()}.tmp`;
  await hooks.beforeWrite?.();
  await assertTransitionLeaseOwned(lease);
  await writeFile(temporary, `${JSON.stringify(validated, undefined, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await hooks.beforePublish?.();
    await assertTransitionLeaseOwned(lease);
    await rename(temporary, resolved.absolutePath);
  } catch (error) {
    if (await renewAndValidateLease(lease)) await rm(temporary, { force: true });
    throw error;
  }
}

export type ActiveDraftScan =
  | { readonly ok: true; readonly drafts: readonly IntakeDraft[] }
  | { readonly ok: false; readonly diagnostics: readonly DraftStagingDiagnostic[] };

export async function inspectActiveDraftCandidates(repositoryRoot: string): Promise<ActiveDraftScan> {
  const directory = path.join(repositoryRoot, ".legion", "project", "intake", "drafts");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { ok: true, drafts: [] };
    return { ok: false, diagnostics: [{ code: "invalid_draft_candidate", message: "The intake draft directory cannot be read safely." }] };
  }
  const candidates = entries
    .filter((entry) => entry.name.startsWith("itd_") && entry.name.endsWith(".json"))
    .sort((left, right) => left.name < right.name ? 1 : left.name > right.name ? -1 : 0);
  const drafts: IntakeDraft[] = [];
  const diagnostics: DraftStagingDiagnostic[] = [];
  for (const entry of candidates) {
    const draftId = entry.name.slice(0, -5);
    if (!entry.isFile()) {
      diagnostics.push({ code: "invalid_draft_candidate", message: `Draft candidate ${entry.name} is not a regular file.` });
      continue;
    }
    try {
      const resolved = await resolveProjectArtifactPath({ repositoryRoot, artifactPath: draftArtifactPath(draftId) });
      const draft = intakeDraftSchema.parse(JSON.parse(await readFile(resolved.absolutePath, "utf8")));
      if (draft.id !== draftId) {
        diagnostics.push({ code: "invalid_draft_candidate", message: `Draft candidate ${entry.name} declares mismatched ID ${draft.id}.` });
      } else if (draft.status === "draft") drafts.push(draft);
    } catch {
      diagnostics.push({ code: "invalid_draft_candidate", message: `Draft candidate ${entry.name} is unreadable or invalid.` });
    }
  }
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, drafts };
}

async function activeDraft(repositoryRoot: string): Promise<IntakeDraft | undefined> {
  const scanned = await inspectActiveDraftCandidates(repositoryRoot);
  return scanned.ok && scanned.drafts.length === 1 ? scanned.drafts[0] : undefined;
}

/** Persist the intake cut line before any session is allocated. */
export async function prepareIntakePreflight(input: {
  readonly repositoryRoot: string;
  readonly createdAt: string;
  readonly explicitRunId?: string;
  readonly withoutExploration?: boolean;
  readonly explicitGoal?: string;
  readonly mapFailure?: string;
  readonly beforePreflightWrite?: () => Promise<void> | void;
  readonly beforePreflightPublish?: () => Promise<void> | void;
}): Promise<IntakePreflightState> {
  const lease = await acquireDraftAcceptanceLease(input.repositoryRoot, INTAKE_TRANSITION_KEY);
  try {
    const recovery = await recoverIntakeLifecycleArtifactsWithLease(input.repositoryRoot, lease);
    if (!recovery.ok) {
      throw pendingAcceptanceLifecycleError("EPENDINGACCEPTANCEBLOCKED", recovery.diagnostics);
    }
    if (recovery.rolledBackDraftIds.length > 0) {
      const diagnostic = pendingAcceptanceRecovered(recovery.rolledBackDraftIds);
      throw pendingAcceptanceLifecycleError("EPENDINGACCEPTANCERECOVERED", [diagnostic]);
    }
    const existing = await readPreflight(input.repositoryRoot, lease);
    const explorationSelectionIntent = input.explicitRunId !== undefined
      ? { mode: "explicit" as const, runId: input.explicitRunId }
      : input.withoutExploration === true
        ? { mode: "none" as const }
        : existing?.explorationSelectionIntent ?? { mode: "automatic" as const };
    const [projectMode, map, candidates, selection, draft, foundSession] = await Promise.all([
      classifyProjectMode(input.repositoryRoot),
      resolveMapState(input.repositoryRoot, undefined, input.createdAt),
      listExplorations(input.repositoryRoot),
      resolveExplorationSelection({
        repositoryRoot: input.repositoryRoot,
        ...(explorationSelectionIntent.mode === "explicit" ? { explicitRunId: explorationSelectionIntent.runId } : {}),
        ...(explorationSelectionIntent.mode === "none" ? { withoutExploration: true } : {})
      }),
      activeDraft(input.repositoryRoot),
      findActiveSession(input.repositoryRoot)
    ]);
    const session = foundSession.ok ? foundSession.session : undefined;
    const status = session !== undefined ? "interview" : draft !== undefined ? "draft_review" : "preflight";
    const initiative = input.explicitGoal !== undefined
      ? { value: input.explicitGoal, source: "explicit" as const }
      : existing?.initiative?.source === "explicit"
        ? existing.initiative
        : selection.selected === undefined
          ? undefined
          : {
              value: selection.selected.exploration.summary,
              source: "exploration" as const,
              explorationRunId: selection.selected.candidate.runId
            };
    const mapFailure = projectMode !== "brownfield" || !("freshness" in map) || map.freshness === "fresh"
      ? undefined
      : input.mapFailure !== undefined
        ? { message: input.mapFailure, reportedAt: input.createdAt }
        : existing?.mapFailure;
    const state = intakePreflightStateSchema.parse({
      schemaVersion: 1,
      status,
      createdAt: existing?.createdAt ?? input.createdAt,
      updatedAt: input.createdAt,
      projectMode,
      map,
      compatibleExplorations: candidates.filter((candidate) =>
        !selection.diagnostics.some((diagnostic) =>
          diagnostic.runId === candidate.runId && diagnostic.code !== "competing_candidate"
        )
      ),
      explorationSelectionIntent,
      ...(selection.selected === undefined ? {} : { selectedExplorationRunId: selection.selected.candidate.runId }),
      ...(initiative === undefined ? {} : { initiative }),
      ...(mapFailure === undefined ? {} : { mapFailure }),
      ...(draft === undefined ? {} : { activeDraftId: draft.id }),
      ...(session === undefined ? {} : { activeSessionId: session.id }),
      diagnostics: selection.diagnostics
    });
    await writePreflight(input.repositoryRoot, state, lease, {
      ...(input.beforePreflightWrite === undefined ? {} : { beforeWrite: input.beforePreflightWrite }),
      ...(input.beforePreflightPublish === undefined ? {} : { beforePublish: input.beforePreflightPublish })
    });
    return state;
  } finally {
    await releaseDraftAcceptanceLease(lease);
  }
}
