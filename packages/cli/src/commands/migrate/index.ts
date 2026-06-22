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
  type CliContext,
  type CliResult
} from "../../runtime.js";

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
    const planningRoot = requiredStringOption(context, "planning-root");
    if (typeof planningRoot !== "string") return planningRoot;
    const stagingRoot = requiredStringOption(context, "staging-root");
    if (typeof stagingRoot !== "string") return stagingRoot;
    const runId = requiredStringOption(context, "run-id");
    if (typeof runId !== "string") return runId;
    const projectPath = requiredStringOption(context, "project");
    if (typeof projectPath !== "string") return projectPath;

    const project = await readJsonInput(projectPath);
    if (isCliResult(project)) return project;

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
