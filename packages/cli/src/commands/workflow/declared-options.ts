import { usageError, type CliContext, type CliResult } from "../../runtime.js";

/**
 * What each workflow command reads.
 *
 * `parseCliArgs` accepts any option, so a flag no handler reads was silently
 * ignored — and the caller got a confident answer to a question they had not
 * asked. That is one mechanism behind a whole class of defects found in this
 * phase: `legion review --phase 3` reviewed and could accept a change other than
 * the one named, `legion build --phase 3` built the latest taskgraph, and
 * `legion start --session <id> --from-exploration <run>` discarded the
 * exploration. None of them failed. Each returned success.
 *
 * Declaring the surface converts the whole class into a usage error at the
 * boundary rather than a wrong answer at the end. The list is the contract: a
 * flag that appears in a command's help text and not here will be refused, which
 * is the loud version of the failure it used to have quietly.
 */

/** Accepted everywhere, because the runtime or every handler reads them. */
const GLOBAL_OPTIONS = new Set([
  "created-at",
  "help",
  "json",
  "no-color",
  "repo",
  "repository-root"
]);

const DECLARED: Readonly<Record<string, readonly string[]>> = Object.freeze({
  start: [
    "abort", "accept-proposal", "answer", "back", "dry-run", "finalize", "force-roadmap",
    "from-exploration", "from-planning", "from-roadmap", "intake", "name",
    // Declared although no branch reads it: the default path IS "ask the next
    // question", so --next names that explicitly and is the documented way to
    // drive the interview. Refusing it would break the interface the host loop
    // is written against.
    "next",
    "node", "owner", "session", "session-status", "skip", "slug", "summary",
    "allow-replace-existing-project"
  ],
  status: [],
  plan: ["auto-refine", "dry-run", "from-roadmap"],
  build: ["allow-dirty", "dry-run", "executor"],
  // `approver` takes a value, so it must NOT also go in VALUELESS_OPTIONS: a
  // valueless declaration would make `--approver dasbl` bind nothing and read as
  // absent, which for this flag means an R3 accept refusing an approver the
  // operator did name.
  review: ["accept", "approver", "auto", "dry-run", "executor", "max-cycles", "phase", "reject-reason"],
  // One list for every `legion approve <subject>`, because
  // `undeclaredOptionError` runs on the stripped context before the handler and
  // cannot see which subject was named. The boundary between subjects is
  // therefore the handler's, and `handleApproveWorkflow` enforces it: each
  // subject owns exactly one narrowing flag — `spec` owns `--requirement`,
  // `oracle` owns `--oracle`, `surface` owns `--path` — and every subject
  // refuses the other two by name. Accepted here and refused there — the
  // alternative is a flag the operator typed being ignored in silence, which is
  // how a command reports success for a thing it did not do.
  //
  // `--oracle` takes a value, so like `--approver` it must NOT also go in
  // VALUELESS_OPTIONS: a valueless declaration would make `--oracle orc_x` bind
  // nothing and read as absent, which here means approving the change's whole
  // oracle set when the operator named one.
  approve: ["approver", "dry-run", "oracle", "path", "requirement"],
  ship: ["allow-legacy-evidence", "dry-run", "review-accepted"],
  validate: [],
  doctor: [],
  quick: [],
  polish: [],
  advise: ["executor"],
  learn: ["list", "recall", "summary", "tags", "type"],
  explore: ["entry", "executor"],
  map: ["check", "query", "refresh", "scope"],
  // phase and milestone are declared so the handler's own refusal is what the
  // caller sees: it explains that a scoped retrospective is not implemented,
  // which is more use than "this command does not read --phase".
  retro: ["dry-run", "executor", "milestone", "phase", "save"],
  milestone: ["archive", "complete", "define", "phases", "status", "summary"],
  council: ["executor"]
});

/**
 * Refuse any option the named command does not read.
 *
 * Returns `undefined` for commands with no declaration, so an unlisted command
 * keeps today's permissive behaviour rather than being broken by omission.
 */
export function undeclaredOptionError(context: CliContext, command: string): CliResult | undefined {
  const declared = DECLARED[command];
  if (declared === undefined) return undefined;

  const allowed = new Set([...GLOBAL_OPTIONS, ...declared]);
  const undeclared = [...context.args.options.keys()].filter((key) => !allowed.has(key)).sort();
  if (undeclared.length === 0) return undefined;

  const named = undeclared.map((key) => `--${key}`).join(", ");
  return usageError(
    `legion ${command} does not read ${named}. Passing an option a command ignores returns an answer to a different question, so it is refused. Accepted: ${[...declared].sort().map((key) => `--${key}`).join(", ") || "no command-specific options"}.`
  );
}

/** Exposed so a test can hold the declarations against the handlers. */
export function declaredOptionsFor(command: string): readonly string[] | undefined {
  return DECLARED[command];
}

export const DECLARED_COMMANDS = Object.freeze(Object.keys(DECLARED));
