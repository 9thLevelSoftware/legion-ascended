#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleDevCommand } from "./commands/dev/index.js";
import { WORKFLOW_COMMANDS } from "./commands/registry.js";
import { handleWorkflowCommand } from "./commands/workflow/index.js";
import {
  helpResult,
  parseCliArgs,
  stripCommand,
  unexpectedError,
  withWarning,
  type CliContext,
  type CliResult
} from "./runtime.js";

const ROOT_HELP = `legion <command>

Workflow commands:
${WORKFLOW_COMMANDS.map((entry) => `  ${entry.name.padEnd(10)} ${entry.summary}`).join("\n")}

Advanced:
  dev        Advanced typed engine and operator commands.
  install    Install Legion workflows into an AI coding runtime.

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
  const parsed = parseCliArgs(argv);
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

  if (command === "dev") {
    return handleDevCommand(stripCommand(context, 1));
  }

  if (command === "next") {
    const result = await handleDevCommand(stripCommand(context, 1));
    return withWarning(result, {
      code: "legacy_next_namespace",
      message: legacyNextMessage(context.args.positionals)
    });
  }

  return handleWorkflowCommand(context);
}

function legacyNextMessage(positionals: readonly string[]): string {
  const replacement = positionals.slice(1).join(" ");
  const command = replacement.length > 0 ? ` ${replacement}` : "";
  return `Use legion dev${command}. The legion next namespace is a hidden compatibility alias.`;
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
