export interface CommandHelpEntry {
  readonly name: string;
  readonly summary: string;
}

export const WORKFLOW_COMMANDS: readonly CommandHelpEntry[] = Object.freeze([
  { name: "start", summary: "Initialize a project and route to the first plan." },
  { name: "explore", summary: "Create a design discovery artifact before start or planning." },
  { name: "map", summary: "Generate, refresh, check, or query codebase context." },
  { name: "plan", summary: "Plan a phase or change into typed task contracts." },
  { name: "build", summary: "Execute approved task contracts through a runtime driver." },
  { name: "review", summary: "Review task outputs with verification and independent gates." },
  { name: "ship", summary: "Run release readiness, promotion, and observation gates." },
  { name: "retro", summary: "Record retrospective evidence for future planning." },
  { name: "status", summary: "Show workflow state and the next recommended action." },
  { name: "quick", summary: "Run one ad-hoc task with a task record and risk classification." },
  { name: "advise", summary: "Run read-only advisory analysis." },
  { name: "polish", summary: "Run scoped cleanup as an ad-hoc workflow." },
  { name: "learn", summary: "Record project-specific operational learning." },
  { name: "milestone", summary: "Manage milestone status, summaries, and archives." },
  { name: "validate", summary: "Validate committed Legion project state." },
  { name: "doctor", summary: "Validate project state plus shallow .legion/var and bundle-index path presence." },
  { name: "council", summary: "Run governance deliberation formerly exposed as /legion:board." }
]);

export const DEV_COMMANDS: readonly CommandHelpEntry[] = Object.freeze([
  { name: "project", summary: "Direct project artifact service operations." },
  { name: "change", summary: "Direct change bundle service operations." },
  { name: "board", summary: "Direct operational Kanban, event, claim, and approval operations." },
  { name: "migrate", summary: "Direct legacy import, apply, and rollback operations." },
  { name: "evals", summary: "Release-grade sealed workflow eval operations." },
  { name: "release", summary: "GA checklist and rollback-policy verifier operations." },
  { name: "worker", summary: "Validate and inspect worker bundles for extension authors." }
]);

export const WORKFLOW_COMMAND_NAMES = new Set(WORKFLOW_COMMANDS.map((entry) => entry.name));
export const DEV_COMMAND_NAMES = new Set(DEV_COMMANDS.map((entry) => entry.name));
