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
  const record = {
    schemaVersion: 1,
    kind: "workflow_record",
    workflow: options.workflow,
    createdAt,
    input: options.input,
    nextAction: options.nextAction
  };
  const recordContent = `${JSON.stringify(record, null, 2)}\n`;

  const artifactPath = await writeUniqueWorkflowRecord({
    repositoryRoot: context.repositoryRoot,
    workflow: options.workflow,
    safeTimestamp,
    slug,
    content: recordContent
  });

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

async function writeUniqueWorkflowRecord(input: {
  readonly repositoryRoot: string;
  readonly workflow: string;
  readonly safeTimestamp: string;
  readonly slug: string;
  readonly content: string;
}): Promise<string> {
  const artifactDirectory = `.legion/project/workflow/${input.workflow}`;
  const absoluteDirectory = path.join(input.repositoryRoot, ...artifactDirectory.split("/"));
  await mkdir(absoluteDirectory, { recursive: true });

  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const artifactPath = `${artifactDirectory}/${input.safeTimestamp}-${input.slug}${suffix}.json`;
    const absolutePath = path.join(input.repositoryRoot, ...artifactPath.split("/"));
    try {
      await writeFile(absolutePath, input.content, { encoding: "utf8", flag: "wx" });
      return artifactPath;
    } catch (error) {
      if (isEexist(error)) continue;
      throw error;
    }
  }

  throw new Error(`Unable to create a unique workflow record for ${input.workflow} after 1000 attempts.`);
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

function isEexist(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
