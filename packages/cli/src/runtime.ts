import { readFile } from "node:fs/promises";

export interface ParsedCliArgs {
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, string | true>;
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

const VALUELESS_OPTIONS = new Set([
  "allow-replace-existing-project",
  "allow-dirty",
  "apply",
  "accept",
  "auto",
  "auto-refine",
  "dry-run",
  "from-codex-legion",
  "from-planning",
  "help",
  "json",
  "no-color",
  "review-accepted",
  "rollback"
]);

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();

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
      options.set(key, value);
      continue;
    }

    if (VALUELESS_OPTIONS.has(withoutPrefix)) {
      options.set(withoutPrefix, true);
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options.set(withoutPrefix, next);
      index += 1;
      continue;
    }

    options.set(withoutPrefix, true);
  }

  return { positionals, options };
}

export function hasFlag(context: CliContext, key: string): boolean {
  return context.args.options.get(key) === true;
}

export function stringOption(context: CliContext, key: string): string | undefined {
  const value = context.args.options.get(key);
  return typeof value === "string" ? value : undefined;
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
