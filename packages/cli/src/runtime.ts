import { readFile } from "node:fs/promises";

export interface ParsedCliArgs {
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, string | true>;
  /**
   * Valueless options that were given a value, as `--flag=value`.
   *
   * Refused rather than ignored. Silently dropping the value would read
   * `--json=false` as `--json`, and silently keeping it reproduces the defect
   * this list exists to close: the flag binds a string, `hasFlag` reads false,
   * and the handler runs the branch the caller did not ask for.
   */
  readonly invalidOptions: readonly string[];
  /**
   * Every string-valued occurrence of a repeatable option, in argv order.
   *
   * `options` is a `Map`, so a second `--source b` replaces the first and the
   * command records an attestation citing one file when the operator named two.
   * Comma-splitting was refused for the reason `legion approve spec` already
   * records for `--requirement` — a second parser to keep honest — and it is
   * strictly worse for paths, because a comma is a legal filename character on
   * every platform Legion runs on, so the split would be *wrong* rather than
   * merely redundant.
   *
   * Additive: `options` keeps last-wins and no existing handler moves by one
   * byte. Optional on the type so the several `.mjs` suites that hand-build a
   * `{positionals, options}` literal keep working — `repeatedStringOptions`
   * falls back to the single value, which is what a hand-built context means.
   */
  readonly repeated?: ReadonlyMap<string, readonly string[]>;
}

export interface CliContext {
  readonly args: ParsedCliArgs;
  readonly repositoryRoot: string;
  readonly json: boolean;
  readonly noColor: boolean;
  readonly cwd: string;
}

export interface CliWarning {
  readonly code: string;
  readonly message: string;
}

export interface CliResult {
  readonly exitCode: number;
  readonly payload: Record<string, unknown>;
  readonly human: string;
}

export type CommandHandler = (context: CliContext) => Promise<CliResult>;

/**
 * Options that never take a value.
 *
 * Membership is not cosmetic. `hasFlag` requires the parsed value to be exactly
 * `true`, so an option missing from this set silently binds the next argument
 * and then reads as *absent*. `legion map --check src` did not check a scope, and
 * did not fail: `check` bound to "src", `hasFlag` returned false, and the handler
 * fell through to the destructive branch and refreshed the whole repository —
 * overwriting the map the caller asked it to inspect.
 *
 * So this set must contain every key any handler reads with `hasFlag`, and
 * `tests/cli-option-parsing.test.mjs` asserts that by scanning the source rather
 * than trusting this comment. Adding a boolean flag and forgetting this line is
 * the whole defect, and it is not the kind of thing review catches.
 */
const VALUELESS_OPTIONS = new Set([
  "abort",
  "accept-proposal",
  "allow-replace-existing-project",
  "allow-dirty",
  "allow-legacy-evidence",
  "apply",
  "accept",
  "auto",
  "auto-refine",
  "back",
  "check",
  "dry-run",
  "finalize",
  "force-roadmap",
  "from-codex-legion",
  "from-planning",
  "help",
  "json",
  "list",
  // Without this, `legion start --next --json` is fine but `legion start --next`
  // followed by any positional swallows it as the flag's value.
  "next",
  "no-color",
  "refresh",
  "review-accepted",
  "rollback",
  "session-status",
  "skip",
  "status",
  "verify"
]);

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  const repeated = new Map<string, string[]>();
  const invalidOptions: string[] = [];

  const record = (key: string, value: string): void => {
    const existing = repeated.get(key);
    if (existing === undefined) repeated.set(key, [value]);
    else existing.push(value);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex !== -1) {
      const key = withoutPrefix.slice(0, equalsIndex);
      const value = withoutPrefix.slice(equalsIndex + 1);
      // This branch runs before the valueless check, so `--check=src` bound a
      // string and `hasFlag` read false — the same vanishing flag as the space
      // form, reached by the syntax the first fix did not cover.
      if (VALUELESS_OPTIONS.has(key)) {
        invalidOptions.push(key);
        options.set(key, true);
        continue;
      }
      options.set(key, value);
      record(key, value);
      continue;
    }

    if (VALUELESS_OPTIONS.has(withoutPrefix)) {
      options.set(withoutPrefix, true);
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options.set(withoutPrefix, next);
      record(withoutPrefix, next);
      index += 1;
      continue;
    }

    options.set(withoutPrefix, true);
  }

  return { positionals, options, invalidOptions, repeated };
}

/** The usage error for `--flag=value` on a flag that takes no value, if any. */
export function invalidOptionError(args: ParsedCliArgs): CliResult | undefined {
  if (args.invalidOptions.length === 0) return undefined;
  const named = args.invalidOptions.map((key) => `--${key}`).join(", ");
  return usageError(
    `${named} ${args.invalidOptions.length === 1 ? "does" : "do"} not take a value. Pass the flag on its own, and give any path or text to the option that expects it.`
  );
}

export function hasFlag(context: CliContext, key: string): boolean {
  return context.args.options.get(key) === true;
}

export function stringOption(context: CliContext, key: string): string | undefined {
  const value = context.args.options.get(key);
  return typeof value === "string" ? value : undefined;
}

/**
 * Every value the operator gave one option, in argv order.
 *
 * The `?.` is load-bearing rather than defensive: several `.mjs` suites build a
 * `CliContext` by hand with `{positionals, options}` and no `repeated`, and a
 * bare `.get` there would throw out of a command those tests are not about.
 */
export function repeatedStringOptions(context: CliContext, key: string): readonly string[] {
  const recorded = context.args.repeated?.get(key);
  if (recorded !== undefined) return recorded;
  const single = stringOption(context, key);
  return single === undefined ? [] : [single];
}

export function requiredStringOption(context: CliContext, key: string): string | CliResult {
  const value = stringOption(context, key);
  if (value !== undefined && value.length > 0) return value;
  return usageError(`Missing required option --${key}.`);
}

export async function readJsonInput(filePath: string): Promise<Record<string, unknown> | CliResult> {
  try {
    const text = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return usageError(`JSON input must be an object: ${filePath}`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return usageError(`Failed to read or parse JSON input at ${filePath}: ${message}`);
  }
}

export function isCliResult(value: Record<string, unknown> | CliResult): value is CliResult {
  return (
    typeof (value as CliResult).exitCode === "number" &&
    typeof (value as CliResult).human === "string" &&
    typeof (value as CliResult).payload === "object" &&
    (value as CliResult).payload !== null
  );
}

export function success(payload: Record<string, unknown>, human: string): CliResult {
  return { exitCode: 0, payload, human };
}

export function failure(payload: Record<string, unknown>, human: string): CliResult {
  return { exitCode: 1, payload, human };
}

export function fromServiceResult(result: Record<string, unknown>, human: string): CliResult {
  return result["ok"] === true ? success(result, human) : failure(result, human);
}

export function usageError(message: string): CliResult {
  return failure(
    {
      ok: false,
      status: "usage_error",
      diagnostics: [
        {
          code: "usage_error",
          message
        }
      ]
    },
    message
  );
}

export function unexpectedError(error: unknown): CliResult {
  const message = error instanceof Error ? error.message : String(error);
  return failure(
    {
      ok: false,
      status: "error",
      diagnostics: [
        {
          code: "unhandled_error",
          message
        }
      ]
    },
    message
  );
}

export function withWarning(result: CliResult, warning: CliWarning): CliResult {
  const existing = Array.isArray(result.payload["warnings"]) ? result.payload["warnings"] as readonly unknown[] : [];
  return {
    ...result,
    payload: {
      ...result.payload,
      warnings: [...existing, warning]
    },
    human: result.human.length > 0 ? `${result.human}\nwarning: ${warning.message}` : `warning: ${warning.message}`
  };
}

export function stripCommand(context: CliContext, count: number): CliContext {
  return {
    ...context,
    args: {
      ...context.args,
      positionals: context.args.positionals.slice(count)
    }
  };
}

export function helpResult(text: string): CliResult {
  return success(
    {
      ok: true,
      status: "help",
      help: text
    },
    text
  );
}
