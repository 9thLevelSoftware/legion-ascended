import { explorationSchema, type Exploration, type UtcTimestamp } from "@legion/protocol";

/**
 * Turn a brainstorm's output into a typed exploration.
 *
 * The conversation is deliberately freeform; its product is not. This module is
 * the boundary between the two — everything upstream may wander, everything
 * downstream reads a validated artifact.
 *
 * Malformed input is handled asymmetrically, on purpose:
 *
 *  - A malformed **proposal** is dropped. Losing a suggestion means the
 *    operator gets asked the question instead of offered an answer, which
 *    degrades toward more questions.
 *  - A malformed **open question** is repaired and kept, never dropped.
 *    Losing one means a question that the brainstorm said was unresolved never
 *    gets asked — the exact v8 failure where exploration's open questions had
 *    no destination and evaporated at initialization.
 *
 * Both directions are recorded as diagnostics so the repair is visible.
 */

export interface ExplorationParseResult {
  readonly exploration: Exploration;
  readonly diagnostics: readonly string[];
}

export interface ExplorationParseFailure {
  readonly exploration?: undefined;
  readonly diagnostics: readonly string[];
}

const CONFIDENCE_VALUES = new Set(["researched", "inferred", "assumed"]);
const ENTRY_VALUES = new Set(["raw-idea", "pasted-spec", "existing-codebase", "link"]);
const MAX_NODE_ID_LENGTH = 63;

/** The JSON an exploration executor is asked to return. */
export function explorationResultContract(): string {
  return [
    "Return only JSON with this shape:",
    "```json",
    "{",
    '  "summary": "what this idea is, in one or two sentences",',
    '  "proposals": [',
    '    {"slot": "project.name", "value": "…", "rationale": "why", "anchor": "section-id", "confidence": "researched|inferred|assumed"}',
    "  ],",
    '  "openQuestions": [',
    '    {"slot": "project.stack", "question": "…", "why": "what made this unresolved"}',
    "  ],",
    '  "notes": [{"heading": "Problem Framing", "body": "…"}]',
    "}",
    "```",
    "",
    "Propose a slot only when the exploration actually settled it. Anything left",
    "genuinely undecided belongs in openQuestions — it will be asked during",
    "intake rather than guessed. A slot must not appear in both."
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function slugToNodeId(value: string, fallbackIndex: number): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NODE_ID_LENGTH)
    .replace(/-+$/g, "");
  if (slug.length < 2 || !/^[a-z]/.test(slug)) return `open-question-${fallbackIndex + 1}`;
  return slug;
}

export interface ParseExplorationInput {
  readonly raw: unknown;
  readonly runId: string;
  readonly topic: string;
  readonly entry: string;
  readonly createdAt: UtcTimestamp;
  readonly schemaVersion: string;
  readonly fallbackSummary: string;
}

export function parseExploration(
  input: ParseExplorationInput
): ExplorationParseResult | ExplorationParseFailure {
  const diagnostics: string[] = [];
  const value = isRecord(input.raw) ? input.raw : {};
  if (!isRecord(input.raw)) {
    diagnostics.push("The exploration executor returned no structured result; only the summary was preserved.");
  }

  const proposals: unknown[] = [];
  const rawProposals = Array.isArray(value["proposals"]) ? value["proposals"] : [];
  for (const [index, candidate] of rawProposals.entries()) {
    if (!isRecord(candidate)) {
      diagnostics.push(`Proposal ${index} was not an object and was dropped.`);
      continue;
    }
    const slot = asString(candidate["slot"]);
    const rationale = asString(candidate["rationale"]);
    const anchor = asString(candidate["anchor"]) ?? "exploration";
    const confidence = asString(candidate["confidence"]);
    const rawValue = candidate["value"];
    const okValue = typeof rawValue === "string" || Array.isArray(rawValue);

    if (slot === undefined || rationale === undefined || !okValue) {
      diagnostics.push(`Proposal ${index} was incomplete and was dropped; its slot will be asked during intake.`);
      continue;
    }
    proposals.push({
      slot,
      value: rawValue,
      rationale,
      anchor,
      // An unstated confidence is an assumption, not a finding.
      confidence: confidence !== undefined && CONFIDENCE_VALUES.has(confidence) ? confidence : "assumed"
    });
  }

  const proposedSlots = new Set(proposals.map((proposal) => (proposal as { slot: string }).slot));

  const openQuestions: unknown[] = [];
  const seenNodeIds = new Set<string>();
  const rawQuestions = Array.isArray(value["openQuestions"]) ? value["openQuestions"] : [];
  for (const [index, candidate] of rawQuestions.entries()) {
    const record = isRecord(candidate) ? candidate : {};
    const question = asString(record["question"]) ?? asString(candidate) ?? `Unresolved decision ${index + 1}`;
    const slot = asString(record["slot"]) ?? `open.question-${index + 1}`;
    const why = asString(record["why"]) ?? "The exploration did not settle this.";

    if (!isRecord(candidate) || asString(record["question"]) === undefined) {
      diagnostics.push(`Open question ${index} was malformed and was repaired rather than dropped.`);
    }

    // A slot cannot be both proposed and open. The open question wins: the
    // exploration said it was unresolved, so the proposal was a guess.
    if (proposedSlots.has(slot)) {
      const removed = proposals.findIndex((proposal) => (proposal as { slot: string }).slot === slot);
      if (removed >= 0) {
        proposals.splice(removed, 1);
        proposedSlots.delete(slot);
        diagnostics.push(`Slot ${slot} was both proposed and left open; the proposal was discarded in favour of asking.`);
      }
    }

    let nodeId = slugToNodeId(question, index);
    while (seenNodeIds.has(nodeId)) nodeId = `${nodeId.slice(0, MAX_NODE_ID_LENGTH - 3)}-${index + 1}`;
    seenNodeIds.add(nodeId);

    openQuestions.push({ nodeId, slot, question, why });
  }

  const notes: unknown[] = [];
  for (const candidate of Array.isArray(value["notes"]) ? value["notes"] : []) {
    if (!isRecord(candidate)) continue;
    const heading = asString(candidate["heading"]);
    const body = asString(candidate["body"]);
    if (heading === undefined || body === undefined) continue;
    notes.push({ heading, body });
  }

  const entry = ENTRY_VALUES.has(input.entry) ? input.entry : "raw-idea";
  const parsed = explorationSchema.safeParse({
    schemaVersion: input.schemaVersion,
    createdAt: input.createdAt,
    kind: "exploration",
    runId: input.runId,
    status: "exploratory",
    entry,
    topic: input.topic,
    summary: asString(value["summary"]) ?? input.fallbackSummary,
    proposals,
    openQuestions,
    notes
  });

  if (!parsed.success) {
    return {
      diagnostics: [
        ...diagnostics,
        ...parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      ]
    };
  }

  return { exploration: parsed.data, diagnostics };
}
