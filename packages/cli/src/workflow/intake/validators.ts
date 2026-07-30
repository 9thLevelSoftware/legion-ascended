/**
 * Slot validation for the intake graph.
 *
 * Two layers, deliberately separate:
 *
 *  - `validateAnswer` checks a single answer as it is given, so a bad value is
 *    rejected at the moment it can still be corrected cheaply.
 *  - `validateAnswerSet` checks the facts that only exist once the interview is
 *    complete. It is what `--finalize` runs, and it is the reason `--intake`
 *    cannot be a way to get a weaker contract than the interactive path: both
 *    entrances funnel through it.
 *
 * The load-bearing rule is that a `must` requirement cannot be finalized without
 * at least one acceptance criterion, and every criterion must say how it is
 * proven — a command, or a stated reason no command can decide it. Without that
 * rule "acceptance criteria" is decoration; with it, an unprovable requirement
 * is a thing you have to look at and choose.
 */

import type { IntakeAnswer } from "@legion/protocol";

import type { IntakeNode } from "./graph.js";
import { SKIPPED_VALUE } from "./graph.js";

export interface IntakeDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly nodeId?: string;
  readonly slot?: string;
}

export const MAX_BUDGET_FILES = 10_000;
export const MAX_BUDGET_LINES = 1_000_000;

/**
 * Answers that look like an answer and are not one.
 *
 * These matter most on a `manual` proof reason. "Manual" is the escape hatch
 * from executable acceptance, and an escape hatch that accepts "tbd" is not a
 * hatch, it is a hole.
 */
const NON_ANSWERS = new Set([
  "n/a",
  "na",
  "none",
  "nothing",
  "tbd",
  "todo",
  "?",
  "-",
  "--",
  ".",
  "idk",
  "unknown",
  "unsure",
  "later"
]);

function isNonAnswer(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  // Both forms, because stripping trailing punctuation is what makes "n/a."
  // match — and what made the bare "." entry unmatchable, since it normalizes
  // to the empty string.
  return NON_ANSWERS.has(normalized) || NON_ANSWERS.has(normalized.replace(/[.!]+$/, ""));
}

function asText(value: IntakeAnswer["value"]): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Split a command line into a command and arguments.
 *
 * Quote-aware but deliberately not a shell: verification runs with
 * `shell: false`, so anything this tokenizer cannot express is something the
 * runner could not execute either. Rejecting it here means the operator finds
 * out while writing the criterion rather than when the gate fires.
 */
export interface ParsedCommand {
  readonly command: string;
  readonly args: readonly string[];
}

const SHELL_METACHARACTER = /[|&;<>$`\n]/;

export function parseCommandLine(input: string): ParsedCommand | { readonly error: string } {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  let unquotedMetacharacter: string | undefined;

  for (const character of input.trim()) {
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
        continue;
      }
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    // Scanned here rather than over the whole input, so the check sees what the
    // operator wrote as syntax and not what they deliberately quoted. A
    // criterion like `pnpm test --grep "a|b"` passes `a|b` as one literal
    // argument under `shell: false` and is exactly as safe as any other.
    if (unquotedMetacharacter === undefined && SHELL_METACHARACTER.test(character)) {
      unquotedMetacharacter = character;
    }
    current += character;
    started = true;
  }

  if (quote !== undefined) {
    return { error: "The command has an unclosed quote." };
  }
  if (started) tokens.push(current);

  const [command, ...args] = tokens;
  if (command === undefined || command.length === 0) {
    return { error: "The command is empty." };
  }
  // Unquoted shell metacharacters would be passed through literally as part of
  // an argument, so a criterion written as `a && b` would silently verify only
  // `a`. Refusing is the honest outcome.
  if (unquotedMetacharacter !== undefined) {
    return {
      error: `Shell syntax is not available (${unquotedMetacharacter}); verification runs the command directly. Wrap it in a script and name that instead.`
    };
  }
  return { command, args };
}

function positiveInteger(
  value: string,
  max: number
): { readonly value: number } | { readonly error: string } {
  const trimmed = value.trim().replace(/[_,]/g, "");
  if (!/^\d+$/.test(trimmed)) return { error: "Enter a whole number." };
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return { error: "Enter a number greater than zero." };
  if (parsed > max) return { error: `Enter a number no greater than ${max}.` };
  return { value: parsed };
}

function nonNegativeInteger(
  value: string,
  max: number
): { readonly value: number } | { readonly error: string } {
  const trimmed = value.trim().replace(/[_,]/g, "");
  if (!/^\d+$/.test(trimmed)) return { error: "Enter a whole number." };
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) return { error: "Enter a whole number." };
  if (parsed > max) return { error: `Enter a number no greater than ${max}.` };
  return { value: parsed };
}

export function coerceConfirm(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(normalized)) return true;
  if (["false", "no", "n", "0"].includes(normalized)) return false;
  return undefined;
}

export interface ValidateAnswerResult {
  /** The value to record, after coercion. */
  readonly value?: IntakeAnswer["value"];
  readonly diagnostics: readonly IntakeDiagnostic[];
}

/**
 * Validate and coerce one answer against its node.
 *
 * Coercion is confined to shape — "yes" becoming `true`, a numeric string being
 * checked as a number. It never substitutes a value the operator did not give.
 */
export function validateAnswer(node: IntakeNode, raw: IntakeAnswer["value"]): ValidateAnswerResult {
  const diagnostics: IntakeDiagnostic[] = [];
  const reject = (code: string, message: string): ValidateAnswerResult => ({
    diagnostics: [{ code, message, nodeId: node.id, slot: node.slot }]
  });

  if (node.kind === "confirm") {
    if (typeof raw === "boolean") return { value: raw, diagnostics };
    const text = asText(raw);
    const coerced = text === undefined ? undefined : coerceConfirm(text);
    if (coerced === undefined) return reject("invalid_confirm", "Answer with true or false.");
    return { value: coerced, diagnostics };
  }

  if (node.kind === "multi") {
    const values = Array.isArray(raw) ? raw : asText(raw)?.split(",").map((entry) => entry.trim());
    if (values === undefined) return reject("invalid_multi", "Provide a comma-separated list.");
    const cleaned = values.filter((entry) => entry.length > 0);
    if (node.required && cleaned.length === 0) {
      return reject("empty_required", "This question requires an answer.");
    }
    const permitted = new Set((node.options ?? []).map((option) => option.value));
    const unknown = cleaned.filter((entry) => !permitted.has(entry));
    if (permitted.size > 0 && unknown.length > 0) {
      return reject("unknown_option", `Not an available choice: ${unknown.join(", ")}.`);
    }
    return { value: cleaned, diagnostics };
  }

  const text = asText(raw);
  if (text === undefined) return reject("invalid_text", "Provide a text answer.");

  if (node.kind === "single") {
    const permitted = new Set((node.options ?? []).map((option) => option.value));
    const normalized = text.trim();
    if (!permitted.has(normalized)) {
      return reject(
        "unknown_option",
        `Choose one of: ${[...permitted].join(", ")}.`
      );
    }
    return { value: normalized, diagnostics };
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    if (node.required) return reject("empty_required", "This question requires an answer.");
    return { value: SKIPPED_VALUE, diagnostics };
  }

  const slotDiagnostic = validateSlotText(node, trimmed);
  if (slotDiagnostic !== undefined) return { diagnostics: [slotDiagnostic] };

  return { value: trimmed, diagnostics };
}

/** Per-slot rules for free-text answers. */
function validateSlotText(node: IntakeNode, value: string): IntakeDiagnostic | undefined {
  const fail = (code: string, message: string): IntakeDiagnostic => ({
    code,
    message,
    nodeId: node.id,
    slot: node.slot
  });

  if (node.slot === "project.name") {
    if (value.length > 160) return fail("too_long", "Keep the name to 160 characters or fewer.");
    if (slugFromText(value).length < 3) {
      return fail(
        "unslugifiable_name",
        "The name needs at least three letters or digits so it can become a project slug."
      );
    }
    return undefined;
  }

  if (node.slot === "project.owner") {
    if (value.length > 128) return fail("too_long", "Keep the owner to 128 characters or fewer.");
    return undefined;
  }

  // The risk profile caps a reason at 128 characters. Accepting a longer answer
  // and truncating it at finalize left the session and the requirement set
  // recording different rationales — and the part dropped is the tail, which is
  // usually the qualifier that justified the tier.
  if (node.slot === "risk.reason" && value.length > 128) {
    return fail(
      "too_long",
      "Keep the reason to 128 characters or fewer; it is stored verbatim on every task's risk profile."
    );
  }

  if (node.slot === "project.summary" && value.length > 2_048) {
    return fail("too_long", "Keep the summary to 2048 characters or fewer.");
  }

  if (node.slot === "budget.max-files-changed" || node.slot === "budget.max-lines-changed") {
    const max = node.slot === "budget.max-lines-changed" ? MAX_BUDGET_LINES : MAX_BUDGET_FILES;
    const parsed = positiveInteger(value, max);
    if ("error" in parsed) return fail("invalid_budget", parsed.error);
    return undefined;
  }

  if (node.slot === "budget.max-new-files") {
    const parsed = nonNegativeInteger(value, MAX_BUDGET_FILES);
    if ("error" in parsed) return fail("invalid_budget", parsed.error);
    return undefined;
  }

  if (node.slot === "preferences.verification") {
    const parsed = parseCommandLine(value);
    if ("error" in parsed) return fail("invalid_command", parsed.error);
    return undefined;
  }

  // The requirement schema caps a statement at 2048 characters and a criterion
  // statement or manual reason at 1024, while an answer may be up to 8192. An
  // over-long value therefore passed both validation layers and threw out of
  // `requirementSchema.parse` during --finalize, where the operator gets a stack
  // trace instead of the question back.
  if (/^requirements\.\d+\.statement$/.test(node.slot) && value.length > 2_048) {
    return fail("too_long", "Keep the requirement to 2048 characters or fewer.");
  }
  if (/^requirements\.\d+\.criteria\.\d+\.statement$/.test(node.slot) && value.length > 1_024) {
    return fail("too_long", "Keep the criterion to 1024 characters or fewer.");
  }
  if (/^requirements\.\d+\.criteria\.\d+\.detail$/.test(node.slot) && value.length > 1_024) {
    return fail("too_long", "Keep the command or reason to 1024 characters or fewer.");
  }

  // A criterion's detail carries either the command that decides it or the
  // reason no command can. Which one is settled by the proof node, which the
  // single-answer path cannot see, so the check lives in `validateAnswerSet`.
  return undefined;
}

export function slugFromText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

export interface RequirementDraft {
  readonly index: number;
  readonly statement: string;
  readonly priority: string;
  readonly category: string;
  readonly criteria: readonly CriterionDraft[];
}

export interface CriterionDraft {
  readonly index: number;
  readonly statement: string;
  readonly proof: string;
  readonly detail: string;
}

function answerText(answers: ReadonlyMap<string, IntakeAnswer["value"]>, nodeId: string): string | undefined {
  const value = answers.get(nodeId);
  return typeof value === "string" ? value : undefined;
}

/** Reconstruct the requirement drafts implied by a recorded answer set. */
export function requirementDrafts(answers: readonly IntakeAnswer[]): readonly RequirementDraft[] {
  const map = new Map<string, IntakeAnswer["value"]>();
  for (const answer of answers) map.set(answer.nodeId, answer.value);

  const drafts: RequirementDraft[] = [];
  for (let index = 1; ; index += 1) {
    const statement = answerText(map, `req-${index}-statement`);
    if (statement === undefined) break;
    const priority = answerText(map, `req-${index}-priority`) ?? "";
    const category = answerText(map, `req-${index}-category`) ?? "";

    const criteria: CriterionDraft[] = [];
    for (let criterion = 1; ; criterion += 1) {
      const criterionStatement = answerText(map, `req-${index}-ac-${criterion}-statement`);
      if (criterionStatement === undefined) break;
      criteria.push({
        index: criterion,
        statement: criterionStatement,
        proof: answerText(map, `req-${index}-ac-${criterion}-proof`) ?? "",
        detail: answerText(map, `req-${index}-ac-${criterion}-detail`) ?? ""
      });
    }

    drafts.push({ index, statement, priority, category, criteria });
  }
  return drafts;
}

export interface ValidateAnswerSetInput {
  readonly answers: readonly IntakeAnswer[];
}

/**
 * The checks that only make sense once the interview is complete.
 *
 * Run by `--finalize` on every entrance, interactive and batch alike.
 */
export function validateAnswerSet(input: ValidateAnswerSetInput): readonly IntakeDiagnostic[] {
  const diagnostics: IntakeDiagnostic[] = [];
  const map = new Map<string, IntakeAnswer["value"]>();
  for (const answer of input.answers) map.set(answer.nodeId, answer.value);

  const drafts = requirementDrafts(input.answers);
  if (drafts.length === 0) {
    diagnostics.push({
      code: "no_requirements",
      message: "A project needs at least one requirement before it can be finalized."
    });
  }

  for (const draft of drafts) {
    const nodeId = `req-${draft.index}-statement`;

    if (draft.priority === "wont") {
      // A `wont` requirement records a decision not to build something. It has
      // no acceptance surface by construction, so demanding criteria for it
      // would teach operators to write fake ones.
      continue;
    }

    if (draft.criteria.length === 0) {
      diagnostics.push({
        code: draft.priority === "must" ? "must_without_criteria" : "requirement_without_criteria",
        message:
          draft.priority === "must"
            ? `Requirement ${draft.index} is a 'must' with no acceptance criteria. A must-have nobody can check is a wish.`
            : `Requirement ${draft.index} has no acceptance criteria.`,
        nodeId,
        slot: `requirements.${draft.index}.statement`
      });
      continue;
    }

    for (const criterion of draft.criteria) {
      const criterionNode = `req-${draft.index}-ac-${criterion.index}-detail`;
      const slot = `requirements.${draft.index}.criteria.${criterion.index}.detail`;

      if (criterion.proof === "executable") {
        const parsed = parseCommandLine(criterion.detail);
        if ("error" in parsed) {
          diagnostics.push({
            code: "invalid_criterion_command",
            message: `Requirement ${draft.index}, criterion ${criterion.index}: ${parsed.error}`,
            nodeId: criterionNode,
            slot
          });
        }
        continue;
      }

      if (criterion.proof === "manual") {
        if (criterion.detail.trim().length < 12 || isNonAnswer(criterion.detail)) {
          diagnostics.push({
            code: "empty_manual_reason",
            message: `Requirement ${draft.index}, criterion ${criterion.index}: state why no command can decide this. 'Manual' without a reason is how an unproven criterion becomes invisible.`,
            nodeId: criterionNode,
            slot
          });
        }
        continue;
      }

      diagnostics.push({
        code: "unknown_proof_mode",
        message: `Requirement ${draft.index}, criterion ${criterion.index}: choose whether a command or a human decides it.`,
        nodeId: `req-${draft.index}-ac-${criterion.index}-proof`,
        slot: `requirements.${draft.index}.criteria.${criterion.index}.proof`
      });
    }
  }

  const files = answerText(map, "budget-files");
  const newFiles = answerText(map, "budget-new-files");
  if (files !== undefined && newFiles !== undefined) {
    const parsedFiles = positiveInteger(files, MAX_BUDGET_FILES);
    const parsedNew = nonNegativeInteger(newFiles, MAX_BUDGET_FILES);
    if (!("error" in parsedFiles) && !("error" in parsedNew) && parsedNew.value > parsedFiles.value) {
      diagnostics.push({
        code: "budget_inconsistent",
        message: `A task cannot create ${parsedNew.value} new files while changing at most ${parsedFiles.value}.`,
        nodeId: "budget-new-files",
        slot: "budget.max-new-files"
      });
    }
  }

  return diagnostics;
}
