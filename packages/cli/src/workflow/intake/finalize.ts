/**
 * Turning a completed interview into typed artifacts.
 *
 * The interview's product is the requirement set. `ROADMAP.md` and the project
 * constitution are *rendered views* of it — regenerable, and never the source
 * of truth. That direction matters: the v8 line kept its requirements in prose
 * that a model rewrote on every pass, so "the requirements" meant whatever the
 * last edit left behind. Here the prose is downstream of the data.
 */

import {
  DEFAULT_PROJECT_CONSTITUTION,
  requirementArtifactPath,
  type RequirementSet
} from "@legion/artifacts";
import {
  artifactPathSchema,
  requirementSchema,
  type ArtifactPath,
  type ArtifactReference,
  type IntakeSession,
  type ProjectId,
  type RiskTier,
  type Requirement,
  type RequirementCriterion,
  type UtcTimestamp,
  type VerificationSurface,
  type VerificationSurfaceKind
} from "@legion/protocol";

import { criterionIdFor } from "../criteria.js";
import type { MintPinnedReference } from "../pinned-references.js";
import { INTAKE_GRAPH_VERSION } from "./graph.js";
import {
  parseCommandLine,
  parsePathList,
  requirementDrafts,
  slugFromText,
  type RequirementDraft
} from "./validators.js";
import type { IntakeAnswer } from "@legion/protocol";

const MAX_REQUIREMENT_SLUG = 48;

export type RequirementSetEnforcement = NonNullable<RequirementSet["enforcement"]>;

/**
 * A `wont` requirement records a decision not to build something. It has no
 * acceptance surface, but the protocol requires at least one criterion, so it
 * carries one that states the absence rather than a fabricated proof.
 */
export const WONT_CRITERION_REASON =
  "Recorded during intake as out of scope. Nothing is built, so nothing is proven; this criterion exists to keep the decision visible.";

export function requirementIdFor(statement: string, index: number): string {
  const slug = slugFromText(statement).slice(0, MAX_REQUIREMENT_SLUG).replace(/-+$/g, "");
  return slug.length > 0 ? `req_${slug}-${index}` : `req_requirement-${index}`;
}

function answerText(answers: readonly IntakeAnswer[], nodeId: string): string | undefined {
  const answer = answers.find((entry) => entry.nodeId === nodeId);
  return typeof answer?.value === "string" && answer.value.length > 0 ? answer.value : undefined;
}

export interface BuildRequirementsInput {
  readonly answers: readonly IntakeAnswer[];
  readonly projectId: ProjectId;
  readonly createdAt: UtcTimestamp;
  readonly schemaVersion: string;
  readonly intakeSessionPath: string;
  /**
   * How a declared surface path becomes a pin.
   *
   * Required rather than optional so the one production caller cannot forget it
   * and silently write requirements with every surface dropped. Injected because
   * hashing is I/O and this function is pure and synchronous, which is what lets
   * the whole intake test suite build requirements with no filesystem.
   */
  readonly mintPin: MintPinnedReference;
}

/**
 * The declared surface of one criterion, or `undefined` if none was declared.
 *
 * Returns `undefined` for an unpinnable path rather than a partial surface.
 * That is unreachable through `--finalize`, which resolves every declared pin
 * before it writes anything and refuses by name when one will not resolve — a
 * partial surface here would be a claim with nothing behind it, which is the one
 * thing worse than no claim.
 */
function surfaceFor(
  criterion: RequirementDraft["criteria"][number],
  mintPin: MintPinnedReference
): VerificationSurface | undefined {
  const kind = criterion.surfaceKind.trim();
  if (kind.length === 0) return undefined;

  const paths = parsePathList(criterion.surfacePins);
  if (paths.length === 0) return undefined;

  const pinned: ArtifactReference[] = [];
  for (const artifactPath of paths) {
    const reference = mintPin(artifactPath);
    if (reference === undefined) return undefined;
    pinned.push(reference);
  }

  return {
    kind: kind as VerificationSurfaceKind,
    interface: criterion.surfaceInterface.trim(),
    rationale: criterion.surfaceRationale.trim(),
    pinned
  };
}

/**
 * The protected acceptance paths of one criterion, or `undefined` if none.
 *
 * **No pin is minted, and that is the difference from `surfaceFor` above.** A
 * surface pin is a claim about *bytes*, so it is hashed at declaration time and
 * re-hashed at ship time. A protected acceptance path is a claim about
 * *identity* — this file is the test, whatever it currently says — and the
 * harness hashes it immediately before and after each run. Minting a reference
 * here would make a test legitimately edited between intake and build read as
 * drifted before it had ever been protected, and would need a re-affirmation verb
 * for a state nothing had caused.
 *
 * Consequently there is no `unpinnable_*` failure for these and
 * `declaredSurfacePaths` does not grow: nothing on this path can fail to resolve,
 * because nothing on this path touches the filesystem.
 */
function acceptancePathsFor(
  criterion: RequirementDraft["criteria"][number]
): ArtifactPath[] | undefined {
  const paths = parsePathList(criterion.acceptancePaths);
  if (paths.length === 0) return undefined;
  // Parsed rather than cast. `validateAnswerSet` has already refused every path
  // this would throw on, and a cast here would put an unvalidated string into a
  // document `requirementSchema.parse` is about to accept structurally.
  return paths.map((entry) => artifactPathSchema.parse(entry));
}

function criterionFor(
  criterion: RequirementDraft["criteria"][number],
  index: number,
  mintPin: MintPinnedReference
): RequirementCriterion {
  const id = criterionIdFor(criterion.statement, index);

  if (criterion.proof === "executable") {
    const parsed = parseCommandLine(criterion.detail);
    const surface = surfaceFor(criterion, mintPin);
    const acceptancePaths = acceptancePathsFor(criterion);
    if (!("error" in parsed)) {
      return {
        id,
        statement: criterion.statement,
        proof: {
          mode: "executable",
          command: parsed.command,
          args: [...parsed.args],
          // The interview states this contract explicitly: exit zero means the
          // criterion holds. Asking for an expected code per criterion invites
          // a non-zero answer chosen to make a failing command look fine.
          expectedExitCode: 0,
          ...(surface === undefined ? {} : { surface }),
          ...(acceptancePaths === undefined ? {} : { acceptancePaths })
        }
      };
    }
    // Unreachable through `--finalize`, which validates commands first. Falling
    // back to `manual` rather than throwing keeps a direct caller from turning
    // an unparseable command into a crash — and the reason says what happened
    // instead of quietly dropping the criterion.
    return {
      id,
      statement: criterion.statement,
      proof: {
        mode: "manual",
        // The manual arm has nowhere to put a surface, so a declaration made
        // against a command that will not parse is lost here. Said out loud in
        // the artifact rather than dropped in silence: the criterion is already
        // being downgraded, and losing the declaration with it is the part a
        // reader would otherwise have no way to notice.
        reason:
          `The recorded command could not be parsed (${parsed.error}) so this criterion is unproven.` +
          (surface === undefined ? "" : " Its declared verification surface was dropped with it.") +
          (acceptancePaths === undefined
            ? ""
            : " Its declared protected acceptance paths were dropped with it.")
      }
    };
  }

  return {
    id,
    statement: criterion.statement,
    proof: {
      mode: "manual",
      reason: criterion.detail.trim().length > 0 ? criterion.detail : WONT_CRITERION_REASON
    }
  };
}

export function buildRequirements(input: BuildRequirementsInput): readonly Requirement[] {
  const drafts = requirementDrafts(input.answers);
  const requirements: Requirement[] = [];
  const usedIds = new Set<string>();

  for (const draft of drafts) {
    let id = requirementIdFor(draft.statement, draft.index);
    // Two requirements can slug identically; the index already differs, but a
    // truncated slug can collide anyway. Suffix until unique rather than
    // silently overwriting the earlier requirement's file.
    let attempt = 0;
    while (usedIds.has(id)) {
      attempt += 1;
      id = `${requirementIdFor(draft.statement, draft.index)}-${attempt}`;
    }
    usedIds.add(id);

    const isWont = draft.priority === "wont";
    const criteria: RequirementCriterion[] = isWont
      ? [
          {
            id: criterionIdFor(draft.statement, 0),
            statement: `Not built: ${draft.statement}`,
            proof: { mode: "manual", reason: WONT_CRITERION_REASON }
          }
        ]
      : draft.criteria.map((criterion, index) => criterionFor(criterion, index, input.mintPin));

    requirements.push(
      requirementSchema.parse({
        schemaVersion: input.schemaVersion,
        createdAt: input.createdAt,
        kind: "requirement",
        id,
        projectId: input.projectId,
        // A requirement the decision owner just stated in an interview is
        // accepted, not proposed. `wont` is the recorded decision not to build,
        // which is what `rejected` means.
        status: isWont ? "rejected" : "accepted",
        priority: draft.priority,
        category: draft.category,
        statement: draft.statement,
        acceptance: {
          language: draft.statement,
          criteria,
          oracleRefs: []
        },
        traceRefs: [
          {
            path: input.intakeSessionPath,
            anchor: `requirements.${draft.index}`,
            relation: "records",
            entity: { kind: "requirement", id }
          }
        ],
        supersedes: []
      })
    );
  }

  return requirements;
}

/** One declared surface path, with the criterion that declared it. */
export interface DeclaredSurfacePath {
  readonly requirementIndex: number;
  readonly criterionIndex: number;
  readonly path: string;
}

/**
 * Every path a recorded interview declared a verification surface against.
 *
 * Read from the same `requirementDrafts` reconstruction `buildRequirements`
 * uses, so the set of paths finalize resolves is exactly the set the requirement
 * writer will ask for a pin for. A second traversal here is how a path gets
 * declared, never resolved, and then silently dropped.
 *
 * `wont` requirements are excluded because their criteria are synthesized rather
 * than authored, and a `wont` requirement never answers the proof question the
 * surface nodes depend on.
 */
export function declaredSurfacePaths(
  answers: readonly IntakeAnswer[]
): readonly DeclaredSurfacePath[] {
  const declared: DeclaredSurfacePath[] = [];
  for (const draft of requirementDrafts(answers)) {
    if (draft.priority === "wont") continue;
    for (const criterion of draft.criteria) {
      if (criterion.surfaceKind.trim().length === 0) continue;
      for (const path of parsePathList(criterion.surfacePins)) {
        declared.push({ requirementIndex: draft.index, criterionIndex: criterion.index, path });
      }
    }
  }
  return declared;
}

/** Requirements that become roadmap phases: everything actually being built. */
export function plannedRequirements(requirements: readonly Requirement[]): readonly Requirement[] {
  return requirements.filter((requirement) => requirement.priority !== "wont");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
}

function bulletList(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line.length > 0);
}

export interface RenderRoadmapInput {
  readonly projectName: string;
  readonly answers: readonly IntakeAnswer[];
  readonly requirements: readonly Requirement[];
  readonly intakeSessionId: string;
}

/**
 * Render `ROADMAP.md`.
 *
 * The header carries `Phase`, `Name`, `Requirements` and `Status`, which is
 * what `commands/validate.md` has always demanded and what the shipped template
 * never emitted — a validator and a generator that disagreed, with the
 * generator winning silently.
 *
 * Phases map one-to-one onto requirements. That is a rendering, not a
 * decomposition: real decomposition needs to group criteria into coherent units
 * of work, which is Phase D. A one-to-one map is at least honest about having
 * made no judgement.
 */
export function renderRoadmap(input: RenderRoadmapInput): string {
  const planned = plannedRequirements(input.requirements);
  const nonGoals = bulletList(answerText(input.answers, "non-goals"));
  const constraints = bulletList(answerText(input.answers, "constraints"));
  const excluded = input.requirements.filter((requirement) => requirement.priority === "wont");

  const lines: string[] = [];
  lines.push(`# ${input.projectName} — Roadmap`);
  lines.push("");
  lines.push(`<!-- Rendered by \`legion start --finalize\` from intake session ${input.intakeSessionId}. -->`);
  lines.push("<!-- This file is a view of .legion/project/requirements. Edit the requirements, not this file. -->");
  lines.push("");

  lines.push("## Overview");
  lines.push("");
  const summary = answerText(input.answers, "project-summary");
  if (summary !== undefined) {
    lines.push(summary);
    lines.push("");
  }
  const problem = answerText(input.answers, "problem-statement");
  const users = answerText(input.answers, "problem-users");
  const success = answerText(input.answers, "problem-success");
  if (problem !== undefined) lines.push(`**Problem.** ${problem}`, "");
  if (users !== undefined) lines.push(`**Who has it.** ${users}`, "");
  if (success !== undefined) lines.push(`**Done looks like.** ${success}`, "");

  lines.push("## Non-Goals");
  lines.push("");
  if (nonGoals.length === 0 && excluded.length === 0) {
    lines.push("- (none recorded)");
  } else {
    for (const entry of nonGoals) lines.push(`- ${entry}`);
    // Declined requirements belong in the same list: a "won't" answered during
    // the requirements loop is a non-goal that happened to be asked elsewhere,
    // and splitting them makes the roadmap read as if only half were decided.
    for (const requirement of excluded) {
      lines.push(`- Declined during intake: ${requirement.statement}`);
    }
  }
  lines.push("");

  lines.push("## Constraints");
  lines.push("");
  if (constraints.length === 0) {
    lines.push("- (none recorded)");
  } else {
    for (const entry of constraints) lines.push(`- ${entry}`);
  }
  lines.push("");

  lines.push("## Phases");
  lines.push("");
  lines.push("| Phase | Name | Requirements | Status |");
  lines.push("|-------|------|--------------|--------|");
  for (const [index, requirement] of planned.entries()) {
    lines.push(
      `| ${index + 1} | ${escapeTableCell(truncate(requirement.statement, 60))} | ${requirement.id} | Pending |`
    );
  }
  if (planned.length === 0) {
    // The table must still parse: a header with no rows is a valid, honest
    // "nothing planned", where an absent table reads to the validator as a
    // malformed roadmap.
    lines.push("| 1 | (no requirements yet) | — | Pending |");
  }
  lines.push("");

  for (const [index, requirement] of planned.entries()) {
    lines.push(`## Phase ${index + 1}: ${requirement.statement.replace(/\r?\n/g, " ").trim()}`);
    lines.push("");
    lines.push(`**Requirement:** \`${requirement.id}\` (${requirement.priority}, ${requirement.category})`);
    lines.push("");
    lines.push(`**Artifact:** \`${requirementArtifactPath(requirement.id)}\``);
    lines.push("");
    lines.push("**Acceptance criteria**");
    lines.push("");
    for (const criterion of requirement.acceptance.criteria) {
      const proof =
        criterion.proof.mode === "executable"
          ? `\`${[criterion.proof.command, ...criterion.proof.args].join(" ")}\` must exit ${criterion.proof.expectedExitCode}`
          : `manual — ${criterion.proof.reason}`;
      lines.push(`- [ ] ${criterion.statement}`);
      lines.push(`  - ${proof}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export interface RenderConstitutionInput {
  readonly answers: readonly IntakeAnswer[];
}

/**
 * Seed the constitution, appending what the interview recorded.
 *
 * Constraints and non-goals belong here rather than only in the roadmap: the
 * constitution is the document the authority order puts above generated plans,
 * so a constraint stated once during intake keeps outranking a plan that would
 * violate it.
 */
export function renderConstitution(input: RenderConstitutionInput): string {
  const constraints = bulletList(answerText(input.answers, "constraints"));
  const nonGoals = bulletList(answerText(input.answers, "non-goals"));
  const notes = answerText(input.answers, "pref-notes");
  const verification = answerText(input.answers, "pref-verification");

  if (constraints.length === 0 && nonGoals.length === 0 && notes === undefined && verification === undefined) {
    return DEFAULT_PROJECT_CONSTITUTION;
  }

  const lines: string[] = [DEFAULT_PROJECT_CONSTITUTION.trimEnd(), "", "## Project Constraints", ""];
  lines.push("Recorded during intake. These outrank generated plans.");
  lines.push("");
  if (constraints.length === 0) {
    lines.push("- (none recorded)");
  } else {
    for (const entry of constraints) lines.push(`- ${entry}`);
  }
  lines.push("");

  lines.push("## Out Of Scope");
  lines.push("");
  if (nonGoals.length === 0) {
    lines.push("- (none recorded)");
  } else {
    for (const entry of nonGoals) lines.push(`- ${entry}`);
  }
  lines.push("");

  if (verification !== undefined) {
    lines.push("## Project Verification");
    lines.push("");
    lines.push(`\`${verification}\` must pass before a change is shippable.`);
    lines.push("");
  }

  if (notes !== undefined) {
    lines.push("## Implementer Notes");
    lines.push("");
    lines.push(notes);
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export const INTAKE_GRAPH_VERSION_FOR_FINALIZE = INTAKE_GRAPH_VERSION;

/**
 * The enforcement settings the interview collected, in the shape planning reads.
 *
 * Returns `undefined` only when an answer is missing or unparseable, which the
 * validators already prevent on the `--finalize` path. Falling back to a default
 * here would be the worse failure: the operator would have chosen a limit and
 * silently got a different one.
 */
export function enforcementPolicy(
  answers: readonly IntakeAnswer[]
): RequirementSetEnforcement | undefined {
  const tier = answerText(answers, "risk-tier");
  const reason = answerText(answers, "risk-reason");
  const verification = answerText(answers, "pref-verification");
  if (tier === undefined || reason === undefined || verification === undefined) return undefined;
  if (reason.length > 128) return undefined;

  const numbers = ["budget-files", "budget-lines", "budget-new-files"].map((nodeId) => {
    const raw = answerText(answers, nodeId);
    if (raw === undefined) return undefined;
    const parsed = Number.parseInt(raw.trim().replace(/[_,]/g, ""), 10);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  });
  const [maxFilesChanged, maxLinesChanged, maxNewFiles] = numbers;
  if (maxFilesChanged === undefined || maxLinesChanged === undefined || maxNewFiles === undefined) {
    return undefined;
  }

  const command = parseCommandLine(verification);
  if ("error" in command) return undefined;

  return {
    // Not truncated: the validator rejects an overlong reason at the node, so
    // reaching here with one would mean the session and the policy disagree.
    risk: { tier: tier as RiskTier, reason },
    budget: { maxFilesChanged, maxLinesChanged, maxNewFiles },
    verification: { command: command.command, args: [...command.args] }
  };
}

/**
 * Answers to the questions exploration injected.
 *
 * The C0 contract is that a brainstorm may only *add* questions, so an
 * unresolved idea produces a longer interview. That only means something if the
 * answers are then usable: `requirementDrafts` reads the built-in `req-<n>-*`
 * slots only, so an injected answer was recorded in the session and consumed by
 * nothing. Two interviews disagreeing about an injected constraint produced
 * byte-identical contracts.
 */
export function resolvedOpenQuestions(
  session: IntakeSession
): NonNullable<RequirementSet["resolvedQuestions"]> {
  const answers = new Map(session.answers.map((answer) => [answer.nodeId, answer.value]));
  const resolved: NonNullable<RequirementSet["resolvedQuestions"]> = [];

  for (const node of session.injectedNodes) {
    const value = answers.get(node.nodeId);
    const text = typeof value === "string" ? value : Array.isArray(value) ? value.join(", ") : String(value ?? "");
    if (text.trim().length === 0) continue;
    resolved.push({
      nodeId: node.nodeId,
      slot: node.slot,
      question: node.prompt,
      answer: text,
      fromExploration: node.origin.runId
    });
  }
  return resolved;
}
