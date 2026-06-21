#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleChangeCommand } from "./commands/change/index.js";
import { handleMigrateCommand } from "./commands/migrate/index.js";
import { handleProjectCommand } from "./commands/project/index.js";
import {
  helpResult,
  parseCliArgs,
  stripCommand,
  unexpectedError,
  usageError,
  type CliContext,
  type CliResult
} from "./runtime.js";

const ROOT_HELP = `legion next <command>

Commands:
  project   Initialize, validate, and inspect v9 project artifacts.
  change    Create, validate, diff, and archive v9 change bundles.
  migrate   Dry-run, apply, and roll back legacy migration flows.

Global:
  --repository-root <path>  Repository root. Defaults to the current directory.
  --json                    Emit machine-readable JSON.
  --no-color                Disable ANSI styling.
  --help                    Show help.`;

export interface CliIo {
  readonly cwd: string;
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export async function runCli(argv: readonly string[] = process.argv.slice(2), io: CliIo = {
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr
}): Promise<number> {
  const namespacedArgs = argv[0] === "next" ? argv.slice(1) : argv;
  const parsed = parseCliArgs(namespacedArgs);
  const repositoryRoot = path.resolve(stringMapValue(parsed.options, "repository-root") ?? stringMapValue(parsed.options, "repo") ?? io.cwd);
  const context: CliContext = {
    args: parsed,
    repositoryRoot,
    json: parsed.options.has("json"),
    noColor: parsed.options.has("no-color"),
    cwd: io.cwd
  };

  let result: CliResult;
  try {
    result = await dispatch(context);
  } catch (error) {
    result = unexpectedError(error);
  }

  writeResult(result, context, io);
  return result.exitCode;
}

async function dispatch(context: CliContext): Promise<CliResult> {
  if (context.args.options.has("help") && context.args.positionals.length === 0) return helpResult(ROOT_HELP);
  const [command] = context.args.positionals;
  if (command === undefined) return helpResult(ROOT_HELP);

  const commandContext = stripCommand(context, 1);
  switch (command) {
    case "project":
      return handleProjectCommand(commandContext);
    case "change":
      return handleChangeCommand(commandContext);
    case "migrate":
      return handleMigrateCommand(commandContext);
    default:
      return usageError(`Unknown legion next command: ${command}.`);
  }
}

function writeResult(result: CliResult, context: CliContext, io: CliIo): void {
  if (context.json) {
    io.stdout.write(`${JSON.stringify(result.payload, null, 2)}\n`);
    return;
  }

  const stream = result.exitCode === 0 ? io.stdout : io.stderr;
  stream.write(`${result.human}\n`);
}

function stringMapValue(map: ReadonlyMap<string, string | true>, key: string): string | undefined {
  const value = map.get(key);
  return typeof value === "string" ? value : undefined;
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath !== undefined && path.resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  const exitCode = await runCli();
  process.exitCode = exitCode;
}
