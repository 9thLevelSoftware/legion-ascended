import { z } from "zod";

/**
 * The executable mirror of `docs/settings.schema.json`.
 *
 * The published file is documentation that nothing runs. It is frozen by
 * `checksums.sha256`, and `settings.json` points at it with a relative
 * `$schema` path that only resolves inside this repository — so in a user's
 * project the pointer dangles by construction. Nothing in `packages/` has ever
 * read `control_mode`, `max_tasks_per_plan`, or `max_cycles`.
 *
 * A Zod mirror rather than the published schema itself because there is no JSON
 * Schema validator in the tree: no `ajv` in any package, and the CLI bundle's
 * only externals are `node:*` and `yaml`. This is the only executable authority;
 * the published file stays frozen, and `tests/validate-settings.test.mjs` holds
 * the two in agreement so the mirror cannot drift into a second dialect.
 *
 * Pure by design — no `node:fs` here. The CLI reads the file; this validates a
 * value.
 */

const controlMode = z.enum(["autonomous", "guarded", "advisory", "surgical"]);
const always = z.enum(["always", "prompt", "never"]);

/**
 * Top-level blocks are optional here, where the published schema requires seven.
 *
 * Deliberate, and the only place the mirror departs from the published shape. A
 * project that omits a block is taking the defaults, which is the documented way
 * to use this file — reporting that as a finding would make a correct settings
 * file noisy and teach operators to ignore the check.
 *
 * The relaxation stops at the block boundary. Inside a block that IS present,
 * every member the published schema requires is required here, because a
 * half-written block is not a defaulted one: `{"models": {}}` names a models
 * configuration and supplies none of it. An earlier revision made those members
 * optional too and described only the top-level relaxation, so blocks silently
 * lost the validation this whole file exists to provide.
 */
export const settingsSchema = z
  .object({
    $schema: z.string().optional(),
    control_mode: controlMode.optional(),
    models: z
      .object({
        planning: z.string(),
        execution: z.string(),
        check: z.string(),
        planning_reasoning: z.boolean().optional()
      })
      .strict()
      .optional(),
    planning: z
      .object({
        max_tasks_per_plan: z.number().int().min(1).max(5),
        architecture_proposals_default: always,
        spec_pipeline_default: always
      })
      .strict()
      .optional(),
    execution: z
      .object({
        auto_commit: z.boolean(),
        commit_prefix: z.string().min(1),
        agent_personality_verbosity: z.enum(["full", "condensed"]),
        use_worktrees: z.boolean().optional()
      })
      .strict()
      .optional(),
    review: z
      .object({
        default_mode: z.enum(["classic", "panel"]),
        max_cycles: z.number().int().min(1).max(5),
        evaluator_depth: z.enum(["single", "multi-pass"]).optional(),
        polish: z.boolean().optional(),
        polish_scope: z.enum(["changed", "dependents", "directory"]).optional(),
        coverage_thresholds: z
          .object({
            overall: z.number().int().min(0).max(100).optional(),
            business_logic: z.number().int().min(0).max(100).optional(),
            api_routes: z.number().int().min(0).max(100).optional()
          })
          .strict()
          .optional()
      })
      .strict()
      .optional(),
    board: z
      .object({
        default_size: z.number().int().min(2).max(7),
        min_size: z.number().int().min(2).max(5),
        discussion_rounds: z.number().int().min(1).max(5),
        assessment_timeout_ms: z.number().int().min(30_000),
        persist_artifacts: z.boolean()
      })
      .strict()
      .optional(),
    dispatch: z
      .object({
        enabled: z.boolean(),
        fallback_to_internal: z.boolean(),
        timeout_ms: z.number().int().min(10_000),
        max_retries: z.number().int().min(0).max(3)
      })
      .strict()
      .optional(),
    memory: z
      .object({
        enabled: z.boolean(),
        // Const in the published schema, and it means what it says: memory is
        // project-scoped and a file claiming otherwise is claiming a mode that
        // does not exist.
        project_scoped_only: z.literal(true),
        auto_prune: z.boolean().optional(),
        prune_threshold: z.number().int().min(1).optional(),
        prune_age_days: z.number().int().min(1).optional()
      })
      .strict()
      .optional(),
    integrations: z
      .object({
        github: z.enum(["enabled", "disabled", "prompt"])
      })
      .strict()
      .optional()
  })
  .strict();

/**
 * The mirror projected back to JSON Schema, for comparison against the
 * published file.
 *
 * Exported so the parity test can compare the two without importing zod itself:
 * the check that keeps documentation and enforcement describing the same file
 * should not be the hardest thing in the suite to run.
 */
export function settingsSchemaAsJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(settingsSchema, { io: "input" }) as Record<string, unknown>;
}

export interface SettingsFinding {
  /** Dotted path to the offending value, or "" for the document itself. */
  readonly path: string;
  readonly message: string;
}

export interface SettingsParseResult {
  readonly ok: boolean;
  readonly findings: readonly SettingsFinding[];
}

/**
 * Validate a parsed settings document.
 *
 * Returns findings rather than throwing, because every one of them is a warning
 * at the call site: a settings file with a bad enum is a file to fix, not a
 * reason to refuse to report on the project it configures.
 */
export function parseSettings(value: unknown): SettingsParseResult {
  const result = settingsSchema.safeParse(value);
  if (result.success) return { ok: true, findings: [] };

  const findings = result.error.issues.map((issue) => {
    const path = issue.path.join(".");
    if (issue.code === "unrecognized_keys") {
      const keys = issue.keys.map((key) => (path.length === 0 ? key : `${path}.${key}`));
      return {
        path,
        message: `Unknown setting${keys.length === 1 ? "" : "s"}: ${keys.join(", ")}.`
      };
    }
    return { path, message: path.length === 0 ? issue.message : `${path}: ${issue.message}` };
  });
  return { ok: false, findings };
}
