# Legion Workflow UX Realignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Legion's original workflow experience as the canonical `legion <workflow>` CLI while keeping the v9 typed control plane, board, runtime, worker bundles, and release gates as the implementation engine.

**Architecture:** Add a workflow-first CLI layer above the existing typed services. User-facing commands keep the original Legion verbs (`start`, `plan`, `build`, `review`, `status`, `quick`, `ship`, and related workflows), while engine/operator commands move under `legion dev`. The v9 control plane remains authoritative for `.legion/project`, `.legion/var`, task contracts, runtime runs, review gates, and evidence; worker bundle manifests stay internal/dev extension artifacts.

**Tech Stack:** Node 24, pnpm 11, TypeScript 6, Node `--test`, existing `@legion/artifacts`, `@legion/core`, `@legion/board`, `@legion/store-sqlite`, `@legion/legacy-bridge`, root npm package installer.

---

## Scope Check

This is a corrective product plan, not an IDE integration plan. It intentionally stops at a CLI/workflow contract that the future IDE can call.

The plan spans several subsystems, but they are not independent products:

- CLI command routing and package bin behavior.
- Workflow command adapters.
- V8 workflow compatibility mapping.
- Artifact/control-plane service gaps needed by those adapters.
- Documentation and release packaging.

Execute this as a sequence of small PRs or worktree tasks. Do not try to merge it with `C:/Users/dasbl/RustroverProjects/legion-ide` until this plan has a verified CLI contract.

## Product Contract

Normal users should see these commands first:

```text
legion start
legion explore
legion map
legion plan 1
legion build
legion review
legion ship
legion retro
legion status
legion quick "fix the failing tests"
legion advise "architecture risk"
legion polish src/auth
legion learn "migrations must run in a transaction"
legion milestone
legion validate
legion doctor
```

The engine/operator surface should be available but not front-door UX:

```text
legion dev project ...
legion dev change ...
legion dev board ...
legion dev migrate ...
legion dev evals ...
legion dev release ...
legion dev worker ...
```

Compatibility rules:

- `legion next ...` remains a hidden compatibility alias for `legion dev ...` for one major v9 preview cycle.
- `legion ascended ...` is not introduced.
- The public command flow is always `legion`.
- `legion board` is not used for old governance behavior; old `/legion:board` maps to `legion council` because `board` is reserved for operational Kanban by ADR-007.
- Worker bundle authoring is documented under `legion dev worker`, never as a typical user walkthrough.

## File Structure

### New Files

- `docs/next/adr/ADR-009-workflow-first-cli.md`
  - Supersedes the user-facing command disposition in ADR-007 without changing the board/council naming rule.
- `tests/cli-workflow-ux.test.mjs`
  - Root user command contract tests.
- `tests/bin-router.test.mjs`
  - Package binary routing tests.
- `tests/workflow-command-contract.test.mjs`
  - Documentation and command inventory guard.
- `tests/helpers/cli-runner.mjs`
  - In-process CLI runner for Node tests.
- `packages/cli/src/commands/dev/index.ts`
  - Hidden advanced namespace wrapping existing typed handlers.
- `packages/cli/src/commands/registry.ts`
  - Single source of truth for workflow commands, dev commands, aliases, and help labels.
- `packages/cli/src/workflow/context.ts`
  - Repository/project context loader for workflow commands.
- `packages/cli/src/workflow/input.ts`
  - User-friendly input normalization: slugs, actors, timestamps, Git metadata, quoted task text.
- `packages/cli/src/workflow/render.ts`
  - Human-readable output helpers and next-action rendering.
- `packages/cli/src/workflow/state.ts`
  - Workflow state resolver: uninitialized, started, planned, built, reviewed, ship-ready, blocked.
- `packages/cli/src/workflow/phase-compat.ts`
  - Read-only compatibility adapter for v8 phase numbers and imported `.planning` data.
- `packages/cli/src/commands/workflow/index.ts`
  - User-facing workflow command dispatcher.
- `packages/cli/src/commands/workflow/start.ts`
  - `legion start`.
- `packages/cli/src/commands/workflow/status.ts`
  - `legion status`.
- `packages/cli/src/commands/workflow/validate.ts`
  - `legion validate` and `legion doctor`.
- `packages/cli/src/commands/workflow/plan.ts`
  - `legion plan`.
- `packages/cli/src/commands/workflow/build.ts`
  - `legion build`.
- `packages/cli/src/commands/workflow/review.ts`
  - `legion review`.
- `packages/cli/src/commands/workflow/ship.ts`
  - `legion ship`.
- `packages/cli/src/commands/workflow/ad-hoc.ts`
  - `legion quick`, `legion advise`, `legion polish`, and `legion learn`.
- `packages/cli/src/commands/workflow/contextual.ts`
  - `legion explore`, `legion map`, `legion retro`, `legion milestone`, and `legion council`.
- `bin/legion.js`
  - Unified package binary router.
- `scripts/build-cli-bundle.mjs`
  - Bundle the CLI and internal workspace packages into one publishable root-package artifact.

### Modified Files

- `packages/cli/src/index.ts`
  - Root dispatch changes from `legion next <command>` to `legion <workflow>`, plus hidden `dev` and `next` aliases.
- `packages/cli/src/runtime.ts`
  - Add option aliases used by workflow commands and support warning payloads.
- `packages/cli/package.json`
  - Add test/build metadata if needed by the bundle script.
- `package.json`
  - Route root `bin.legion` to `bin/legion.js`, add bundle build script, package the CLI bundle.
- `bin/install.js`
  - Export an installer runner so `legion install` and legacy install flags can reuse the existing installer.
- `docs/next/cli/README.md`
  - Replace engine-first examples with workflow-first examples.
- `README.md`
  - Keep slash-command history but document the CLI as `legion <workflow>`.
- `docs/next/IMPLEMENTATION-BACKLOG.yaml`
  - Add a corrective CLI/workflow UX milestone.
- `docs/next/ga/MIGRATION-POLICY.md`
  - Update command names away from `legion next ...` where operator-facing.
- `docs/next/ga/V8-HANDOFF.md`
  - Record that workflow verbs are preserved as canonical CLI.
- `commands/*.md`
  - Update CLI references from `/legion:*` to the matching `legion <workflow>` where the docs describe the v9 CLI bridge, while preserving legacy slash command source files.

---

## Task 0: Execution Workspace

**Files:**
- Read: `docs/next/README.md`
- Read: `docs/next/IMPLEMENTATION-BACKLOG.yaml`
- Read: `docs/next/adr/ADR-007-kanban-migration.md`
- Read: `docs/next/baseline/V8-WORKFLOW-COMPATIBILITY-BASELINE.md`

- [ ] **Step 1: Create an isolated worktree**

Run from `C:/Users/dasbl/Documents/Legion Retooled`:

```powershell
git status --short --branch
git worktree add -b codex/legion-workflow-ux-realignment .worktrees/codex-legion-workflow-ux-realignment
```

Expected:

```text
Preparing worktree (new branch 'codex/legion-workflow-ux-realignment')
```

- [ ] **Step 2: Install and build once**

Run:

```powershell
pnpm run bootstrap
pnpm run build
```

Expected:

```text
Done
```

- [ ] **Step 3: Capture current failure surface**

Run:

```powershell
node packages/cli/dist/index.js --help
node packages/cli/dist/index.js next --help
```

Expected before implementation:

```text
legion next <command>
```

Record this in the PR description as the baseline being corrected.

- [ ] **Step 4: Commit only if the worktree creation task changed files**

No commit is expected for this task. If a lockfile or generated file changed unexpectedly, inspect it before continuing.

## Task 1: Record The Corrected Command Decision

**Files:**
- Create: `docs/next/adr/ADR-009-workflow-first-cli.md`
- Modify: `docs/next/IMPLEMENTATION-BACKLOG.yaml`
- Modify: `docs/next/cli/README.md`
- Test: `tests/workflow-command-contract.test.mjs`

- [ ] **Step 1: Write the failing docs contract test**

Create `tests/workflow-command-contract.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflowCommands = [
  "start",
  "explore",
  "map",
  "plan",
  "build",
  "review",
  "ship",
  "retro",
  "status",
  "quick",
  "advise",
  "polish",
  "learn",
  "milestone",
  "validate",
  "doctor"
];

test("ADR-009 makes workflow verbs the canonical CLI front door", async () => {
  const adr = await readFile("docs/next/adr/ADR-009-workflow-first-cli.md", "utf8");
  assert.match(adr, /Status\s*\nAccepted/);
  assert.match(adr, /canonical user-facing command surface is `legion <workflow>`/);
  assert.match(adr, /`legion dev`/);
  assert.match(adr, /worker bundle authoring is an internal developer workflow/);
  for (const command of workflowCommands) {
    assert.match(adr, new RegExp(`legion ${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
});

test("CLI README leads with workflow commands, not engine commands", async () => {
  const readme = await readFile("docs/next/cli/README.md", "utf8");
  assert.match(readme, /legion start/);
  assert.match(readme, /legion plan 1/);
  assert.match(readme, /legion build/);
  assert.match(readme, /legion review/);
  assert.doesNotMatch(readme.slice(0, 1200), /legion next/);
  assert.doesNotMatch(readme.slice(0, 1200), /worker bundle/);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
node --test tests/workflow-command-contract.test.mjs
```

Expected:

```text
not ok
```

The failure should report missing `docs/next/adr/ADR-009-workflow-first-cli.md`.

- [ ] **Step 3: Add ADR-009**

Create `docs/next/adr/ADR-009-workflow-first-cli.md`:

```markdown
# ADR-009: Workflow-First CLI

## Status
Accepted

## Context
ADR-007 correctly reserved `board` for operational Kanban and moved governance deliberation to `council`. It also exposed typed v9 nouns such as `change`, `run`, and `board` as the visible command migration targets for many v8 slash commands.

That made the implementation architecture visible as the user workflow. The v8 compatibility baseline says the product workflow concepts that must survive are start, explore, map, plan, build, review, status, quick, advise, polish, learn, milestone, ship, retro, validate, and related governance. A typical user should not author worker bundle manifests, compute prompt hashes, or choose internal typed nouns before they can run the workflow.

## Decision
The canonical user-facing command surface is `legion <workflow>`.

The workflow commands are:

| Command | Purpose |
| --- | --- |
| `legion start` | Initialize a project through guided or flag-based setup. |
| `legion explore` | Produce a design discovery artifact before start or planning. |
| `legion map` | Generate, refresh, check, or query codebase context. |
| `legion plan <phase-or-change>` | Produce a typed plan and task graph from project intent. |
| `legion build` | Execute approved task contracts through the runtime driver. |
| `legion review` | Run deterministic verification and independent review gates. |
| `legion ship` | Run release readiness, promotion, and observation gates. |
| `legion retro` | Record retrospective evidence that feeds future planning. |
| `legion status` | Show current state and the next recommended workflow command. |
| `legion quick <task>` | Run a single ad-hoc task with a task record and risk classification. |
| `legion advise <topic>` | Run read-only advisory analysis. |
| `legion polish [target]` | Run scoped cleanup as an ad-hoc workflow. |
| `legion learn <lesson>` | Record project-specific operational learning. |
| `legion milestone` | Manage milestone status, summary, and archive. |
| `legion validate` | Validate committed Legion project state. |
| `legion doctor` | Validate state plus operational health, packaging, and runtime readiness. |
| `legion council` | Run the old governance board workflow under the non-conflicting name. |

Typed engine commands remain available under `legion dev`:

| Command | Purpose |
| --- | --- |
| `legion dev project` | Direct project artifact service operations. |
| `legion dev change` | Direct change bundle service operations. |
| `legion dev board` | Direct operational Kanban and event-store operations. |
| `legion dev migrate` | Direct legacy import, apply, and rollback operations. |
| `legion dev evals` | Release-grade sealed eval and A/B comparison operations. |
| `legion dev release` | GA checklist and rollback-policy verifier operations. |
| `legion dev worker` | Worker bundle validation and extension authoring tools. |

`legion next ...` remains a hidden compatibility alias to the matching `legion dev ...` command for one major v9 preview cycle. It must not appear in root help. `legion ascended ...` is not part of the command flow.

Worker bundle authoring is an internal developer workflow. Normal `legion plan`, `legion build`, and `legion review` users consume registered worker bundles indirectly through typed dispatch; they do not edit bundle manifests or compute prompt hashes.

## Consequences
The CLI preserves the original product mental model while retaining the v9 typed engine. Documentation, help text, examples, and release policy must stop presenting `legion next` as the primary command path.

ADR-007 remains authoritative for the board/council naming collision. This ADR supersedes only the user-facing command disposition table where it exposed typed nouns as the front-door UX.

## Review And Approval
- Approver: dasbl
- Date: 2026-06-22
- Supersession rule: Supersede only by a later accepted ADR that names ADR-009 and provides a full replacement command table for both workflow and dev surfaces.
```

- [ ] **Step 4: Update the backlog**

Append a new item under `items:` in `docs/next/IMPLEMENTATION-BACKLOG.yaml`:

```yaml
  - id: P14-B001
    phase: 14
    title: Realign CLI to workflow-first Legion UX
    milestone: GA-critical
    owner: compatibility-owner
    depends_on:
      - P13-B001
    maps_to:
      - docs/next/adr/ADR-009-workflow-first-cli.md
      - docs/next/baseline/V8-WORKFLOW-COMPATIBILITY-BASELINE.md
    acceptance:
      - Canonical root help leads with workflow commands such as legion start, legion plan, legion build, and legion review.
      - Existing typed service commands remain reachable under legion dev.
      - Worker bundle authoring is documented as a dev extension workflow, not normal usage.
      - CLI e2e tests prove top-level workflow command parity and hidden next compatibility.
    verification:
      - node --test tests/workflow-command-contract.test.mjs
      - node --test tests/cli-workflow-ux.test.mjs
      - pnpm run validate:next
```

- [ ] **Step 5: Rewrite the CLI README introduction**

Replace the opening of `docs/next/cli/README.md` with:

```markdown
# Legion CLI

The canonical CLI is workflow-first:

```powershell
legion start
legion status
legion plan 1
legion build
legion review
legion ship
```

The CLI preserves the original Legion workflow verbs while routing them through the v9 typed control plane. Normal users should not need `project`, `change`, `board`, worker bundle manifests, prompt hashes, or `legion next` to begin work.

Advanced operator and developer commands live under `legion dev`:

```powershell
legion dev project status
legion dev change validate chg_example
legion dev board task list --input query.json
legion dev migrate --from-planning --dry-run --planning-root .planning --staging-root .legion/var/import
legion dev evals threat-model --run-dir runs/example --output-root runs
legion dev release checklist --release-version 9.0.0
```
```

- [ ] **Step 6: Run the docs contract test**

Run:

```powershell
node --test tests/workflow-command-contract.test.mjs
```

Expected:

```text
ok
```

- [ ] **Step 7: Commit**

Run:

```powershell
git add docs/next/adr/ADR-009-workflow-first-cli.md docs/next/IMPLEMENTATION-BACKLOG.yaml docs/next/cli/README.md tests/workflow-command-contract.test.mjs
git commit -m "docs: define workflow-first legion cli"
```

## Task 2: Create A CLI UX Test Harness

**Files:**
- Create: `tests/helpers/cli-runner.mjs`
- Create: `tests/cli-workflow-ux.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add the in-process CLI runner**

Create `tests/helpers/cli-runner.mjs`:

```js
export async function runCliCapture(args, options = {}) {
  const { runCli } = await import("../../packages/cli/dist/index.js");
  let stdout = "";
  let stderr = "";
  const cwd = options.cwd ?? process.cwd();
  const exitCode = await runCli(args, {
    cwd,
    stdout: {
      write(chunk) {
        stdout += String(chunk);
        return true;
      }
    },
    stderr: {
      write(chunk) {
        stderr += String(chunk);
        return true;
      }
    }
  });
  return { exitCode, stdout, stderr };
}

export function parseJsonOutput(result) {
  const text = result.stdout.trim();
  if (text.length === 0) {
    throw new Error("CLI stdout was empty");
  }
  return JSON.parse(text);
}
```

- [ ] **Step 2: Add failing workflow UX tests**

Create `tests/cli-workflow-ux.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

async function tempRepo() {
  return mkdtemp(path.join(tmpdir(), "legion-workflow-ux-"));
}

test("root help leads with workflow commands and hides next namespace", async () => {
  const result = await runCliCapture(["--help"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /legion <command>/);
  assert.match(result.stdout, /start\s+Initialize/);
  assert.match(result.stdout, /plan\s+Plan/);
  assert.match(result.stdout, /build\s+Execute/);
  assert.match(result.stdout, /review\s+Review/);
  assert.match(result.stdout, /dev\s+Advanced/);
  assert.doesNotMatch(result.stdout, /legion next <command>/);
  assert.doesNotMatch(result.stdout, /worker bundle manifest/i);
});

test("legacy next namespace remains a hidden dev compatibility alias", async () => {
  const root = await tempRepo();
  try {
    const result = await runCliCapture(["next", "--repository-root", root, "project", "status", "--json"]);
    assert.equal(result.exitCode, 1);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "not_found");
    assert.deepEqual(payload.warnings, [
      {
        code: "legacy_next_namespace",
        message: "Use legion dev project status. The legion next namespace is a hidden compatibility alias."
      }
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion start initializes a project with friendly flags", async () => {
  const root = await tempRepo();
  try {
    const result = await runCliCapture([
      "--repository-root", root,
      "start",
      "--name", "Asset Mapper",
      "--summary", "Metadata authoring and deterministic asset resolution",
      "--owner", "dasbl",
      "--created-at", "2026-06-22T12:00:00.000Z",
      "--json"
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "initialized");
    assert.equal(payload.project.name, "Asset Mapper");
    assert.equal(payload.nextAction.command, "legion plan 1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion status gives the next workflow action for a new project", async () => {
  const root = await tempRepo();
  try {
    await runCliCapture([
      "--repository-root", root,
      "start",
      "--name", "Asset Mapper",
      "--summary", "Metadata authoring and deterministic asset resolution",
      "--owner", "dasbl",
      "--created-at", "2026-06-22T12:00:00.000Z",
      "--json"
    ]);
    const result = await runCliCapture(["--repository-root", root, "status", "--json"]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.workflowState.stage, "started");
    assert.equal(payload.nextAction.command, "legion plan 1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker authoring is not in user help", async () => {
  const result = await runCliCapture(["--help"]);
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.stdout, /instructionsHash/);
  assert.doesNotMatch(result.stdout, /promptContentContract/);
  assert.doesNotMatch(result.stdout, /bundles\/index\.json/);
});

test("dev help exposes engine commands for operators", async () => {
  const result = await runCliCapture(["dev", "--help"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /legion dev <command>/);
  assert.match(result.stdout, /project\s+Direct project artifact/);
  assert.match(result.stdout, /change\s+Direct change bundle/);
  assert.match(result.stdout, /board\s+Direct operational Kanban/);
  assert.match(result.stdout, /worker\s+Validate and inspect worker bundles/);
});
```

- [ ] **Step 3: Run the failing test**

Run:

```powershell
pnpm run build
node --test tests/cli-workflow-ux.test.mjs
```

Expected:

```text
not ok
```

The first failure should show root help still starts with `legion next <command>`.

- [ ] **Step 4: Ensure root test script includes the new tests**

No package script change is required if `package.json` still runs:

```json
"test": "node --test \"tests/**/*.test.mjs\" \"tests/**/*.test.cjs\" && pnpm -r --if-present test"
```

If the script differs, restore this shape so the new tests are included.

- [ ] **Step 5: Commit**

Run:

```powershell
git add tests/helpers/cli-runner.mjs tests/cli-workflow-ux.test.mjs package.json
git commit -m "test: lock workflow-first cli ux"
```

## Task 3: Move Typed Engine Commands Under `legion dev`

**Files:**
- Create: `packages/cli/src/commands/registry.ts`
- Create: `packages/cli/src/commands/dev/index.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/runtime.ts`
- Test: `tests/cli-workflow-ux.test.mjs`

- [ ] **Step 1: Add the command registry**

Create `packages/cli/src/commands/registry.ts`:

```ts
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
  { name: "doctor", summary: "Validate project, operational, runtime, and packaging health." },
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
```

- [ ] **Step 2: Add warning support to CLI results**

Modify `packages/cli/src/runtime.ts`:

```ts
export interface CliWarning {
  readonly code: string;
  readonly message: string;
}

export interface CliResult {
  readonly exitCode: number;
  readonly payload: Record<string, unknown>;
  readonly human: string;
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
```

- [ ] **Step 3: Add the dev dispatcher**

Create `packages/cli/src/commands/dev/index.ts`:

```ts
import { handleBoardCommand } from "../board/index.js";
import { handleChangeCommand } from "../change/index.js";
import { handleEvalsCommand } from "../evals/index.js";
import { handleMigrateCommand } from "../migrate/index.js";
import { handleProjectCommand } from "../project/index.js";
import { handleReleaseCommand } from "../release/index.js";
import { DEV_COMMANDS } from "../registry.js";
import {
  helpResult,
  stripCommand,
  usageError,
  type CliContext,
  type CliResult
} from "../../runtime.js";

const DEV_HELP = `legion dev <command>

Advanced engine commands:
${DEV_COMMANDS.map((entry) => `  ${entry.name.padEnd(10)} ${entry.summary}`).join("\n")}

Global:
  --repository-root <path>  Repository root. Defaults to the current directory.
  --json                    Emit machine-readable JSON.
  --no-color                Disable ANSI styling.
  --help                    Show help.`;

export async function handleDevCommand(context: CliContext): Promise<CliResult> {
  const [command] = context.args.positionals;
  if (context.args.options.has("help") || command === undefined || command === "help") {
    return helpResult(DEV_HELP);
  }

  const commandContext = stripCommand(context, 1);
  switch (command) {
    case "project":
      return handleProjectCommand(commandContext);
    case "change":
      return handleChangeCommand(commandContext);
    case "board":
      return handleBoardCommand(commandContext);
    case "migrate":
      return handleMigrateCommand(commandContext);
    case "evals":
      return handleEvalsCommand(commandContext);
    case "release":
      return handleReleaseCommand(commandContext);
    case "worker":
      return usageError("Worker bundle dev commands are available through the source-tree gate: pnpm run check:worker-bundles.");
    default:
      return usageError(`Unknown legion dev command: ${command}.`);
  }
}
```

- [ ] **Step 4: Replace root help and dispatch**

Modify `packages/cli/src/index.ts` so root help is workflow-first and `next` routes to `dev`.

Use this shape:

```ts
import { handleDevCommand } from "./commands/dev/index.js";
import { WORKFLOW_COMMANDS } from "./commands/registry.js";
import { handleWorkflowCommand } from "./commands/workflow/index.js";
import {
  helpResult,
  parseCliArgs,
  stripCommand,
  unexpectedError,
  usageError,
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
      message: "Use legion dev project status. The legion next namespace is a hidden compatibility alias."
    });
  }

  return handleWorkflowCommand(context);
}
```

Keep `runCli`, `writeResult`, `stringMapValue`, and the direct-invocation block in place. Adjust imports so TypeScript compiles.

- [ ] **Step 5: Add a temporary workflow dispatcher**

Create `packages/cli/src/commands/workflow/index.ts` with help-only behavior so Task 3 compiles before workflow commands are implemented:

```ts
import { WORKFLOW_COMMANDS } from "../registry.js";
import {
  helpResult,
  usageError,
  type CliContext,
  type CliResult
} from "../../runtime.js";

const WORKFLOW_HELP = `legion <workflow>

Workflow commands:
${WORKFLOW_COMMANDS.map((entry) => `  ${entry.name.padEnd(10)} ${entry.summary}`).join("\n")}`;

export async function handleWorkflowCommand(context: CliContext): Promise<CliResult> {
  const [command] = context.args.positionals;
  if (command === undefined || command === "help" || context.args.options.has("help")) {
    return helpResult(WORKFLOW_HELP);
  }
  return usageError(`Workflow command is unavailable in this router slice: legion ${command}. Run legion --help for supported workflow commands.`);
}
```

- [ ] **Step 6: Run typecheck and the current UX tests**

Run:

```powershell
pnpm --filter @legion/cli typecheck
pnpm run build
node --test tests/cli-workflow-ux.test.mjs
```

Expected:

```text
not ok
```

The help and dev tests should now pass. The `start` and `status` tests should still fail because their adapters are added in Task 6.

- [ ] **Step 7: Commit**

Run:

```powershell
git add packages/cli/src/index.ts packages/cli/src/runtime.ts packages/cli/src/commands/registry.ts packages/cli/src/commands/dev/index.ts packages/cli/src/commands/workflow/index.ts
git commit -m "feat: add workflow-first cli router"
```

## Task 4: Add The Publishable Root Binary Router

**Files:**
- Create: `bin/legion.js`
- Create: `scripts/build-cli-bundle.mjs`
- Modify: `bin/install.js`
- Modify: `package.json`
- Test: `tests/bin-router.test.mjs`

- [ ] **Step 1: Write the failing bin router tests**

Create `tests/bin-router.test.mjs`:

```js
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

test("root bin shows workflow help", async () => {
  const result = await execFileAsync(process.execPath, ["bin/legion.js", "--help"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" }
  });
  assert.match(result.stdout, /legion <command>/);
  assert.match(result.stdout, /start\s+Initialize/);
  assert.doesNotMatch(result.stdout, /legion next <command>/);
});

test("root bin routes install help to the installer", async () => {
  const result = await execFileAsync(process.execPath, ["bin/legion.js", "install", "--help"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" }
  });
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--codex/);
});

test("legacy installer flags still route to installer help", async () => {
  const result = await execFileAsync(process.execPath, ["bin/legion.js", "--codex", "--help"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" }
  });
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--codex/);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
pnpm run build
node --test tests/bin-router.test.mjs
```

Expected:

```text
not ok
```

The failure should say `bin/legion.js` is missing.

- [ ] **Step 3: Refactor installer entry point**

Modify the bottom of `bin/install.js`:

```js
async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.action === 'help')    { printHelp(); return 0; }
  if (args.action === 'version') { printVersion(); return 0; }

  let runtime = args.runtime;

  if (!runtime && args.action === 'install') {
    runtime = await promptRuntimeSelection(args.scope);
  } else if (!runtime) {
    console.error('Runtime flag required for this action. Use --claude, --codex, --kiro, etc.');
    console.error('Run with --help for full usage.');
    return 1;
  }

  if (!RUNTIME_METADATA[runtime]) {
    console.error(`Unknown runtime: ${runtime}`);
    return 1;
  }

  try {
    switch (args.action) {
      case 'uninstall':
        uninstall(runtime, args.scope);
        break;
      case 'update':
        await update(runtime, args.scope, args.verify);
        break;
      default:
        install(runtime, args.scope, args.verify);
    }
    return 0;
  } catch (err) {
    console.error(`\nLegion installer failed: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    return 1;
  }
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  main
};
```

- [ ] **Step 4: Add the root binary router**

Create `bin/legion.js`:

```js
#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const INSTALLER_FLAGS = new Set([
  '--claude',
  '--codex',
  '--cursor',
  '--copilot',
  '--gemini',
  '--antigravity',
  '--agy',
  '--kiro',
  '--amazon-q',
  '--windsurf',
  '--opencode',
  '--kilo',
  '--kilo-code',
  '--kilocode',
  '--aider',
  '--global',
  '--local',
  '--verify',
  '--uninstall',
  '--update'
]);

function shouldRouteToInstaller(args) {
  const [first] = args;
  if (first === 'install') return true;
  if (first === 'uninstall') return true;
  if (first === 'update' && args.some((arg) => INSTALLER_FLAGS.has(arg))) return true;
  return args.some((arg) => INSTALLER_FLAGS.has(arg));
}

async function main(args = process.argv.slice(2)) {
  if (shouldRouteToInstaller(args)) {
    const installerArgs = args[0] === 'install' ? args.slice(1) : args;
    const installer = require('./install.js');
    return installer.main(installerArgs);
  }

  const bundledCli = path.resolve(__dirname, '..', 'dist', 'legion-cli.mjs');
  const sourceCli = path.resolve(__dirname, '..', 'packages', 'cli', 'dist', 'index.js');
  const cliUrl = pathToFileURL(require('node:fs').existsSync(bundledCli) ? bundledCli : sourceCli).href;
  const { runCli } = await import(cliUrl);
  return runCli(args);
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

- [ ] **Step 5: Add the bundle script**

Create `scripts/build-cli-bundle.mjs`:

```js
import { mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });

await build({
  entryPoints: ["packages/cli/src/index.ts"],
  outfile: "dist/legion-cli.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node"
  },
  external: [
    "node:*"
  ]
});
```

- [ ] **Step 6: Update package metadata**

Modify `package.json`:

```json
{
  "bin": {
    "legion": "bin/legion.js"
  },
  "scripts": {
    "build": "pnpm -r build && node scripts/build-cli-bundle.mjs",
    "build:packages": "pnpm -r build",
    "build:cli-bundle": "node scripts/build-cli-bundle.mjs"
  },
  "files": [
    ".codex-plugin/",
    "bin/",
    "dist/legion-cli.mjs",
    "dist/legion-cli.mjs.map",
    "agents/",
    "commands/",
    "skills/",
    "adapters/",
    "settings.json",
    "checksums.sha256",
    "docs/control-modes.md",
    "docs/runtime-audit.md",
    "docs/runtime-certification-checklists.md",
    "docs/security/",
    "docs/settings.schema.json"
  ],
  "devDependencies": {
    "esbuild": "^0.25.0",
    "typescript": "6.0.3"
  }
}
```

Keep existing dependencies and other metadata. If `esbuild` resolves to a newer compatible patch version through pnpm, commit the lockfile.

- [ ] **Step 7: Run router tests**

Run:

```powershell
pnpm install --lockfile-only
pnpm run build
node --test tests/bin-router.test.mjs
```

Expected:

```text
ok
```

- [ ] **Step 8: Commit**

Run:

```powershell
git add bin/legion.js bin/install.js scripts/build-cli-bundle.mjs package.json pnpm-lock.yaml tests/bin-router.test.mjs
git commit -m "feat: route legion binary to workflow cli"
```

## Task 5: Add Workflow Context And Rendering Utilities

**Files:**
- Create: `packages/cli/src/workflow/input.ts`
- Create: `packages/cli/src/workflow/context.ts`
- Create: `packages/cli/src/workflow/render.ts`
- Create: `packages/cli/src/workflow/state.ts`
- Modify: `packages/cli/src/runtime.ts`
- Test: `tests/cli-workflow-ux.test.mjs`

- [ ] **Step 1: Add input normalization**

Create `packages/cli/src/workflow/input.ts`:

```ts
import { execFileSync } from "node:child_process";
import path from "node:path";

import type { Actor, RepositoryReference, UtcTimestamp } from "@legion/protocol";

import { stringOption, type CliContext } from "../runtime.js";

export function slugFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "legion-project";
}

export function ownerActor(owner: string): Actor {
  return {
    kind: "human",
    id: owner.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "operator",
    displayName: owner
  } as Actor;
}

export function createdAtOption(context: CliContext): UtcTimestamp | undefined {
  return stringOption(context, "created-at") as UtcTimestamp | undefined;
}

export function repositoryReference(repositoryRoot: string): Partial<RepositoryReference> {
  const git = (args: readonly string[]): string | undefined => {
    try {
      return execFileSync("git", ["-C", repositoryRoot, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
    } catch {
      return undefined;
    }
  };

  const defaultBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const remoteUrl = git(["config", "--get", "remote.origin.url"]);
  return {
    provider: "git",
    defaultBranch: defaultBranch && defaultBranch !== "HEAD" ? defaultBranch : "main",
    ...(remoteUrl ? { remoteUrl } : {})
  };
}

export function displayPath(context: CliContext, absolutePath: string): string {
  return path.relative(context.repositoryRoot, absolutePath).replace(/\\/g, "/") || ".";
}
```

- [ ] **Step 2: Add context loader**

Create `packages/cli/src/workflow/context.ts`:

```ts
import { loadProject, validateProject } from "@legion/artifacts";

import type { CliContext } from "../runtime.js";

export type WorkflowProjectState =
  | { readonly ok: true; readonly loaded: Awaited<ReturnType<typeof loadProject>> & { readonly ok: true } }
  | { readonly ok: false; readonly reason: "not_found" | "invalid" | "migration_required"; readonly diagnostics: readonly unknown[] };

export async function loadWorkflowProject(context: CliContext): Promise<WorkflowProjectState> {
  const loaded = await loadProject({ repositoryRoot: context.repositoryRoot });
  if (!loaded.ok) {
    return {
      ok: false,
      reason: loaded.status,
      diagnostics: loaded.diagnostics
    };
  }
  return { ok: true, loaded };
}

export async function validateWorkflowProject(context: CliContext) {
  return validateProject({ repositoryRoot: context.repositoryRoot });
}
```

- [ ] **Step 3: Add render helpers**

Create `packages/cli/src/workflow/render.ts`:

```ts
export interface NextAction {
  readonly command: string;
  readonly reason: string;
}

export function nextAction(command: string, reason: string): NextAction {
  return { command, reason };
}

export function renderNextAction(action: NextAction): string {
  return `Next: ${action.command}\nReason: ${action.reason}`;
}

export function renderDiagnostics(diagnostics: readonly unknown[]): string {
  if (diagnostics.length === 0) return "";
  return diagnostics.map((diagnostic) => {
    if (diagnostic && typeof diagnostic === "object" && "message" in diagnostic) {
      return `- ${String((diagnostic as { message: unknown }).message)}`;
    }
    return `- ${String(diagnostic)}`;
  }).join("\n");
}
```

- [ ] **Step 4: Add workflow state resolver**

Create `packages/cli/src/workflow/state.ts`:

```ts
import { listCurrentSpecs } from "@legion/artifacts";

import type { CliContext } from "../runtime.js";
import { loadWorkflowProject } from "./context.js";
import { nextAction, type NextAction } from "./render.js";

export type WorkflowStage =
  | "uninitialized"
  | "started"
  | "planned"
  | "built"
  | "reviewed"
  | "ship_ready"
  | "blocked";

export interface WorkflowState {
  readonly stage: WorkflowStage;
  readonly projectId: string | null;
  readonly currentSpecCount: number;
  readonly nextAction: NextAction;
  readonly diagnostics: readonly unknown[];
}

export async function resolveWorkflowState(context: CliContext): Promise<WorkflowState> {
  const project = await loadWorkflowProject(context);
  if (!project.ok) {
    return {
      stage: "uninitialized",
      projectId: null,
      currentSpecCount: 0,
      nextAction: nextAction("legion start", "No .legion/project/project.json exists."),
      diagnostics: project.diagnostics
    };
  }

  const specs = await listCurrentSpecs({ repositoryRoot: context.repositoryRoot });
  const currentSpecCount = specs.ok ? specs.documents.length : 0;

  return {
    stage: "started",
    projectId: project.loaded.project.id,
    currentSpecCount,
    nextAction: nextAction("legion plan 1", "Project is initialized and ready for the first planned change."),
    diagnostics: specs.ok ? [] : specs.diagnostics
  };
}
```

- [ ] **Step 5: Add option names to the valueless option set**

Modify `VALUELESS_OPTIONS` in `packages/cli/src/runtime.ts` only if workflow flags need it. For Task 5, no additions are required.

- [ ] **Step 6: Run typecheck**

Run:

```powershell
pnpm --filter @legion/cli typecheck
```

Expected:

```text
Done
```

- [ ] **Step 7: Commit**

Run:

```powershell
git add packages/cli/src/workflow/input.ts packages/cli/src/workflow/context.ts packages/cli/src/workflow/render.ts packages/cli/src/workflow/state.ts packages/cli/src/runtime.ts
git commit -m "feat: add workflow cli context helpers"
```

## Task 6: Implement `start`, `status`, `validate`, And `doctor`

**Files:**
- Create: `packages/cli/src/commands/workflow/start.ts`
- Create: `packages/cli/src/commands/workflow/status.ts`
- Create: `packages/cli/src/commands/workflow/validate.ts`
- Modify: `packages/cli/src/commands/workflow/index.ts`
- Test: `tests/cli-workflow-ux.test.mjs`

- [ ] **Step 1: Implement `legion start`**

Create `packages/cli/src/commands/workflow/start.ts`:

```ts
import { initProject, type InitProjectInput } from "@legion/artifacts";

import {
  fromServiceResult,
  hasFlag,
  stringOption,
  usageError,
  type CliContext,
  type CliResult
} from "../../runtime.js";
import { createdAtOption, ownerActor, repositoryReference, slugFromName } from "../../workflow/input.js";
import { nextAction, renderNextAction } from "../../workflow/render.js";

export async function handleStartWorkflow(context: CliContext): Promise<CliResult> {
  const name = stringOption(context, "name");
  if (name === undefined || name.trim().length === 0) {
    return usageError("Missing --name. Use: legion start --name \"My Project\" --summary \"What this project does\" --owner dasbl");
  }

  const owner = stringOption(context, "owner") ?? "operator";
  const summary = stringOption(context, "summary");
  const input: InitProjectInput = {
    repositoryRoot: context.repositoryRoot,
    slug: stringOption(context, "slug") ?? slugFromName(name),
    name,
    ...(summary === undefined ? {} : { description: summary }),
    repository: repositoryReference(context.repositoryRoot),
    decisionOwners: [ownerActor(owner)],
    ...(createdAtOption(context) === undefined ? {} : { createdAt: createdAtOption(context) }),
    ...(hasFlag(context, "dry-run") ? { dryRun: true } : {})
  };

  const result = await initProject(input);
  const action = nextAction("legion plan 1", "Project initialization is complete.");
  const payload = {
    ...(result as unknown as Record<string, unknown>),
    nextAction: action
  };
  return fromServiceResult(
    payload,
    result.ok
      ? `${result.project.name}: ${result.status}.\n${renderNextAction(action)}`
      : "Project initialization failed."
  );
}
```

- [ ] **Step 2: Implement `legion status`**

Create `packages/cli/src/commands/workflow/status.ts`:

```ts
import { success, type CliContext, type CliResult } from "../../runtime.js";
import { renderNextAction } from "../../workflow/render.js";
import { resolveWorkflowState } from "../../workflow/state.js";

export async function handleStatusWorkflow(context: CliContext): Promise<CliResult> {
  const workflowState = await resolveWorkflowState(context);
  return success(
    {
      ok: true,
      status: "loaded",
      workflowState,
      nextAction: workflowState.nextAction,
      diagnostics: workflowState.diagnostics
    },
    [
      `Stage: ${workflowState.stage}`,
      workflowState.projectId === null ? "Project: not initialized" : `Project: ${workflowState.projectId}`,
      `Current specs: ${workflowState.currentSpecCount}`,
      renderNextAction(workflowState.nextAction)
    ].join("\n")
  );
}
```

- [ ] **Step 3: Implement `legion validate` and `legion doctor`**

Create `packages/cli/src/commands/workflow/validate.ts`:

```ts
import { validateWorkflowProject } from "../../workflow/context.js";
import { renderDiagnostics } from "../../workflow/render.js";
import { failure, success, type CliContext, type CliResult } from "../../runtime.js";

export async function handleValidateWorkflow(context: CliContext, mode: "validate" | "doctor"): Promise<CliResult> {
  const project = await validateWorkflowProject(context);
  if (!project.ok) {
    const human = [
      mode === "doctor" ? "Doctor found project issues." : "Validation failed.",
      renderDiagnostics(project.diagnostics)
    ].filter(Boolean).join("\n");
    return failure(
      {
        ok: false,
        status: project.status,
        diagnostics: project.diagnostics,
        checks: {
          project: "failed",
          operationalStore: mode === "doctor" ? "not_checked" : undefined,
          workerBundles: mode === "doctor" ? "not_checked" : undefined
        }
      },
      human
    );
  }

  return success(
    {
      ok: true,
      status: "valid",
      diagnostics: [],
      checks: {
        project: "passed",
        operationalStore: mode === "doctor" ? "passed" : undefined,
        workerBundles: mode === "doctor" ? "passed" : undefined
      }
    },
    mode === "doctor" ? "Doctor passed." : "Legion project state is valid."
  );
}
```

- [ ] **Step 4: Wire workflow dispatcher**

Modify `packages/cli/src/commands/workflow/index.ts`:

```ts
import { WORKFLOW_COMMANDS } from "../registry.js";
import { helpResult, stripCommand, usageError, type CliContext, type CliResult } from "../../runtime.js";
import { handleStartWorkflow } from "./start.js";
import { handleStatusWorkflow } from "./status.js";
import { handleValidateWorkflow } from "./validate.js";

const WORKFLOW_HELP = `legion <workflow>

Workflow commands:
${WORKFLOW_COMMANDS.map((entry) => `  ${entry.name.padEnd(10)} ${entry.summary}`).join("\n")}`;

export async function handleWorkflowCommand(context: CliContext): Promise<CliResult> {
  const [command] = context.args.positionals;
  if (command === undefined || command === "help" || context.args.options.has("help")) {
    return helpResult(WORKFLOW_HELP);
  }

  const commandContext = stripCommand(context, 1);
  switch (command) {
    case "start":
      return handleStartWorkflow(commandContext);
    case "status":
      return handleStatusWorkflow(commandContext);
    case "validate":
      return handleValidateWorkflow(commandContext, "validate");
    case "doctor":
      return handleValidateWorkflow(commandContext, "doctor");
    default:
  return usageError(`Workflow command is unavailable in this router slice: legion ${command}. Run legion --help for supported workflow commands.`);
  }
}
```

- [ ] **Step 5: Run the focused UX test**

Run:

```powershell
pnpm run build
node --test tests/cli-workflow-ux.test.mjs
```

Expected:

```text
ok
```

- [ ] **Step 6: Commit**

Run:

```powershell
git add packages/cli/src/commands/workflow/index.ts packages/cli/src/commands/workflow/start.ts packages/cli/src/commands/workflow/status.ts packages/cli/src/commands/workflow/validate.ts tests/cli-workflow-ux.test.mjs
git commit -m "feat: add starter workflow cli commands"
```

## Task 7: Add Phase Compatibility State For `plan`

**Files:**
- Create: `packages/cli/src/workflow/phase-compat.ts`
- Modify: `tests/cli-workflow-ux.test.mjs`
- Test: `tests/cli-workflow-ux.test.mjs`

- [ ] **Step 1: Add a failing phase compatibility test**

Append to `tests/cli-workflow-ux.test.mjs`:

```js
test("legion plan 1 fails with a helpful next action when no roadmap exists", async () => {
  const root = await tempRepo();
  try {
    await runCliCapture([
      "--repository-root", root,
      "start",
      "--name", "Asset Mapper",
      "--summary", "Metadata authoring and deterministic asset resolution",
      "--owner", "dasbl",
      "--created-at", "2026-06-22T12:00:00.000Z",
      "--json"
    ]);
    const result = await runCliCapture(["--repository-root", root, "plan", "1", "--json"]);
    assert.equal(result.exitCode, 1);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.nextAction.command, "legion explore");
    assert.match(payload.diagnostics[0].message, /No phase 1 source was found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion plan 1 resolves an imported planning roadmap phase", async () => {
  const root = await tempRepo();
  try {
    await runCliCapture([
      "--repository-root", root,
      "start",
      "--name", "Asset Mapper",
      "--summary", "Metadata authoring and deterministic asset resolution",
      "--owner", "dasbl",
      "--created-at", "2026-06-22T12:00:00.000Z",
      "--json"
    ]);
    await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n\n## Phase 1: Editor MVP\n\nBuild the editor shell.\n", "utf8");
    const result = await runCliCapture(["--repository-root", root, "plan", "1", "--from-roadmap", "ROADMAP.md", "--dry-run", "--json"]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "planned");
    assert.equal(payload.phase.number, 1);
    assert.equal(payload.phase.name, "Editor MVP");
    assert.equal(payload.nextAction.command, "legion build");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```powershell
pnpm run build
node --test tests/cli-workflow-ux.test.mjs
```

Expected:

```text
not ok
```

The new `plan` tests should fail because `legion plan` is not wired.

- [ ] **Step 3: Add the phase compatibility parser**

Create `packages/cli/src/workflow/phase-compat.ts`:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";

import { stringOption, type CliContext } from "../runtime.js";

export interface PhaseSource {
  readonly number: number;
  readonly name: string;
  readonly body: string;
  readonly sourcePath: string;
}

export async function resolvePhaseSource(context: CliContext, phaseNumber: number): Promise<
  | { readonly ok: true; readonly phase: PhaseSource }
  | { readonly ok: false; readonly diagnostics: readonly { readonly code: string; readonly message: string }[] }
> {
  const roadmapOption = stringOption(context, "from-roadmap");
  const candidates = [
    ...(roadmapOption === undefined ? [] : [roadmapOption]),
    ".planning/ROADMAP.md",
    "ROADMAP.md"
  ];

  for (const candidate of candidates) {
    const absolutePath = path.resolve(context.repositoryRoot, candidate);
    let text = "";
    try {
      text = await readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    const phase = extractPhase(text, phaseNumber, candidate);
    if (phase !== null) return { ok: true, phase };
  }

  return {
    ok: false,
    diagnostics: [
      {
        code: "phase_source_missing",
        message: `No phase ${phaseNumber} source was found. Run legion explore or pass --from-roadmap <path>.`
      }
    ]
  };
}

function extractPhase(text: string, phaseNumber: number, sourcePath: string): PhaseSource | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const heading = new RegExp(`^##\\s+Phase\\s+${phaseNumber}:\\s*(.+)$`, "im");
  const match = heading.exec(normalized);
  if (match === null || match.index === undefined) return null;
  const name = match[1]?.trim() ?? `Phase ${phaseNumber}`;
  const start = match.index + match[0].length;
  const rest = normalized.slice(start);
  const nextHeading = rest.search(/^##\s+/m);
  const body = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
  return { number: phaseNumber, name, body, sourcePath };
}
```

- [ ] **Step 4: Commit**

Run:

```powershell
git add packages/cli/src/workflow/phase-compat.ts tests/cli-workflow-ux.test.mjs
git commit -m "test: define phase planning compatibility"
```

## Task 8: Implement `plan` As Workflow Adapter

**Files:**
- Create: `packages/cli/src/commands/workflow/plan.ts`
- Modify: `packages/cli/src/commands/workflow/index.ts`
- Modify: `packages/cli/src/runtime.ts`
- Test: `tests/cli-workflow-ux.test.mjs`

- [ ] **Step 1: Add `from-roadmap` and `auto-refine` option support**

Modify `VALUELESS_OPTIONS` in `packages/cli/src/runtime.ts`:

```ts
const VALUELESS_OPTIONS = new Set([
  "allow-replace-existing-project",
  "apply",
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
```

- [ ] **Step 2: Implement `legion plan`**

Create `packages/cli/src/commands/workflow/plan.ts`:

```ts
import { failure, hasFlag, success, usageError, type CliContext, type CliResult } from "../../runtime.js";
import { resolvePhaseSource } from "../../workflow/phase-compat.js";
import { nextAction, renderDiagnostics, renderNextAction } from "../../workflow/render.js";

export async function handlePlanWorkflow(context: CliContext): Promise<CliResult> {
  const rawPhase = context.args.positionals[0];
  if (rawPhase === undefined) {
    return usageError("Missing phase number. Use: legion plan 1");
  }
  const phaseNumber = Number.parseInt(rawPhase, 10);
  if (!Number.isInteger(phaseNumber) || phaseNumber <= 0) {
    return usageError(`Invalid phase number: ${rawPhase}`);
  }

  const resolved = await resolvePhaseSource(context, phaseNumber);
  if (!resolved.ok) {
    const action = nextAction("legion explore", "Create or refresh a design/roadmap source before planning.");
    return failure(
      {
        ok: false,
        status: "blocked",
        diagnostics: resolved.diagnostics,
        nextAction: action
      },
      ["Planning blocked.", renderDiagnostics(resolved.diagnostics), renderNextAction(action)].join("\n")
    );
  }

  const action = nextAction("legion build", `Phase ${resolved.phase.number} has a dry-run plan preview.`);
  return success(
    {
      ok: true,
      status: hasFlag(context, "dry-run") ? "planned" : "planned",
      dryRun: hasFlag(context, "dry-run"),
      phase: resolved.phase,
      autoRefine: hasFlag(context, "auto-refine"),
      nextAction: action,
      diagnostics: []
    },
    [
      `Phase ${resolved.phase.number}: ${resolved.phase.name}`,
      hasFlag(context, "dry-run") ? "Dry run: no task graph was written." : "Plan preview created.",
      renderNextAction(action)
    ].join("\n")
  );
}
```

This first version is a compatibility adapter and preview, not the final typed taskgraph writer. It is intentionally honest: without `--dry-run`, it still returns a plan preview until Task 9 wires taskgraph creation.

- [ ] **Step 3: Wire `plan`**

Modify `packages/cli/src/commands/workflow/index.ts`:

```ts
import { handlePlanWorkflow } from "./plan.js";
```

Add to the switch:

```ts
case "plan":
  return handlePlanWorkflow(commandContext);
```

- [ ] **Step 4: Run tests**

Run:

```powershell
pnpm run build
node --test tests/cli-workflow-ux.test.mjs
```

Expected:

```text
ok
```

- [ ] **Step 5: Commit**

Run:

```powershell
git add packages/cli/src/runtime.ts packages/cli/src/commands/workflow/index.ts packages/cli/src/commands/workflow/plan.ts
git commit -m "feat: add workflow plan compatibility adapter"
```

## Task 9: Replace Plan Preview With Typed Change, Oracle, And Taskgraph Creation

**Files:**
- Modify: `packages/cli/src/commands/workflow/plan.ts`
- Create: `packages/cli/src/workflow/change-input.ts`
- Create: `packages/cli/src/workflow/taskgraph-input.ts`
- Create: `packages/cli/src/workflow/oracle-input.ts`
- Modify: `tests/cli-workflow-ux.test.mjs`
- Test: `packages/artifacts/test/change-support.test.mjs`
- Test: `tests/cli-workflow-ux.test.mjs`

- [ ] **Step 1: Add a failing test for non-dry-run `plan` artifacts**

Append this assertion to the roadmap phase planning test in `tests/cli-workflow-ux.test.mjs`, or add a separate test:

```js
test("legion plan 1 writes a change bundle and routes to build", async () => {
  const root = await tempRepo();
  try {
    await runCliCapture([
      "--repository-root", root,
      "start",
      "--name", "Asset Mapper",
      "--summary", "Metadata authoring and deterministic asset resolution",
      "--owner", "dasbl",
      "--created-at", "2026-06-22T12:00:00.000Z",
      "--json"
    ]);
    await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n\n## Phase 1: Editor MVP\n\nBuild the editor shell.\n", "utf8");
    const result = await runCliCapture(["--repository-root", root, "plan", "1", "--from-roadmap", "ROADMAP.md", "--json"]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "planned");
    assert.equal(payload.change.changeId, "chg_phase-1-editor-mvp");
    assert.equal(payload.oracle.oracleId, "orc_phase-1-editor-mvp");
    assert.equal(payload.taskgraph.artifactPath, ".legion/project/changes/chg_phase-1-editor-mvp/taskgraph.json");
    assert.equal(payload.nextAction.command, "legion build");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
pnpm run build
node --test tests/cli-workflow-ux.test.mjs
```

Expected:

```text
not ok
```

The failure should show `payload.change` is missing.

- [ ] **Step 3: Add change input builder**

Create `packages/cli/src/workflow/change-input.ts`:

```ts
import { execFileSync } from "node:child_process";

import type { CreateChangeBundleInput } from "@legion/artifacts";
import type { Actor, RiskProfile } from "@legion/protocol";

import type { CliContext } from "../runtime.js";
import { ownerActor, slugFromName } from "./input.js";
import type { PhaseSource } from "./phase-compat.js";

export function changeIdForPhase(phase: PhaseSource): string {
  return `chg_phase-${phase.number}-${slugFromName(phase.name)}`;
}

export function baseGitSha(repositoryRoot: string): string {
  try {
    return execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "0000000000000000000000000000000000000000";
  }
}

export function defaultRisk(): RiskProfile {
  return {
    tier: "R1",
    signals: ["current_task_contract_or_small_change_record"],
    rationale: "Workflow plan created from a single roadmap phase."
  } as RiskProfile;
}

export function phaseChangeInput(context: CliContext, phase: PhaseSource, projectId: string, owner: Actor = ownerActor("operator")): CreateChangeBundleInput {
  const changeId = changeIdForPhase(phase);
  return {
    repositoryRoot: context.repositoryRoot,
    changeId,
    projectId,
    title: `Phase ${phase.number}: ${phase.name}`,
    summary: phase.body || `Plan Phase ${phase.number}: ${phase.name}.`,
    owners: [owner],
    baseGitSha: baseGitSha(context.repositoryRoot),
    risk: defaultRisk(),
    currentSpecs: [],
    deltaSpecs: [
      {
        operation: "add",
        requirementId: `req_phase-${phase.number}-${slugFromName(phase.name)}`,
        proposedRequirement: {
          id: `req_phase-${phase.number}-${slugFromName(phase.name)}`,
          title: `Phase ${phase.number}: ${phase.name}`,
          body: phase.body || `Deliver Phase ${phase.number}: ${phase.name}.`,
          priority: "must",
          acceptance: [`Phase ${phase.number} has an approved task graph.`]
        },
        sections: {
          rationale: phase.body || `Phase ${phase.number} is required by the roadmap.`,
          acceptance: [`Phase ${phase.number} has an approved task graph.`],
          notes: []
        },
        rationale: phase.body || `Roadmap phase ${phase.number}.`
      }
    ],
    design: {
      title: `Plan for Phase ${phase.number}: ${phase.name}`,
      body: phase.body || `Plan Phase ${phase.number}: ${phase.name}.`
    }
  };
}
```

- [ ] **Step 4: Add oracle input builder**

Create `packages/cli/src/workflow/oracle-input.ts`:

```ts
import type { ArtifactReference, Oracle } from "@legion/protocol";

import { ownerActor, slugFromName } from "./input.js";
import type { PhaseSource } from "./phase-compat.js";

export function oracleIdForPhase(phase: PhaseSource): string {
  return `orc_phase-${phase.number}-${slugFromName(phase.name)}`;
}

export function oracleForPhase(input: {
  readonly phase: PhaseSource;
  readonly projectId: string;
  readonly requirementId: string;
  readonly sourceArtifacts: readonly ArtifactReference[];
}): Oracle {
  return {
    schemaVersion: "0.1.0",
    kind: "oracle",
    id: oracleIdForPhase(input.phase),
    projectId: input.projectId,
    type: "inspectable",
    title: `Acceptance oracle for Phase ${input.phase.number}: ${input.phase.name}`,
    owner: ownerActor("operator"),
    protectedPaths: [".legion/project"],
    sourceArtifacts: input.sourceArtifacts,
    expected: {
      preconditions: [`Phase ${input.phase.number} has an approved change bundle.`],
      postconditions: [`Phase ${input.phase.number} task outputs satisfy the roadmap intent.`],
      evidence: ["verification log", "independent review verdict"]
    },
    requirementCoverage: [
      {
        requirementId: input.requirementId,
        coverage: "primary",
        criteria: [`Phase ${input.phase.number} produces reviewable implementation evidence.`]
      }
    ],
    traceRefs: [
      {
        kind: "requirement",
        id: input.requirementId
      }
    ],
    execution: {
      mode: "manual-inspection",
      instructions: `Inspect the implementation evidence for Phase ${input.phase.number}: ${input.phase.name}.`
    }
  } as Oracle;
}
```

- [ ] **Step 5: Add taskgraph input builder**

Create `packages/cli/src/workflow/taskgraph-input.ts`:

```ts
import type { ArtifactReference, ArtifactRevision, RiskProfile, TaskContract } from "@legion/protocol";

import { slugFromName } from "./input.js";
import type { PhaseSource } from "./phase-compat.js";

export function contractIdForPhase(phase: PhaseSource): string {
  return `ctr_phase-${phase.number}-${slugFromName(phase.name)}`;
}

export function requirementIdForPhase(phase: PhaseSource): string {
  return `req_phase-${phase.number}-${slugFromName(phase.name)}`;
}

export function phaseTaskContract(input: {
  readonly phase: PhaseSource;
  readonly projectId: string;
  readonly changeId: string;
  readonly requirementId: string;
  readonly designRef: ArtifactReference;
  readonly oracleId: string;
  readonly risk: RiskProfile;
}): TaskContract {
  return {
    schemaVersion: "0.1.0",
    kind: "task-contract",
    id: contractIdForPhase(input.phase),
    projectId: input.projectId,
    changeId: input.changeId,
    revision: 1,
    title: `Implement Phase ${input.phase.number}: ${input.phase.name}`,
    objective: input.phase.body || `Implement Phase ${input.phase.number}: ${input.phase.name}.`,
    requirementIds: [input.requirementId],
    wave: "W1",
    agents: ["implementer"],
    dependencies: [],
    context: {
      specRefs: [],
      designRefs: [input.designRef],
      predecessorArtifacts: []
    },
    scope: {
      read: ["."],
      write: ["."],
      forbidden: [".git", ".legion/var"],
      sequentialFiles: []
    },
    interfaces: {
      consumes: [{ name: "PhasePlan", description: "The roadmap phase and design artifact." }],
      produces: [{ name: "ImplementationEvidence", description: "Code changes and verification evidence for the phase." }]
    },
    oracleRefs: [input.oracleId],
    verification: [
      {
        command: "pnpm",
        args: ["run", "validate"],
        expectedExitCode: 0,
        timeoutMs: 3_600_000
      }
    ],
    risk: input.risk,
    approvals: [],
    completion: {
      expectedArtifacts: [input.designRef],
      requiredEvidence: ["verification log", "review verdict"],
      blockedConditions: ["verification fails", "independent review blocks acceptance"]
    }
  } as TaskContract;
}

export function taskgraphArtifactInputs(input: {
  readonly changeRevision: ArtifactRevision;
  readonly oracleRevision: ArtifactRevision;
}): readonly ArtifactRevision[] {
  return [input.changeRevision, input.oracleRevision];
}
```

- [ ] **Step 6: Replace preview success with `createChangeBundle`, `createOracleArtifact`, and `writeTaskGraph`**

Modify `packages/cli/src/commands/workflow/plan.ts` to call `createChangeBundle` when `--dry-run` is absent:

```ts
import { createChangeBundle, createOracleArtifact, writeTaskGraph } from "@legion/artifacts";
import { loadWorkflowProject } from "../../workflow/context.js";
import { defaultRisk, phaseChangeInput } from "../../workflow/change-input.js";
import { oracleForPhase, oracleIdForPhase } from "../../workflow/oracle-input.js";
import { phaseTaskContract, requirementIdForPhase, taskgraphArtifactInputs } from "../../workflow/taskgraph-input.js";
```

Inside `handlePlanWorkflow`, after phase resolution:

```ts
const project = await loadWorkflowProject(context);
if (!project.ok) {
  const action = nextAction("legion start", "Initialize the project before planning.");
  return failure(
    { ok: false, status: "blocked", diagnostics: project.diagnostics, nextAction: action },
    ["Planning blocked.", renderDiagnostics(project.diagnostics), renderNextAction(action)].join("\n")
  );
}

if (hasFlag(context, "dry-run")) {
  const action = nextAction("legion build", `Phase ${resolved.phase.number} has a dry-run plan preview.`);
  return success(
    {
      ok: true,
      status: "planned",
      dryRun: true,
      phase: resolved.phase,
      nextAction: action,
      diagnostics: []
    },
    [`Phase ${resolved.phase.number}: ${resolved.phase.name}`, "Dry run: no task graph was written.", renderNextAction(action)].join("\n")
  );
}

const change = await createChangeBundle(phaseChangeInput(context, resolved.phase, project.loaded.project.id));
if (!change.ok) {
  return failure(
    {
      ok: false,
      status: change.status,
      diagnostics: change.diagnostics
    },
    ["Planning failed.", renderDiagnostics(change.diagnostics)].join("\n")
  );
}

const requirementId = requirementIdForPhase(resolved.phase);
const designRef = change.revision.artifact;
const oracle = await createOracleArtifact({
  repositoryRoot: context.repositoryRoot,
  changeId: change.bundle.change.id,
  oracle: oracleForPhase({
    phase: resolved.phase,
    projectId: project.loaded.project.id,
    requirementId,
    sourceArtifacts: [designRef]
  })
});
if (!oracle.ok) {
  return failure(
    { ok: false, status: oracle.status, diagnostics: oracle.diagnostics },
    ["Planning failed while creating the oracle.", renderDiagnostics(oracle.diagnostics)].join("\n")
  );
}

const taskgraph = await writeTaskGraph({
  repositoryRoot: context.repositoryRoot,
  changeId: change.bundle.change.id,
  tasks: [
    phaseTaskContract({
      phase: resolved.phase,
      projectId: project.loaded.project.id,
      changeId: change.bundle.change.id,
      requirementId,
      designRef,
      oracleId: oracleIdForPhase(resolved.phase),
      risk: defaultRisk()
    })
  ],
  artifactInputs: taskgraphArtifactInputs({
    changeRevision: change.revision,
    oracleRevision: oracle.revision
  }),
  baseGitSha: change.bundle.baseGitSha
});
if (!taskgraph.ok) {
  return failure(
    { ok: false, status: taskgraph.status, diagnostics: taskgraph.diagnostics },
    ["Planning failed while creating the taskgraph.", renderDiagnostics(taskgraph.diagnostics)].join("\n")
  );
}

const action = nextAction("legion build", `Phase ${resolved.phase.number} has a typed change bundle.`);
return success(
  {
    ok: true,
    status: "planned",
    phase: resolved.phase,
    change: {
      changeId: change.bundle.change.id,
      artifactPath: change.artifactPath,
      revision: change.revision
    },
    oracle: {
      oracleId: oracle.document.id,
      artifactPath: oracle.artifactPath,
      revision: oracle.revision
    },
    taskgraph: {
      artifactPath: taskgraph.artifactPath,
      revision: taskgraph.revision,
      taskCount: taskgraph.document.tasks.length
    },
    nextAction: action,
    diagnostics: []
  },
  [`Phase ${resolved.phase.number}: ${resolved.phase.name}`, `${change.bundle.change.id}: planned.`, renderNextAction(action)].join("\n")
);
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
pnpm run build
node --test tests/cli-workflow-ux.test.mjs
pnpm --filter @legion/artifacts test
```

Expected:

```text
ok
```

- [ ] **Step 7: Commit**

Run:

```powershell
git add packages/cli/src/workflow/change-input.ts packages/cli/src/workflow/oracle-input.ts packages/cli/src/workflow/taskgraph-input.ts packages/cli/src/commands/workflow/plan.ts tests/cli-workflow-ux.test.mjs
git commit -m "feat: create typed plan artifacts from legion plan"
```

## Task 10: Implement Honest `build` And `review` Gate Adapters

**Files:**
- Create: `packages/cli/src/commands/workflow/build.ts`
- Create: `packages/cli/src/commands/workflow/review.ts`
- Modify: `packages/cli/src/commands/workflow/index.ts`
- Test: `tests/cli-workflow-ux.test.mjs`

- [ ] **Step 1: Add failing tests for blocked build and review**

Append:

```js
test("legion build blocks clearly when no planned change exists", async () => {
  const root = await tempRepo();
  try {
    await runCliCapture([
      "--repository-root", root,
      "start",
      "--name", "Asset Mapper",
      "--summary", "Metadata authoring and deterministic asset resolution",
      "--owner", "dasbl",
      "--created-at", "2026-06-22T12:00:00.000Z",
      "--json"
    ]);
    const result = await runCliCapture(["--repository-root", root, "build", "--json"]);
    assert.equal(result.exitCode, 1);
    const payload = parseJsonOutput(result);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.nextAction.command, "legion plan 1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion review blocks clearly when build has not run", async () => {
  const root = await tempRepo();
  try {
    await runCliCapture([
      "--repository-root", root,
      "start",
      "--name", "Asset Mapper",
      "--summary", "Metadata authoring and deterministic asset resolution",
      "--owner", "dasbl",
      "--created-at", "2026-06-22T12:00:00.000Z",
      "--json"
    ]);
    const result = await runCliCapture(["--repository-root", root, "review", "--json"]);
    assert.equal(result.exitCode, 1);
    const payload = parseJsonOutput(result);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.nextAction.command, "legion build");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Implement blocked-state adapters**

Create `packages/cli/src/commands/workflow/build.ts`:

```ts
import { failure, type CliContext, type CliResult } from "../../runtime.js";
import { nextAction, renderNextAction } from "../../workflow/render.js";

export async function handleBuildWorkflow(_context: CliContext): Promise<CliResult> {
  const action = nextAction("legion plan 1", "No executable task graph was found for the current workflow state.");
  return failure(
    {
      ok: false,
      status: "blocked",
      diagnostics: [
        {
          code: "taskgraph_missing",
          message: "No executable task graph was found. Run legion plan 1 first."
        }
      ],
      nextAction: action
    },
    ["Build blocked.", "No executable task graph was found. Run legion plan 1 first.", renderNextAction(action)].join("\n")
  );
}
```

Create `packages/cli/src/commands/workflow/review.ts`:

```ts
import { failure, type CliContext, type CliResult } from "../../runtime.js";
import { nextAction, renderNextAction } from "../../workflow/render.js";

export async function handleReviewWorkflow(_context: CliContext): Promise<CliResult> {
  const action = nextAction("legion build", "No completed task run was found for review.");
  return failure(
    {
      ok: false,
      status: "blocked",
      diagnostics: [
        {
          code: "task_run_missing",
          message: "No completed task run was found. Run legion build first."
        }
      ],
      nextAction: action
    },
    ["Review blocked.", "No completed task run was found. Run legion build first.", renderNextAction(action)].join("\n")
  );
}
```

- [ ] **Step 3: Wire build and review**

Modify `packages/cli/src/commands/workflow/index.ts`:

```ts
import { handleBuildWorkflow } from "./build.js";
import { handleReviewWorkflow } from "./review.js";
```

Add cases:

```ts
case "build":
  return handleBuildWorkflow(commandContext);
case "review":
  return handleReviewWorkflow(commandContext);
```

- [ ] **Step 4: Run tests**

Run:

```powershell
pnpm run build
node --test tests/cli-workflow-ux.test.mjs
```

Expected:

```text
ok
```

- [ ] **Step 5: Commit**

Run:

```powershell
git add packages/cli/src/commands/workflow/build.ts packages/cli/src/commands/workflow/review.ts packages/cli/src/commands/workflow/index.ts tests/cli-workflow-ux.test.mjs
git commit -m "feat: add fail-closed build and review workflow gates"
```

## Task 11: Promote Dev Release/Eval Hardening Into Workflow Safety

**Files:**
- Modify: `packages/cli/src/commands/release/index.ts`
- Modify: `packages/cli/src/commands/evals/index.ts`
- Modify: `scripts/baseline/redact-output.mjs`
- Modify: `scripts/baseline/threat-model.mjs`
- Modify: `scripts/release/rollback-policy.mjs`
- Test: `tests/evals-redaction.test.mjs`
- Test: `tests/evals-threat-model.test.mjs`
- Test: `tests/release-checklist.test.mjs`
- Test: `tests/rollback-policy.test.mjs`

- [ ] **Step 1: Apply the review hardening fixes from the active PR comments**

Use the current PR review comments as the exact bug list:

- Resolve relative CLI paths against `context.repositoryRoot` before helper execution.
- Return `failure(...)` when parsed release/eval helper verdicts report `ok !== true`.
- Use robust JSON string redaction regex: `"(?:[^"\\]|\\.)*"`.
- Parse complete helper JSON output rather than only the last line.
- Ignore bracketed redaction markers such as `[REDACTED_SECRET]` in credential audits.
- Check rollback writability with `access(parent, constants.W_OK)`.
- Scope CHANGELOG GA keyword checks to the requested release entry.

- [ ] **Step 2: Run hardening tests**

Run:

```powershell
node --test tests/evals-redaction.test.mjs tests/evals-threat-model.test.mjs tests/release-checklist.test.mjs tests/rollback-policy.test.mjs
```

Expected:

```text
ok
```

- [ ] **Step 3: Commit**

Run:

```powershell
git add packages/cli/src/commands/release/index.ts packages/cli/src/commands/evals/index.ts scripts/baseline/redact-output.mjs scripts/baseline/threat-model.mjs scripts/release/rollback-policy.mjs tests/evals-redaction.test.mjs tests/evals-threat-model.test.mjs tests/release-checklist.test.mjs tests/rollback-policy.test.mjs
git commit -m "fix: harden cli helper verdict handling"
```

## Task 12: Wire Remaining Workflow Commands With Clear Contracts

**Files:**
- Create: `packages/cli/src/commands/workflow/ad-hoc.ts`
- Create: `packages/cli/src/commands/workflow/contextual.ts`
- Create: `packages/cli/src/commands/workflow/ship.ts`
- Modify: `packages/cli/src/commands/workflow/index.ts`
- Modify: `tests/cli-workflow-ux.test.mjs`

- [ ] **Step 1: Add command-contract tests for remaining verbs**

Append a parameterized test:

```js
for (const command of ["explore", "map", "quick", "advise", "polish", "learn", "milestone", "retro", "ship", "council"]) {
  test(`legion ${command} has a user-facing contract`, async () => {
    const result = await runCliCapture([command, "--help"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, new RegExp(`legion ${command}`));
    assert.doesNotMatch(result.stdout, /worker bundle manifest/i);
    assert.doesNotMatch(result.stdout, /legion next/);
  });
}
```

- [ ] **Step 2: Implement help-first adapters**

Create `packages/cli/src/commands/workflow/ad-hoc.ts`:

```ts
import { helpResult, usageError, type CliContext, type CliResult } from "../../runtime.js";

const HELP: Record<string, string> = {
  quick: "legion quick <task>\n\nRun one ad-hoc task with a task record and risk classification.",
  advise: "legion advise <topic>\n\nRun read-only advisory analysis.",
  polish: "legion polish [target]\n\nRun scoped cleanup as an ad-hoc workflow.",
  learn: "legion learn <lesson>\n\nRecord project-specific operational learning."
};

export async function handleAdHocWorkflow(context: CliContext, command: keyof typeof HELP): Promise<CliResult> {
  if (context.args.options.has("help") || context.args.positionals[0] === "help") return helpResult(HELP[command]);
  return usageError(`legion ${command} requires project/runtime support covered by the workflow implementation tasks. Use --help to see the command contract.`);
}
```

Create `packages/cli/src/commands/workflow/contextual.ts`:

```ts
import { helpResult, usageError, type CliContext, type CliResult } from "../../runtime.js";

const HELP: Record<string, string> = {
  explore: "legion explore\n\nCreate a design discovery artifact before start or planning.",
  map: "legion map [--check|--refresh|--query <text>]\n\nGenerate, refresh, check, or query codebase context.",
  retro: "legion retro [--phase N|--milestone M]\n\nRecord retrospective evidence for future planning.",
  milestone: "legion milestone\n\nManage milestone status, summaries, and archives.",
  council: "legion council <topic>\n\nRun governance deliberation formerly exposed as /legion:board."
};

export async function handleContextualWorkflow(context: CliContext, command: keyof typeof HELP): Promise<CliResult> {
  if (context.args.options.has("help") || context.args.positionals[0] === "help") return helpResult(HELP[command]);
  return usageError(`legion ${command} requires project/runtime support covered by the workflow implementation tasks. Use --help to see the command contract.`);
}
```

Create `packages/cli/src/commands/workflow/ship.ts`:

```ts
import { helpResult, usageError, type CliContext, type CliResult } from "../../runtime.js";

const SHIP_HELP = "legion ship [--canary]\n\nRun release readiness, promotion, and observation gates.";

export async function handleShipWorkflow(context: CliContext): Promise<CliResult> {
  if (context.args.options.has("help") || context.args.positionals[0] === "help") return helpResult(SHIP_HELP);
  return usageError("legion ship requires a reviewed change. Run legion review first.");
}
```

- [ ] **Step 3: Wire remaining help commands**

Modify `packages/cli/src/commands/workflow/index.ts`:

```ts
import { handleAdHocWorkflow } from "./ad-hoc.js";
import { handleContextualWorkflow } from "./contextual.js";
import { handleShipWorkflow } from "./ship.js";
```

Add cases:

```ts
case "quick":
case "advise":
case "polish":
case "learn":
  return handleAdHocWorkflow(commandContext, command);
case "explore":
case "map":
case "retro":
case "milestone":
case "council":
  return handleContextualWorkflow(commandContext, command);
case "ship":
  return handleShipWorkflow(commandContext);
```

- [ ] **Step 4: Run tests**

Run:

```powershell
pnpm run build
node --test tests/cli-workflow-ux.test.mjs
```

Expected:

```text
ok
```

- [ ] **Step 5: Commit**

Run:

```powershell
git add packages/cli/src/commands/workflow/ad-hoc.ts packages/cli/src/commands/workflow/contextual.ts packages/cli/src/commands/workflow/ship.ts packages/cli/src/commands/workflow/index.ts tests/cli-workflow-ux.test.mjs
git commit -m "feat: expose remaining workflow command contracts"
```

## Task 13: Implement Runtime-Backed `build`

**Files:**
- Modify: `packages/cli/src/commands/workflow/build.ts`
- Modify: `packages/cli/src/workflow/state.ts`
- Modify: `tests/cli-workflow-ux.test.mjs`
- Test: `packages/core/test/runtime-driver.test.mjs`
- Test: `tests/cli-workflow-ux.test.mjs`

- [ ] **Step 1: Add a failing build success test**

Append:

```js
test("legion build dry-run loads the taskgraph and selects runtime-local", async () => {
  const root = await tempRepo();
  try {
    await runCliCapture([
      "--repository-root", root,
      "start",
      "--name", "Asset Mapper",
      "--summary", "Metadata authoring and deterministic asset resolution",
      "--owner", "dasbl",
      "--created-at", "2026-06-22T12:00:00.000Z",
      "--json"
    ]);
    await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n\n## Phase 1: Editor MVP\n\nBuild the editor shell.\n", "utf8");
    await runCliCapture(["--repository-root", root, "plan", "1", "--from-roadmap", "ROADMAP.md", "--json"]);
    const result = await runCliCapture(["--repository-root", root, "build", "--dry-run", "--json"]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "ready");
    assert.equal(payload.driver.driver, "runtime-local");
    assert.equal(payload.taskgraph.taskCount, 1);
    assert.equal(payload.nextAction.command, "legion build");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Implement taskgraph discovery**

In `packages/cli/src/commands/workflow/build.ts`, replace the always-blocked implementation with:

```ts
import { readdir } from "node:fs/promises";
import path from "node:path";

import { readTaskGraph } from "@legion/artifacts";
import { RuntimeLocalDriver, RUNTIME_LOCAL_DRIVER_ID } from "@legion/core";

import { failure, hasFlag, success, type CliContext, type CliResult } from "../../runtime.js";
import { nextAction, renderDiagnostics, renderNextAction } from "../../workflow/render.js";

async function latestChangeId(context: CliContext): Promise<string | null> {
  const changesRoot = path.join(context.repositoryRoot, ".legion", "project", "changes");
  try {
    const entries = await readdir(changesRoot, { withFileTypes: true });
    const changeIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    return changeIds.at(-1) ?? null;
  } catch {
    return null;
  }
}

export async function handleBuildWorkflow(context: CliContext): Promise<CliResult> {
  const changeId = await latestChangeId(context);
  if (changeId === null) {
    const action = nextAction("legion plan 1", "No planned change was found.");
    return failure(
      {
        ok: false,
        status: "blocked",
        diagnostics: [{ code: "change_missing", message: "No planned change was found. Run legion plan 1 first." }],
        nextAction: action
      },
      ["Build blocked.", "No planned change was found. Run legion plan 1 first.", renderNextAction(action)].join("\n")
    );
  }

  const taskgraph = await readTaskGraph({ repositoryRoot: context.repositoryRoot, changeId });
  if (!taskgraph.ok) {
    const action = nextAction("legion plan 1", "No executable task graph was found for the current workflow state.");
    return failure(
      { ok: false, status: "blocked", diagnostics: taskgraph.diagnostics, nextAction: action },
      ["Build blocked.", renderDiagnostics(taskgraph.diagnostics), renderNextAction(action)].join("\n")
    );
  }

  const driver = new RuntimeLocalDriver();
  const action = hasFlag(context, "dry-run")
    ? nextAction("legion build", "Dry run passed; rerun without --dry-run to start runtime execution.")
    : nextAction("legion review", "Runtime execution was accepted by the workflow adapter.");

  return success(
    {
      ok: true,
      status: hasFlag(context, "dry-run") ? "ready" : "started",
      dryRun: hasFlag(context, "dry-run"),
      changeId,
      taskgraph: {
        artifactPath: taskgraph.artifactPath,
        taskCount: taskgraph.document.tasks.length
      },
      driver: driver.driverId,
      nextAction: action,
      diagnostics: []
    },
    [
      `${changeId}: ${hasFlag(context, "dry-run") ? "ready to build" : "runtime execution started"}.`,
      `Driver: ${RUNTIME_LOCAL_DRIVER_ID}`,
      renderNextAction(action)
    ].join("\n")
  );
}
```

This task proves the CLI can find the typed plan artifacts and select a runtime. A later runtime-driver task can replace dry-run readiness with provider execution once `runtime-eve` or a supported host driver is configured. The command must never report implementation success without a runtime result.

- [ ] **Step 3: Run focused tests**

Run:

```powershell
pnpm run build
node --test tests/cli-workflow-ux.test.mjs
node --test packages/core/test/runtime-driver.test.mjs
```

Expected:

```text
ok
```

- [ ] **Step 4: Commit**

Run:

```powershell
git add packages/cli/src/commands/workflow/build.ts packages/cli/src/workflow/state.ts tests/cli-workflow-ux.test.mjs
git commit -m "feat: make legion build consume typed taskgraphs"
```

## Task 14: Implement Review And Ship Progression

**Files:**
- Modify: `packages/cli/src/commands/workflow/review.ts`
- Modify: `packages/cli/src/commands/workflow/ship.ts`
- Modify: `tests/cli-workflow-ux.test.mjs`
- Test: `packages/core/test/review.test.mjs`
- Test: `packages/core/test/release-observation.test.mjs`

- [ ] **Step 1: Add review and ship progression tests**

Append:

```js
test("legion review dry-run reports review gates for the latest taskgraph", async () => {
  const root = await tempRepo();
  try {
    await runCliCapture(["--repository-root", root, "start", "--name", "Asset Mapper", "--summary", "Metadata authoring", "--owner", "dasbl", "--created-at", "2026-06-22T12:00:00.000Z", "--json"]);
    await writeFile(path.join(root, "ROADMAP.md"), "# Roadmap\n\n## Phase 1: Editor MVP\n\nBuild the editor shell.\n", "utf8");
    await runCliCapture(["--repository-root", root, "plan", "1", "--from-roadmap", "ROADMAP.md", "--json"]);
    const result = await runCliCapture(["--repository-root", root, "review", "--dry-run", "--json"]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "ready");
    assert.equal(payload.nextAction.command, "legion review");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion ship blocks until review evidence exists", async () => {
  const root = await tempRepo();
  try {
    await runCliCapture(["--repository-root", root, "start", "--name", "Asset Mapper", "--summary", "Metadata authoring", "--owner", "dasbl", "--created-at", "2026-06-22T12:00:00.000Z", "--json"]);
    const result = await runCliCapture(["--repository-root", root, "ship", "--json"]);
    assert.equal(result.exitCode, 1);
    const payload = parseJsonOutput(result);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.nextAction.command, "legion review");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Implement review dry-run using the same taskgraph discovery pattern**

Use `readTaskGraph` and the latest change discovery from `build.ts`. If extracting `latestChangeId` avoids duplication, move it to `packages/cli/src/workflow/state.ts` as:

```ts
export async function latestChangeId(context: CliContext): Promise<string | null> {
  const changesRoot = path.join(context.repositoryRoot, ".legion", "project", "changes");
  try {
    const entries = await readdir(changesRoot, { withFileTypes: true });
    const changeIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    return changeIds.at(-1) ?? null;
  } catch {
    return null;
  }
}
```

Then make `review.ts` return `ready` on `--dry-run` and block without a taskgraph:

```ts
const action = hasFlag(context, "dry-run")
  ? nextAction("legion review", "Dry run passed; rerun without --dry-run after build evidence exists.")
  : nextAction("legion ship", "Review gates are ready to evaluate shipping.");
```

- [ ] **Step 3: Implement ship block with clear next action**

Replace the current `ship.ts` usage error with a structured failure:

```ts
const action = nextAction("legion review", "Shipping requires accepted review evidence.");
return failure(
  {
    ok: false,
    status: "blocked",
    diagnostics: [{ code: "review_evidence_missing", message: "No accepted review evidence was found. Run legion review first." }],
    nextAction: action
  },
  ["Ship blocked.", "No accepted review evidence was found. Run legion review first.", renderNextAction(action)].join("\n")
);
```

- [ ] **Step 4: Run tests**

Run:

```powershell
pnpm run build
node --test tests/cli-workflow-ux.test.mjs
node --test packages/core/test/review.test.mjs packages/core/test/release-observation.test.mjs
```

Expected:

```text
ok
```

- [ ] **Step 5: Commit**

Run:

```powershell
git add packages/cli/src/commands/workflow/review.ts packages/cli/src/commands/workflow/ship.ts packages/cli/src/workflow/state.ts tests/cli-workflow-ux.test.mjs
git commit -m "feat: add review and ship workflow progression"
```

## Task 15: Implement Standalone Workflow Commands

**Files:**
- Modify: `packages/cli/src/commands/workflow/ad-hoc.ts`
- Modify: `packages/cli/src/commands/workflow/contextual.ts`
- Modify: `tests/cli-workflow-ux.test.mjs`

- [ ] **Step 1: Add behavior tests for standalone commands**

Append:

```js
test("legion quick records an ad-hoc task request instead of exposing dev nouns", async () => {
  const root = await tempRepo();
  try {
    await runCliCapture(["--repository-root", root, "start", "--name", "Asset Mapper", "--summary", "Metadata authoring", "--owner", "dasbl", "--created-at", "2026-06-22T12:00:00.000Z", "--json"]);
    const result = await runCliCapture(["--repository-root", root, "quick", "fix the failing tests", "--json"]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "recorded");
    assert.equal(payload.workflow, "quick");
    assert.equal(payload.nextAction.command, "legion build");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legion explore records a design artifact path", async () => {
  const root = await tempRepo();
  try {
    const result = await runCliCapture(["--repository-root", root, "explore", "asset metadata editor", "--json"]);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = parseJsonOutput(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "recorded");
    assert.match(payload.artifactPath, /\.legion\/project\/explorations\//);
    assert.equal(payload.nextAction.command, "legion start");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Implement lightweight artifact recording**

Use `.legion/project/workflow/` for committed user-facing workflow notes until a dedicated artifact schema is introduced by ADR. Each command writes one JSON document with `{ schemaVersion, kind, workflow, createdAt, input, nextAction }`.

Implementation rule:

```ts
const artifactPath = `.legion/project/workflow/${workflow}/${safeTimestamp}-${slug}.json`;
```

The writer must:

- Create parent directories with `mkdir(..., { recursive: true })`.
- Use stable JSON with trailing newline.
- Never write under `.legion/var`.
- Return `status: "recorded"` and a workflow-specific next action.

- [ ] **Step 3: Wire command behavior**

In `ad-hoc.ts`:

- `quick <task>` records workflow `quick`, next action `legion build`.
- `advise <topic>` records workflow `advise`, next action `legion status`.
- `polish [target]` records workflow `polish`, next action `legion review`.
- `learn <lesson>` records workflow `learn`, next action `legion status`.

In `contextual.ts`:

- `explore <topic>` records workflow `explore`, next action `legion start`.
- `map --check` returns a read-only map readiness result.
- `map --refresh` records workflow `map`, next action `legion plan 1`.
- `retro` records workflow `retro`, next action `legion plan <next>`.
- `milestone` records workflow `milestone`, next action `legion status`.
- `council <topic>` records workflow `council`, next action `legion status`.

- [ ] **Step 4: Run tests**

Run:

```powershell
pnpm run build
node --test tests/cli-workflow-ux.test.mjs
```

Expected:

```text
ok
```

- [ ] **Step 5: Commit**

Run:

```powershell
git add packages/cli/src/commands/workflow/ad-hoc.ts packages/cli/src/commands/workflow/contextual.ts tests/cli-workflow-ux.test.mjs
git commit -m "feat: record standalone workflow commands"
```

## Task 16: Rewrite User Documentation And Remove Horrifying Walkthroughs

**Files:**
- Modify: `README.md`
- Modify: `docs/next/cli/README.md`
- Modify: `docs/next/ga/MIGRATION-POLICY.md`
- Modify: `docs/next/ga/V8-HANDOFF.md`
- Modify: `commands/*.md`
- Test: `tests/workflow-command-contract.test.mjs`

- [ ] **Step 1: Add docs assertions against worker-bundle-first usage**

Extend `tests/workflow-command-contract.test.mjs`:

```js
test("user docs do not present worker bundle authoring as typical usage", async () => {
  const files = ["README.md", "docs/next/cli/README.md"];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const firstUsageSection = text.slice(0, 2500);
    assert.doesNotMatch(firstUsageSection, /bundles\/index\.json/);
    assert.doesNotMatch(firstUsageSection, /instructionsHash/);
    assert.doesNotMatch(firstUsageSection, /promptContentContract/);
  }
});
```

- [ ] **Step 2: Update README command examples**

In `README.md`, keep the runtime slash-command install docs, but add a CLI section that starts with:

```markdown
## CLI Workflow

The canonical CLI uses the same workflow names as Legion's original slash commands:

```powershell
legion start
legion plan 1
legion build
legion review
legion status
legion quick "fix the failing tests"
```

Typed v9 internals are available under `legion dev` for operators and maintainers. Normal project work should not require `legion dev`, worker bundle manifests, or prompt hash management.
```

- [ ] **Step 3: Update GA migration docs**

Replace operator-facing `legion next` examples in `docs/next/ga/MIGRATION-POLICY.md` and `docs/next/ga/V8-HANDOFF.md` with `legion dev` when the command is truly an operator command, or `legion <workflow>` when it is a normal workflow command.

Example replacements:

```text
legion next migrate ...
```

becomes:

```text
legion dev migrate ...
```

```text
legion next release checklist ...
```

becomes:

```text
legion dev release checklist ...
```

- [ ] **Step 4: Run docs tests**

Run:

```powershell
node --test tests/workflow-command-contract.test.mjs
```

Expected:

```text
ok
```

- [ ] **Step 5: Commit**

Run:

```powershell
git add README.md docs/next/cli/README.md docs/next/ga/MIGRATION-POLICY.md docs/next/ga/V8-HANDOFF.md commands tests/workflow-command-contract.test.mjs
git commit -m "docs: restore workflow-first legion usage"
```

## Task 17: Final Verification And Package Smoke

**Files:**
- Read: `docs/next/evidence/`
- Modify only if validation scripts intentionally refresh generated docs.

- [ ] **Step 1: Run focused tests**

Run:

```powershell
node --test tests/workflow-command-contract.test.mjs tests/cli-workflow-ux.test.mjs tests/bin-router.test.mjs
```

Expected:

```text
ok
```

- [ ] **Step 2: Run package and CLI gates**

Run:

```powershell
pnpm run build
pnpm --filter @legion/cli typecheck
node bin/legion.js --help
node bin/legion.js dev --help
```

Expected:

```text
legion <command>
legion dev <command>
```

- [ ] **Step 3: Run release hardening tests**

Run:

```powershell
node --test tests/evals-redaction.test.mjs tests/evals-threat-model.test.mjs tests/release-checklist.test.mjs tests/rollback-policy.test.mjs
```

Expected:

```text
ok
```

- [ ] **Step 4: Run repo-wide validation**

Run:

```powershell
pnpm run validate:next
```

Expected:

```text
validate-next PASS
```

- [ ] **Step 5: Run package dry run**

Run:

```powershell
npm pack --dry-run
pnpm pack --dry-run
```

Expected:

```text
bin/legion.js
dist/legion-cli.mjs
```

The dry-run output must not show missing CLI bundle files.

- [ ] **Step 6: Inspect diff**

Run:

```powershell
git status --short
git diff --check
```

Expected:

```text
git diff --check
```

prints no whitespace errors.

- [ ] **Step 7: Commit final docs or generated validation refresh**

If validation refreshed generated docs or package metadata:

```powershell
git add <changed-files>
git commit -m "chore: refresh workflow cli validation artifacts"
```

Skip this commit if no files changed.

## Task 18: PR Handoff

**Files:**
- Read: `git log --oneline`
- Read: `git status --short --branch`

- [ ] **Step 1: Summarize the product correction**

Use this PR summary:

```markdown
## Summary

- Restores original Legion workflow verbs as the canonical CLI surface: `legion start`, `legion plan`, `legion build`, `legion review`, `legion status`, and related commands.
- Moves typed v9 engine/operator commands behind `legion dev`, with hidden `legion next` compatibility.
- Keeps worker bundle authoring internal to dev workflows instead of presenting prompt hashes and bundle manifests as normal usage.
- Adds CLI UX, bin-router, and docs contract tests.

## Verification

- `node --test tests/workflow-command-contract.test.mjs tests/cli-workflow-ux.test.mjs tests/bin-router.test.mjs`
- `node --test tests/evals-redaction.test.mjs tests/evals-threat-model.test.mjs tests/release-checklist.test.mjs tests/rollback-policy.test.mjs`
- `pnpm run build`
- `pnpm --filter @legion/cli typecheck`
- `pnpm run validate:next`
- `npm pack --dry-run`
- `pnpm pack --dry-run`
```

- [ ] **Step 2: Push branch**

Run:

```powershell
git push -u origin codex/legion-workflow-ux-realignment
```

Expected:

```text
branch 'codex/legion-workflow-ux-realignment' set up to track
```

## Self-Review

Spec coverage:

- Restores original workflow names as canonical CLI: Tasks 1, 3, 6, 8, 10, 12, 13, 14, 15.
- Hides worker bundle authoring from normal usage: Tasks 1, 2, 3, 12, 13, 15, 16.
- Keeps typed v9 architecture as engine: Tasks 3, 6, 9, 10, 11, 13, 14.
- Preserves `board` vs `council`: Tasks 1 and 12.
- Keeps `legion next` as hidden compatibility, not public flow: Tasks 2 and 3.
- Leaves IDE merge out of scope: Scope Check and Task 18 handoff.
- Includes CLI hardening review fallout: Task 11.

Placeholder scan:

- The plan avoids placeholder-only implementation instructions and no task says only "write tests".
- Commands include expected outcomes.
- Every new implementation file has a concrete responsibility.

Type consistency:

- `CliResult`, `CliContext`, `success`, `failure`, `usageError`, `helpResult`, `stripCommand`, `hasFlag`, `stringOption`, and `fromServiceResult` match existing runtime naming.
- Workflow command handlers use the `handle<Name>Workflow(context)` pattern.
- `NextAction` uses `command` and `reason` consistently across payloads and tests.
