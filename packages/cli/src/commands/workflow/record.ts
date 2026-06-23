import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { success, usageError, type CliContext, type CliResult } from "../../runtime.js";
import { createdAtOption, slugFromName } from "../../workflow/input.js";
import { renderNextAction, type NextAction } from "../../workflow/render.js";

export interface StandaloneWorkflowRecordOptions {
  readonly workflow: string;
  readonly input: Record<string, unknown>;
  readonly nextAction: NextAction;
  readonly slugSource: string;
}

export function positionalText(context: CliContext): string | undefined {
  const text = context.args.positionals.join(" ").trim();
  return text.length > 0 ? text : undefined;
}

export async function recordStandaloneWorkflow(
  context: CliContext,
  options: StandaloneWorkflowRecordOptions
): Promise<CliResult> {
  const createdAt = recordCreatedAt(context);
  if (typeof createdAt !== "string") return createdAt;

  const slug = slugFromName(options.slugSource);
  const safeTimestamp = createdAt.replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+$/g, "");
  const artifactPath = `.legion/project/workflow/${options.workflow}/${safeTimestamp}-${slug}.json`;
  const absolutePath = path.join(context.repositoryRoot, ...artifactPath.split("/"));
  const record = {
    schemaVersion: 1,
    kind: "workflow_record",
    workflow: options.workflow,
    createdAt,
    input: options.input,
    nextAction: options.nextAction
  };

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  return success(
    {
      ok: true,
      status: "recorded",
      workflow: options.workflow,
      createdAt,
      artifactPath,
      nextAction: options.nextAction,
      diagnostics: []
    },
    [
      `Recorded ${options.workflow} request.`,
      `Artifact: ${artifactPath}`,
      renderNextAction(options.nextAction)
    ].join("\n")
  );
}

function recordCreatedAt(context: CliContext): string | CliResult {
  if (context.args.options.get("created-at") === true) {
    return usageError("Missing required value for --created-at. Use a canonical UTC timestamp such as 2026-06-22T12:00:00.000Z.");
  }

  try {
    return createdAtOption(context) ?? new Date().toISOString();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return usageError(`Invalid --created-at value. Use a canonical UTC timestamp such as 2026-06-22T12:00:00.000Z. ${message}`);
  }
}
