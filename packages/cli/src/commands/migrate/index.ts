import path from "node:path";

import {
  applyCodexLegionMigration,
  applyPlanningImport,
  createCodexLegionMigrationDryRun,
  createPlanningImportDryRun,
  rollbackCodexLegionMigration,
  rollbackPlanningImport,
  type PlanningImportProjectInput
} from "@legion/legacy-bridge";

import {
  fromServiceResult,
  hasFlag,
  helpResult,
  isCliResult,
  readJsonInput,
  requiredStringOption,
  stringOption,
  usageError,
  type CliContext,
  type CliResult
} from "../../runtime.js";

/**
 * Coerce the `--project` file into the shape the importer needs.
 *
 * Two shapes are accepted, because the file an operator reaches for is not the
 * one the flag was documented with. `.legion/project/project.json` is the only
 * project JSON a repository contains, so it is what gets pointed at — and it is
 * a *manifest*: the project is nested, and its owners live under
 * `policy.decisionOwners` rather than at the top level.
 *
 * That mismatch used to surface as `TypeError: Cannot read properties of
 * undefined (reading 'map')` from inside `initProject`, several layers below the
 * flag that caused it. Reading a file as arbitrary JSON and passing it through
 * defers every shape question to whoever dereferences it first.
 *
 * Validated by hand rather than with a schema: `zod` is a protocol dependency,
 * and widening the CLI's dependencies for one shape check is a worse trade than
 * a dozen lines that read plainly.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Actors need a kind and an id; anything else is not an owner list. */
function decisionOwners(value: unknown): readonly Record<string, unknown>[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const owners = value.map(asRecord);
  if (owners.some((owner) => owner === undefined)) return undefined;
  const typed = owners as Record<string, unknown>[];
  if (typed.some((owner) => nonEmptyString(owner["kind"]) === undefined)) return undefined;
  if (typed.some((owner) => nonEmptyString(owner["id"]) === undefined)) return undefined;
  return typed;
}

export function coercePlanningProjectInput(
  value: Record<string, unknown>,
  sourcePath: string
): PlanningImportProjectInput | CliResult {
  // A manifest wraps the project; accept either the manifest or the project it
  // contains, since both are reasonable things to have extracted.
  const candidate = asRecord(value["project"]) ?? value;
  const slug = nonEmptyString(candidate["slug"]);
  const name = nonEmptyString(candidate["name"]);
  const owners =
    decisionOwners(candidate["decisionOwners"]) ??
    decisionOwners(asRecord(candidate["policy"])?.["decisionOwners"]);

  if (slug === undefined || name === undefined || owners === undefined) {
    return usageError(
      `${sourcePath} is not a project input. Provide a JSON object with slug, name and decisionOwners, ` +
        `or point --project at .legion/project/project.json.`
    );
  }

  const description = nonEmptyString(candidate["description"]);
  const createdAt = nonEmptyString(candidate["createdAt"]);
  return {
    slug,
    name,
    ...(description === undefined ? {} : { description }),
    ...(createdAt === undefined ? {} : { createdAt }),
    decisionOwners: owners as PlanningImportProjectInput["decisionOwners"]
  };
}

const MIGRATE_HELP = `legion dev migrate --from-planning|--from-codex-legion --verify|--dry-run|--apply|--rollback

Compatibility verify:
  --from-planning --verify --planning-root <path> --staging-root <path> --run-id <id> --project <file>
  --from-codex-legion --verify --staging-root <path> --run-id <id>

Planning dry-run:
  --from-planning --dry-run --planning-root <path> --staging-root <path> --run-id <id> --project <file>

Codex Legion dry-run:
  --from-codex-legion --dry-run --staging-root <path> --run-id <id>

Apply:
  --apply --staging-root <path> --backup-root <path> --review-accepted

Rollback:
  --rollback --backup-manifest <path>`;

type MigrationSource = "planning" | "codex-legion";
type MigrationAction = "dry-run" | "apply" | "rollback";

export async function handleMigrateCommand(context: CliContext): Promise<CliResult> {
  if (hasFlag(context, "help")) return helpResult(MIGRATE_HELP);

  const source = migrationSource(context);
  if (typeof source !== "string") return source;
  const action = migrationAction(context);
  if (typeof action !== "string") return action;

  if (source === "planning") return handlePlanning(context, action);
  return handleCodexLegion(context, action);
}

async function handlePlanning(context: CliContext, action: MigrationAction): Promise<CliResult> {
  if (action === "dry-run") {
    const planningRootOption = requiredStringOption(context, "planning-root");
    if (typeof planningRootOption !== "string") return planningRootOption;
    // Relative paths resolve against the repository, not the process cwd, for
    // the same reason as `--project`: `--planning-root .planning` is the
    // documented invocation and it named nothing unless the operator happened to
    // be standing in the repository.
    const planningRoot = path.isAbsolute(planningRootOption)
      ? planningRootOption
      : path.resolve(context.repositoryRoot, planningRootOption);
    const stagingRoot = requiredStringOption(context, "staging-root");
    if (typeof stagingRoot !== "string") return stagingRoot;
    const runId = requiredStringOption(context, "run-id");
    if (typeof runId !== "string") return runId;
    const projectPath = requiredStringOption(context, "project");
    if (typeof projectPath !== "string") return projectPath;

    // Resolved against the repository root, as `legion start --intake` already
    // does. Resolving against the process cwd meant the documented invocation —
    // `--project .legion/project/project.json` — only worked when the operator
    // happened to be standing in the repository.
    const projectFile = await readJsonInput(
      path.isAbsolute(projectPath) ? projectPath : path.resolve(context.repositoryRoot, projectPath)
    );
    if (isCliResult(projectFile)) return projectFile;

    // `isCliResult` narrows a record union; this returns a typed project, so the
    // discriminant is checked directly.
    const project = coercePlanningProjectInput(projectFile, projectPath);
    if ("exitCode" in project) return project;

    const result = await createPlanningImportDryRun({
      repositoryRoot: context.repositoryRoot,
      planningRoot,
      stagingRoot,
      runId,
      project: project as unknown as PlanningImportProjectInput
    });
    return fromServiceResult(result as unknown as Record<string, unknown>, result.ok ? "Planning import dry-run created." : "Planning import dry-run failed.");
  }

  if (action === "apply") {
    const stagingRoot = requiredStringOption(context, "staging-root");
    if (typeof stagingRoot !== "string") return stagingRoot;
    const backupRoot = requiredStringOption(context, "backup-root");
    if (typeof backupRoot !== "string") return backupRoot;
    const appliedAt = stringOption(context, "applied-at");
    const result = await applyPlanningImport({
      repositoryRoot: context.repositoryRoot,
      stagingRoot,
      backupRoot,
      reviewAccepted: hasFlag(context, "review-accepted"),
      allowReplaceExistingProject: hasFlag(context, "allow-replace-existing-project"),
      ...(appliedAt === undefined ? {} : { appliedAt })
    });
    return fromServiceResult(result as unknown as Record<string, unknown>, result.ok ? "Planning import applied." : "Planning import apply failed.");
  }

  const backupManifestPath = requiredStringOption(context, "backup-manifest");
  if (typeof backupManifestPath !== "string") return backupManifestPath;
  const result = await rollbackPlanningImport({
    repositoryRoot: context.repositoryRoot,
    backupManifestPath
  });
  return fromServiceResult(result as unknown as Record<string, unknown>, result.ok ? "Planning import rolled back." : "Planning import rollback failed.");
}

async function handleCodexLegion(context: CliContext, action: MigrationAction): Promise<CliResult> {
  if (action === "dry-run") {
    const stagingRoot = requiredStringOption(context, "staging-root");
    if (typeof stagingRoot !== "string") return stagingRoot;
    const runId = requiredStringOption(context, "run-id");
    if (typeof runId !== "string") return runId;
    const createdAt = stringOption(context, "created-at");
    const result = await createCodexLegionMigrationDryRun({
      repositoryRoot: context.repositoryRoot,
      stagingRoot,
      runId,
      ...(createdAt === undefined ? {} : { createdAt })
    });
    return fromServiceResult(result as unknown as Record<string, unknown>, result.ok ? "Codex Legion migration dry-run created." : "Codex Legion migration dry-run failed.");
  }

  if (action === "apply") {
    const stagingRoot = requiredStringOption(context, "staging-root");
    if (typeof stagingRoot !== "string") return stagingRoot;
    const backupRoot = requiredStringOption(context, "backup-root");
    if (typeof backupRoot !== "string") return backupRoot;
    const appliedAt = stringOption(context, "applied-at");
    const result = await applyCodexLegionMigration({
      repositoryRoot: context.repositoryRoot,
      stagingRoot,
      backupRoot,
      reviewAccepted: hasFlag(context, "review-accepted"),
      ...(appliedAt === undefined ? {} : { appliedAt })
    });
    return fromServiceResult(result as unknown as Record<string, unknown>, result.ok ? "Codex Legion migration applied." : "Codex Legion migration apply failed.");
  }

  const backupManifestPath = requiredStringOption(context, "backup-manifest");
  if (typeof backupManifestPath !== "string") return backupManifestPath;
  const result = await rollbackCodexLegionMigration({
    repositoryRoot: context.repositoryRoot,
    backupManifestPath
  });
  return fromServiceResult(result as unknown as Record<string, unknown>, result.ok ? "Codex Legion migration rolled back." : "Codex Legion migration rollback failed.");
}

function migrationSource(context: CliContext): MigrationSource | CliResult {
  const planning = hasFlag(context, "from-planning");
  const codexLegion = hasFlag(context, "from-codex-legion");
  if (planning === codexLegion) {
    return {
      exitCode: 1,
      payload: {
        ok: false,
        status: "usage_error",
        diagnostics: [{ code: "usage_error", message: "Choose exactly one migration source." }]
      },
      human: "Choose exactly one migration source."
    };
  }
  return planning ? "planning" : "codex-legion";
}

function migrationAction(context: CliContext): MigrationAction | CliResult {
  const actions: MigrationAction[] = [];
  if (hasFlag(context, "dry-run") || hasFlag(context, "verify")) actions.push("dry-run");
  if (hasFlag(context, "apply")) actions.push("apply");
  if (hasFlag(context, "rollback")) actions.push("rollback");
  if (actions.length !== 1) {
    return {
      exitCode: 1,
      payload: {
        ok: false,
        status: "usage_error",
        diagnostics: [{ code: "usage_error", message: "Choose exactly one migration action." }]
      },
      human: "Choose exactly one migration action."
    };
  }
  return actions[0] ?? "dry-run";
}
