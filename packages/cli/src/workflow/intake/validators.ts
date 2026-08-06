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

import {
  MAX_ACCEPTANCE_PATHS,
  artifactPathSchema,
  verificationSurfaceKindSchema,
  type IntakeAnswer
} from "@legion/protocol";

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

/** `verificationSurfaceSchema.pinned` caps the array at eight references. */
export const MAX_SURFACE_PINS = 8;

/** The control plane, which a protected acceptance path may never name. */
const CONTROL_PLANE_ROOT = ".legion/project";

/**
 * Whether an answer names the control plane, **case-folded**.
 *
 * `.Legion/project/project.json` passed the exact-string form of this check at
 * the node, at the answer set, in `acceptancePathsSchema` and in the harness, and
 * on a case-insensitive filesystem resolves to a control artifact the harness
 * restores *before* it compares — so the run records `pass` for a declaration
 * that protects nothing, and the same document answers `unevaluable` on a
 * case-sensitive CI. Refused here as well as in the schema because an intake
 * refusal names the node and the slot, and being told at the schema is being told
 * far too late. See `namesControlPlane` in @legion/protocol for the full argument.
 */
function namesControlPlane(entry: string): boolean {
  const folded = entry.toLowerCase();
  const root = CONTROL_PLANE_ROOT.toLowerCase();
  return folded === root || folded.startsWith(`${root}/`);
}

/**
 * The repository-relative paths a multi-path answer names.
 *
 * One answer, several paths, so the operator can write them on separate lines or
 * separated by commas without being told which. Blank entries are dropped rather
 * than reported: a trailing newline is not a mistake worth a diagnostic, and the
 * empty case is caught by there being no paths left.
 *
 * Shared by the surface pins and the protected acceptance paths rather than
 * copied. Two splitters would be two chances for "a, b" and "a\nb" to stop
 * meaning the same thing in one of them.
 */
export function parsePathList(value: string): readonly string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The first entry that appears more than once, or `undefined`. */
function firstRepeated(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

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

  // A skip is an answer — "asked, and declined" — for a node of any kind, and
  // that is what the batch entrance has always recorded: `handleBatchIntake`
  // writes `SKIPPED_VALUE` for an unanswered optional node without consulting
  // this function at all.
  //
  // Hoisted above the kind dispatch because the branches below judge `""` as a
  // *value*: an empty string is not one of a `single` node's options and is not
  // a boolean, so `legion start --skip` on an optional `single` or `confirm`
  // node exited 1 on a question the graph itself marked declinable, while the
  // same node skipped cleanly through `--intake`. Two entrances the module
  // comment says funnel through one validator disagreed about what optional
  // means, and the disagreement was unreachable until the first optional node of
  // either kind — this release's `-surface-kind` — made it reachable.
  //
  // `multi` is excluded rather than folded in: it already has a well-defined
  // empty answer, the empty array, and returning a string for it would record
  // the wrong type for a list-valued slot.
  if (!node.required && node.kind !== "multi" && typeof raw === "string" && raw.trim().length === 0) {
    return { value: SKIPPED_VALUE, diagnostics };
  }

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

  // The surface slots have exactly one meaning each, unlike `…criteria.N.detail`
  // below, so their rules belong here where a bad answer can still be corrected
  // for the price of retyping one line.
  if (/^requirements\.\d+\.criteria\.\d+\.surface\.interface$/.test(node.slot) && value.length > 256) {
    return fail("too_long", "Keep the interface name to 256 characters or fewer.");
  }
  if (/^requirements\.\d+\.criteria\.\d+\.surface\.rationale$/.test(node.slot) && value.length > 1_024) {
    return fail("too_long", "Keep the rationale to 1024 characters or fewer.");
  }
  if (/^requirements\.\d+\.criteria\.\d+\.surface\.pins$/.test(node.slot)) {
    const paths = parsePathList(value);
    if (paths.length === 0) {
      return fail(
        "empty_surface_pins",
        "Name at least one repository-relative file. A surface pin is what makes the declaration falsifiable; a declaration with nothing to re-hash passes every check vacuously."
      );
    }
    if (paths.length > MAX_SURFACE_PINS) {
      return fail("too_many_surface_pins", `Name at most ${MAX_SURFACE_PINS} files.`);
    }
    // Refused at the node rather than inside `requirementSchema.parse` during
    // --finalize. `artifactPathSchema` forbids backslashes, drive letters,
    // leading slashes, spaces and `..`, which is every property of a path pasted
    // out of a Windows shell.
    const invalid = paths.find((entry) => !artifactPathSchema.safeParse(entry).success);
    if (invalid !== undefined) {
      return fail(
        "invalid_surface_path",
        `"${invalid}" is not a repository-relative path. Use forward slashes relative to the repository root: no drive letters, no leading slash, no "..", no spaces.`
      );
    }
    // `verificationSurfaceSchema.superRefine` refuses a path pinned twice, and
    // `buildRequirements` parses rather than safe-parses — so without this the
    // answer "ops/compose.yml, ops/compose.yml", which is what listing files by
    // hand produces, was accepted by both intake layers and surfaced at
    // `--finalize` as a raw zod issue array with no nodeId, no slot and no
    // recovery. That is precisely what `mintPinnedReferences` says it exists to
    // prevent one function over.
    const repeated = firstRepeated(paths);
    if (repeated !== undefined) {
      return fail(
        "duplicate_surface_path",
        `"${repeated}" is named twice. Pin each file once: two pins on one path assert two different truths about the same bytes.`
      );
    }
    return undefined;
  }

  // The protected acceptance paths, checked at the node for the same reason the
  // surface pins are: a bad path can still be corrected here for the price of
  // retyping one line, and `buildRequirements` parses rather than safe-parses, so
  // anything that reaches `--finalize` arrives as a raw zod issue array with no
  // nodeId and no recovery.
  if (/^requirements\.\d+\.criteria\.\d+\.acceptance-paths$/.test(node.slot)) {
    const paths = parsePathList(value);
    // An empty answer is not an error here: the node is optional, and a skip
    // records `SKIPPED_VALUE` rather than an empty string. Reaching this with
    // nothing in it means the operator typed whitespace, which is the same
    // undeclared set and is the honest reading of it.
    if (paths.length === 0) return undefined;
    if (paths.length > MAX_ACCEPTANCE_PATHS) {
      return fail("too_many_acceptance_paths", `Name at most ${MAX_ACCEPTANCE_PATHS} files.`);
    }
    const invalid = paths.find((entry) => !artifactPathSchema.safeParse(entry).success);
    if (invalid !== undefined) {
      return fail(
        "invalid_acceptance_path",
        `"${invalid}" is not a repository-relative path. Use forward slashes relative to the repository root: no drive letters, no leading slash, no "..", no spaces.`
      );
    }
    const control = paths.find((entry) => namesControlPlane(entry));
    if (control !== undefined) {
      return fail(
        "control_plane_acceptance_path",
        `"${control}" is inside ${CONTROL_PLANE_ROOT}, which the guarded harness restores on every run rather than reporting. Name the test file the work must not weaken.`
      );
    }
    const repeated = firstRepeated(paths);
    if (repeated !== undefined) {
      return fail(
        "duplicate_acceptance_path",
        `"${repeated}" is named twice. Name each file once: the harness hashes them, and two entries for one path are one fact counted twice.`
      );
    }
    return undefined;
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
  /**
   * The verification surface as the operator typed it: empty strings where the
   * question was declined or never applicable. Kept raw here — minting the pins
   * needs the filesystem, and this function is pure.
   */
  readonly surfaceKind: string;
  readonly surfaceInterface: string;
  readonly surfaceRationale: string;
  readonly surfacePins: string;
  /**
   * The protected acceptance paths as the operator typed them, empty when the
   * question was declined or never applicable. Kept raw for `surfacePins`'
   * reason and one more: nothing hashes these at any point, so there is nothing
   * a filesystem read would add.
   */
  readonly acceptancePaths: string;
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
        detail: answerText(map, `req-${index}-ac-${criterion}-detail`) ?? "",
        surfaceKind: answerText(map, `req-${index}-ac-${criterion}-surface-kind`) ?? "",
        surfaceInterface: answerText(map, `req-${index}-ac-${criterion}-surface-interface`) ?? "",
        surfaceRationale: answerText(map, `req-${index}-ac-${criterion}-surface-rationale`) ?? "",
        surfacePins: answerText(map, `req-${index}-ac-${criterion}-surface-pins`) ?? "",
        acceptancePaths: answerText(map, `req-${index}-ac-${criterion}-acceptance-paths`) ?? ""
      });
    }

    drafts.push({ index, statement, priority, category, criteria });
  }
  return drafts;
}

/**
 * Everything wrong with one criterion's declared verification surface.
 *
 * A half-declared surface is refused rather than dropped. Dropping it turns "I
 * said this crosses a boundary" into the same answer as "nobody said anything" —
 * `unevaluable` at ship — which is the fail-open family this work exists to
 * close, arriving through the authoring path before a gate ever runs. Refusing
 * costs nothing: the answers stay in the session and one `--answer` repairs it.
 *
 * Most of these are unreachable through the graph, which asks the follow-ups
 * only after a kind is given and marks them required. They are checked anyway
 * because the graph's `required` flag is one line away from being wrong and a
 * hand-edited session file reaches every one of them.
 */
function surfaceDiagnostics(
  requirementIndex: number,
  criterion: CriterionDraft
): readonly IntakeDiagnostic[] {
  const kind = criterion.surfaceKind.trim();
  if (kind.length === 0) return [];

  const where = `Requirement ${requirementIndex}, criterion ${criterion.index}`;
  const nodePrefix = `req-${requirementIndex}-ac-${criterion.index}-surface`;
  const slotPrefix = `requirements.${requirementIndex}.criteria.${criterion.index}.surface`;
  const diagnostics: IntakeDiagnostic[] = [];

  if (criterion.proof !== "executable") {
    // The surface says what a *command* reached. On a criterion a human decides
    // there is no command, and the requirement's manual proof arm has nowhere to
    // put one — so without this the declaration would be dropped in silence by
    // `criterionFor`.
    return [
      {
        code: "surface_on_manual_criterion",
        message: `${where}: a verification surface describes what a command reaches, and this criterion is decided by a human. Remove the surface, or change the proof to a command.`,
        nodeId: `${nodePrefix}-kind`,
        slot: `${slotPrefix}.kind`
      }
    ];
  }

  if (!verificationSurfaceKindSchema.safeParse(kind).success) {
    diagnostics.push({
      code: "unknown_surface_kind",
      message: `${where}: choose one of ${verificationSurfaceKindSchema.options.join(", ")}.`,
      nodeId: `${nodePrefix}-kind`,
      slot: `${slotPrefix}.kind`
    });
  }

  if (criterion.surfaceInterface.trim().length === 0 || isNonAnswer(criterion.surfaceInterface)) {
    diagnostics.push({
      code: "surface_without_interface",
      message: `${where}: name the interface this command reaches. A surface with no interface names nothing a reviewer can check.`,
      nodeId: `${nodePrefix}-interface`,
      slot: `${slotPrefix}.interface`
    });
  }

  if (criterion.surfaceRationale.trim().length < 12 || isNonAnswer(criterion.surfaceRationale)) {
    diagnostics.push({
      code: "surface_without_rationale",
      message: `${where}: state what reaching this interface catches that a smaller check would miss. A declared surface with no argument behind it is a claim nobody can review.`,
      nodeId: `${nodePrefix}-rationale`,
      slot: `${slotPrefix}.rationale`
    });
  }

  const pins = parsePathList(criterion.surfacePins);
  if (pins.length === 0) {
    diagnostics.push({
      code: "surface_without_pins",
      message: `${where}: name at least one repository-relative file that makes this surface real. legion ship re-hashes them, and a declaration with nothing to re-hash passes every check vacuously.`,
      nodeId: `${nodePrefix}-pins`,
      slot: `${slotPrefix}.pins`
    });
  } else if (pins.length > MAX_SURFACE_PINS) {
    diagnostics.push({
      code: "too_many_surface_pins",
      message: `${where}: name at most ${MAX_SURFACE_PINS} files.`,
      nodeId: `${nodePrefix}-pins`,
      slot: `${slotPrefix}.pins`
    });
  } else {
    for (const pin of pins) {
      if (artifactPathSchema.safeParse(pin).success) continue;
      diagnostics.push({
        code: "invalid_surface_path",
        message: `${where}: "${pin}" is not a repository-relative path. Use forward slashes relative to the repository root: no drive letters, no leading slash, no "..", no spaces.`,
        nodeId: `${nodePrefix}-pins`,
        slot: `${slotPrefix}.pins`
      });
    }
    // The uniqueness rule `verificationSurfaceSchema.superRefine` enforces,
    // checked here as well because `buildRequirements` calls
    // `requirementSchema.parse` rather than `safeParse`. Without it a path named
    // twice — what listing files by hand produces — passed both intake layers and
    // reached the operator at `--finalize` as a raw zod issue array with no
    // nodeId, no slot and no recovery, one line away from the named
    // `invalid_surface_path` and `too_many_surface_pins` diagnostics for every
    // other property of the same answer.
    const repeated = firstRepeated(pins);
    if (repeated !== undefined) {
      diagnostics.push({
        code: "duplicate_surface_path",
        message: `${where}: "${repeated}" is named twice. Pin each file once: two pins on one path assert two different truths about the same bytes.`,
        nodeId: `${nodePrefix}-pins`,
        slot: `${slotPrefix}.pins`
      });
    }
  }

  return diagnostics;
}

/**
 * Everything wrong with one criterion's declared protected acceptance paths.
 *
 * `surfaceDiagnostics`' argument, over a different subject, and the manual arm is
 * the one that has to be here rather than in the node rule. The declaration lives
 * on the executable proof arm alone, so `criterionFor` has nowhere to put it on a
 * criterion a human decides — and without this it would be dropped in silence,
 * turning "these tests must not be weakened" into the same answer as "nobody
 * said", which is the fail-open family this whole series closes, arriving through
 * the authoring path before a gate ever runs.
 *
 * Every rule the node checks is checked again, because the graph's `required`
 * flag is one line away from being wrong and a hand-edited session file reaches
 * every one of them.
 */
function acceptancePathDiagnostics(
  requirementIndex: number,
  criterion: CriterionDraft
): readonly IntakeDiagnostic[] {
  const paths = parsePathList(criterion.acceptancePaths);
  if (paths.length === 0) return [];

  const where = `Requirement ${requirementIndex}, criterion ${criterion.index}`;
  const nodeId = `req-${requirementIndex}-ac-${criterion.index}-acceptance-paths`;
  const slot = `requirements.${requirementIndex}.criteria.${criterion.index}.acceptance-paths`;

  if (criterion.proof !== "executable") {
    return [
      {
        code: "acceptance_paths_on_manual_criterion",
        message: `${where}: a protected acceptance path constrains what an implementer's run may weaken, and this criterion is decided by a human, so no run is constrained by it. Remove the paths, or change the proof to a command.`,
        nodeId,
        slot
      }
    ];
  }

  const diagnostics: IntakeDiagnostic[] = [];
  if (paths.length > MAX_ACCEPTANCE_PATHS) {
    diagnostics.push({
      code: "too_many_acceptance_paths",
      message: `${where}: name at most ${MAX_ACCEPTANCE_PATHS} files.`,
      nodeId,
      slot
    });
    return diagnostics;
  }
  for (const entry of paths) {
    if (!artifactPathSchema.safeParse(entry).success) {
      diagnostics.push({
        code: "invalid_acceptance_path",
        message: `${where}: "${entry}" is not a repository-relative path. Use forward slashes relative to the repository root: no drive letters, no leading slash, no "..", no spaces.`,
        nodeId,
        slot
      });
      continue;
    }
    if (namesControlPlane(entry)) {
      diagnostics.push({
        code: "control_plane_acceptance_path",
        message: `${where}: "${entry}" is inside ${CONTROL_PLANE_ROOT}, which the guarded harness restores on every run rather than reporting. Name the test file the work must not weaken.`,
        nodeId,
        slot
      });
    }
  }
  const repeated = firstRepeated(paths);
  if (repeated !== undefined) {
    diagnostics.push({
      code: "duplicate_acceptance_path",
      message: `${where}: "${repeated}" is named twice. Name each file once: the harness hashes them, and two entries for one path are one fact counted twice.`,
      nodeId,
      slot
    });
  }
  return diagnostics;
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

      diagnostics.push(...surfaceDiagnostics(draft.index, criterion));
      diagnostics.push(...acceptancePathDiagnostics(draft.index, criterion));

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
