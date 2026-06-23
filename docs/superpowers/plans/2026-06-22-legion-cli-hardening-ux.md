# Legion CLI Hardening And UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `legion` the canonical, hardened operator CLI with top-level project commands, predictable path handling, fail-closed helper adapters, and a read-only doctor command.

**Architecture:** Keep the existing TypeScript CLI engine in `packages/cli` and promote it behind a root `bin/legion.js` router. Add shared CLI utilities for path resolution, helper JSON verdict parsing, and diagnostics so release/eval/project/doctor commands follow one contract. Preserve `legion next ...` as a temporary compatibility alias while documenting `legion ...` as the normal flow.

**Tech Stack:** Node.js 24, TypeScript, pnpm workspaces, Node test runner, existing `@legion/*` packages, Git command-line probes for safe inference.

---

## Source Design

- Spec: `docs/superpowers/specs/2026-06-22-legion-cli-hardening-ux-design.md`
- Existing CLI entry: `packages/cli/src/index.ts`
- Existing runtime helpers: `packages/cli/src/runtime.ts`
- Existing project commands: `packages/cli/src/commands/project/index.ts`
- Existing eval commands: `packages/cli/src/commands/evals/index.ts`
- Existing release commands: `packages/cli/src/commands/release/index.ts`
- Existing CLI e2e tests: `apps/cli-e2e/test/cli-e2e.test.mjs`
- Existing package binary: `bin/install.js`

## File Structure

- Create `bin/legion.js`: root executable router for product CLI and installer compatibility.
- Modify `package.json`: point `"bin.legion"` at `bin/legion.js` and include built CLI files in package contents.
- Modify `packages/cli/src/index.ts`: canonical root help, top-level commands, compatibility alias diagnostics.
- Modify `packages/cli/src/runtime.ts`: diagnostics, warning attachment, shared string/boolean option helpers.
- Create `packages/cli/src/path-resolution.ts`: repository-relative path resolver for command adapters.
- Create `packages/cli/src/helper-verdict.ts`: parse helper JSON output and map helper verdicts to CLI success/failure.
- Modify `packages/cli/src/commands/project/index.ts`: support top-level `init|status|validate` and inferred init input.
- Create `packages/cli/src/commands/project/infer.ts`: Git and OS-based project init inference.
- Create `packages/cli/src/commands/doctor/index.ts`: read-only diagnostics.
- Modify `packages/cli/src/commands/evals/index.ts`: use shared path and helper verdict utilities.
- Modify `packages/cli/src/commands/release/index.ts`: use shared path and helper verdict utilities.
- Modify `apps/cli-e2e/test/cli-e2e.test.mjs`: add canonical `legion` tests, alias tests, path tests, doctor tests.
- Modify `docs/next/cli/README.md`: document `legion` as the normal command flow.

## Task 0: Execution Hygiene And Branch Isolation

**Files:**
- Read: `git status`
- No code changes

- [ ] **Step 1: Verify current worktree state**

Run:

```powershell
git status --short --branch
```

Expected: if unrelated staged or modified files exist, do not continue in this checkout.

- [ ] **Step 2: Create an isolated worktree for this plan**

Run from `C:/Users/dasbl/Documents/Legion Retooled`:

```powershell
$branch = "codex/legion-cli-hardening-ux"
$worktree = "C:/Users/dasbl/Documents/Legion Retooled/.worktrees/legion-cli-hardening-ux"
git fetch origin
git worktree add -b $branch $worktree origin/main
```

Expected: a clean worktree exists at `.worktrees/legion-cli-hardening-ux`.

- [ ] **Step 3: Confirm isolated state**

Run:

```powershell
git -C "C:/Users/dasbl/Documents/Legion Retooled/.worktrees/legion-cli-hardening-ux" status --short --branch
```

Expected: clean status on `codex/legion-cli-hardening-ux`.

## Task 1: Root `legion` Router And Top-Level Dispatch

**Files:**
- Create: `bin/legion.js`
- Modify: `package.json`
- Modify: `packages/cli/src/index.ts`
- Test: `apps/cli-e2e/test/cli-e2e.test.mjs`

- [ ] **Step 1: Add failing e2e tests for canonical root commands**

Add tests near the existing `P02-T10` CLI routing tests in `apps/cli-e2e/test/cli-e2e.test.mjs`:

```javascript
async function runCanonicalCli(args, options = {}) {
  try {
    const result = await execFile(process.execPath, [CLI, "--json", "--no-color", ...args], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 16,
      ...options
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, json: JSON.parse(result.stdout) };
  } catch (error) {
    return {
      exitCode: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      json: error.stdout ? JSON.parse(error.stdout) : undefined
    };
  }
}

test("CLI root exposes top-level status and validate without next/project namespace", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const inputPath = path.join(workspace, "init.json");
    await mkdir(repositoryRoot, { recursive: true });
    await writeJson(inputPath, initInput());
    assert.equal((await runCli(["--repository-root", repositoryRoot, "project", "init", "--input", inputPath])).exitCode, 0);

    const status = await runCanonicalCli(["--repository-root", repositoryRoot, "status"]);
    assert.equal(status.exitCode, 0, status.stderr);
    assert.equal(status.json.ok, true);
    assert.equal(status.json.project.id, PROJECT_ID);

    const validation = await runCanonicalCli(["--repository-root", repositoryRoot, "validate"]);
    assert.equal(validation.exitCode, 0, validation.stderr);
    assert.equal(validation.json.ok, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legacy next namespace routes with a deprecation diagnostic under json", async () => {
  const result = await runCanonicalCli(["next", "--repository-root", ROOT, "project", "status"]);
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.json.diagnostics.some((diagnostic) => diagnostic.code === "deprecated_namespace"));
});
```

- [ ] **Step 2: Run tests and confirm they fail for missing top-level behavior**

Run:

```powershell
pnpm --filter @legion/cli-e2e test
```

Expected: the new top-level command test fails because `status` and `validate` are not routed yet.

- [ ] **Step 3: Create root executable router**

Create `bin/legion.js`:

```javascript
#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const argv = process.argv.slice(2);
const productCommands = new Set([
  "init",
  "status",
  "validate",
  "doctor",
  "project",
  "change",
  "board",
  "migrate",
  "evals",
  "release",
  "config",
  "next"
]);

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });
  if (typeof result.status === "number") process.exit(result.status);
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(1);
}

const first = argv[0];
if (first !== undefined && productCommands.has(first)) {
  runNode(path.resolve(__dirname, "..", "packages", "cli", "dist", "index.js"), argv);
}

runNode(path.resolve(__dirname, "install.js"), argv);
```

- [ ] **Step 4: Update package binary and files**

Modify `package.json`:

```json
"bin": {
  "legion": "bin/legion.js"
},
"files": [
  ".codex-plugin/",
  "bin/",
  "agents/",
  "commands/",
  "skills/",
  "adapters/",
  "packages/cli/dist/",
  "packages/cli/package.json",
  "settings.json",
  "checksums.sha256",
  "docs/control-modes.md",
  "docs/runtime-audit.md",
  "docs/runtime-certification-checklists.md",
  "docs/security/",
  "docs/settings.schema.json"
]
```

- [ ] **Step 5: Add top-level dispatch in `packages/cli/src/index.ts`**

Change root help from `legion next <command>` to `legion <command>`, then route top-level project commands:

```typescript
async function dispatch(context: CliContext): Promise<CliResult> {
  if (context.args.options.has("help") && context.args.positionals.length === 0) return helpResult(ROOT_HELP);
  const [command] = context.args.positionals;
  if (command === undefined) return helpResult(ROOT_HELP);

  const commandContext = stripCommand(context, 1);
  switch (command) {
    case "init":
      return handleProjectCommand(withPositionals(commandContext, ["init", ...commandContext.args.positionals]));
    case "status":
      return handleProjectCommand(withPositionals(commandContext, ["status", ...commandContext.args.positionals]));
    case "validate":
      return handleProjectCommand(withPositionals(commandContext, ["validate", ...commandContext.args.positionals]));
    case "doctor":
      return handleDoctorCommand(commandContext);
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
    default:
      return usageError(`Unknown legion command: ${command}.`);
  }
}

function withPositionals(context: CliContext, positionals: readonly string[]): CliContext {
  return { ...context, args: { ...context.args, positionals } };
}
```

- [ ] **Step 6: Preserve `next` compatibility in `runCli`**

Replace `const namespacedArgs = argv[0] === "next" ? argv.slice(1) : argv;` with logic that records a compatibility warning in context:

```typescript
const usedLegacyNextNamespace = argv[0] === "next";
const namespacedArgs = usedLegacyNextNamespace ? argv.slice(1) : argv;
```

Add a diagnostic attachment helper in Task 2, then call it before writing the result.

- [ ] **Step 7: Run focused verification**

Run:

```powershell
pnpm --filter @legion/cli-e2e test
```

Expected: the new top-level routing tests pass.

- [ ] **Step 8: Commit**

Run:

```powershell
git add bin/legion.js package.json packages/cli/src/index.ts apps/cli-e2e/test/cli-e2e.test.mjs
git commit -m "feat: promote legion top-level CLI commands"
```

## Task 2: Shared Runtime Diagnostics, Path Resolution, And Helper Verdicts

**Files:**
- Modify: `packages/cli/src/runtime.ts`
- Create: `packages/cli/src/path-resolution.ts`
- Create: `packages/cli/src/helper-verdict.ts`
- Test: `apps/cli-e2e/test/cli-e2e.test.mjs`

- [ ] **Step 1: Add path and helper tests**

Add e2e tests that create relative evidence paths under a temp repository and assert commands do not read from `V9_SOURCE_ROOT`. Use existing release/evals fixtures when available and assert `helperArgs` contain absolute repository-root paths on failure.

```javascript
test("CLI helper adapters resolve operator paths relative to repository root", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    await mkdir(path.join(repositoryRoot, "logs"), { recursive: true });
    await writeText(path.join(repositoryRoot, "logs", "validate-next.log"), "validate-next PASS\n");

    const result = await runCanonicalCli([
      "--repository-root", repositoryRoot,
      "release", "checklist",
      "--release-version", "9.0.0",
      "--validate-next-log", "logs/validate-next.log"
    ]);

    assert.notEqual(result.exitCode, 0);
    const helperDiagnostic = JSON.stringify(result.json);
    assert.match(helperDiagnostic, new RegExp(repositoryRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Add `path-resolution.ts`**

Create `packages/cli/src/path-resolution.ts`:

```typescript
import path from "node:path";

import type { CliContext } from "./runtime.js";

export function resolveOperatorPath(context: CliContext, value: string): string {
  return path.resolve(context.repositoryRoot, value);
}

export function maybeRelativeToRepository(context: CliContext, value: string): string {
  const resolved = path.resolve(value);
  const relative = path.relative(context.repositoryRoot, resolved);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : resolved;
}
```

- [ ] **Step 3: Add `helper-verdict.ts`**

Create `packages/cli/src/helper-verdict.ts`:

```typescript
import { failure, success, type CliResult } from "./runtime.js";

export function parseJsonObjectFromStdout(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
}

export function resultFromHelperVerdict(input: {
  readonly verdict: Record<string, unknown> | null;
  readonly successStatus: string;
  readonly failureStatus: string;
  readonly successHuman: string;
  readonly failureHuman: string;
  readonly missingCode: string;
  readonly missingMessage: string;
}): CliResult {
  if (input.verdict === null) {
    return failure(
      { ok: false, status: "error", diagnostics: [{ code: input.missingCode, message: input.missingMessage }] },
      input.missingMessage
    );
  }
  const ok = input.verdict["ok"] === true;
  const payload = { ok, status: ok ? input.successStatus : input.failureStatus, verdict: input.verdict };
  return ok ? success(payload, input.successHuman) : failure(payload, input.failureHuman);
}
```

- [ ] **Step 4: Add diagnostic attachment in `runtime.ts`**

Add:

```typescript
export interface CliDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity?: "warning" | "error";
}

export function withDiagnostics(result: CliResult, diagnostics: readonly CliDiagnostic[]): CliResult {
  if (diagnostics.length === 0) return result;
  const existing = Array.isArray(result.payload["diagnostics"]) ? result.payload["diagnostics"] as readonly unknown[] : [];
  return {
    ...result,
    payload: {
      ...result.payload,
      diagnostics: [...existing, ...diagnostics]
    }
  };
}
```

- [ ] **Step 5: Replace duplicated helper JSON parsing**

In `packages/cli/src/commands/evals/index.ts` and `packages/cli/src/commands/release/index.ts`, import `parseJsonObjectFromStdout`, `resultFromHelperVerdict`, and `resolveOperatorPath`. Remove local `parseJsonVerdict` functions after all call sites use the shared helper.

- [ ] **Step 6: Run focused verification**

Run:

```powershell
pnpm --filter @legion/cli-e2e test
pnpm --filter @legion/cli typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 7: Commit**

Run:

```powershell
git add packages/cli/src/runtime.ts packages/cli/src/path-resolution.ts packages/cli/src/helper-verdict.ts packages/cli/src/commands/evals/index.ts packages/cli/src/commands/release/index.ts apps/cli-e2e/test/cli-e2e.test.mjs
git commit -m "fix: centralize CLI helper verdict handling"
```

## Task 3: Top-Level `legion init` With Safe Defaults

**Files:**
- Create: `packages/cli/src/commands/project/infer.ts`
- Modify: `packages/cli/src/commands/project/index.ts`
- Test: `apps/cli-e2e/test/cli-e2e.test.mjs`

- [ ] **Step 1: Add failing init inference tests**

Add:

```javascript
test("top-level init infers project identity from a git repository", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "asset-mapper");
    await mkdir(repositoryRoot, { recursive: true });
    await execFile("git", ["init"], { cwd: repositoryRoot });
    await execFile("git", ["checkout", "-b", "main"], { cwd: repositoryRoot });
    await execFile("git", ["remote", "add", "origin", "https://github.com/9thLevelSoftware/keystone.git"], { cwd: repositoryRoot });

    const result = await runCanonicalCli([
      "--repository-root", repositoryRoot,
      "init",
      "--owner", "dasbl",
      "--dry-run"
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.status, "dry_run");
    assert.equal(result.json.project.id, "prj_asset-mapper");
    assert.equal(result.json.project.name, "asset-mapper");
    assert.equal(result.json.project.repository.defaultBranch, "main");
    assert.equal(result.json.project.repository.remoteUrl, "https://github.com/9thLevelSoftware/keystone.git");
    assert.equal(await exists(path.join(repositoryRoot, ".legion", "project", "project.json")), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Create inference module**

Create `packages/cli/src/commands/project/infer.ts`:

```typescript
import { execFile as execFileCb } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { InitProjectInput } from "@legion/artifacts";
import type { CliContext, CliResult } from "../../runtime.js";
import { stringOption, usageError } from "../../runtime.js";

const execFile = promisify(execFileCb);

async function gitValue(repositoryRoot: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const result = await execFile("git", args, { cwd: repositoryRoot, encoding: "utf8", shell: false });
    const value = result.stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function inferInitProjectInput(context: CliContext): Promise<InitProjectInput | CliResult> {
  const folderName = path.basename(context.repositoryRoot);
  const slug = stringOption(context, "slug") ?? sanitizeSlug(folderName);
  const name = stringOption(context, "name") ?? folderName;
  const owner = stringOption(context, "owner") ?? os.userInfo().username;
  if (owner.length === 0) return usageError("Owner could not be inferred. Re-run with --owner <id>.");
  const defaultBranch = stringOption(context, "default-branch") ?? await gitValue(context.repositoryRoot, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "main";
  const remoteUrl = stringOption(context, "remote-url") ?? await gitValue(context.repositoryRoot, ["remote", "get-url", "origin"]);
  return {
    repositoryRoot: context.repositoryRoot,
    slug,
    name,
    repository: {
      provider: "git",
      defaultBranch,
      ...(remoteUrl === undefined ? {} : { remoteUrl })
    },
    decisionOwners: [{ kind: "human", id: owner, displayName: owner }],
    dryRun: context.args.options.get("dry-run") === true
  };
}
```

- [ ] **Step 3: Use inference when `--input` is absent**

In `packages/cli/src/commands/project/index.ts`, update `init`:

```typescript
async function init(context: CliContext): Promise<CliResult> {
  const inputPath = stringOption(context, "input");
  const input = inputPath === undefined
    ? await inferInitProjectInput(context)
    : await readJsonInput(inputPath);
  if (isCliResult(input)) return input;

  const result = await initProject({
    ...input,
    repositoryRoot: context.repositoryRoot
  } as InitProjectInput);

  return fromServiceResult(result as unknown as Record<string, unknown>, projectHuman(result));
}
```

- [ ] **Step 4: Update project help**

Change help text to show:

```text
legion init [--name <name>] [--slug <slug>] [--owner <id>] [--dry-run]
legion project init --input <file>
```

- [ ] **Step 5: Run focused verification**

Run:

```powershell
pnpm --filter @legion/cli-e2e test
pnpm --filter @legion/artifacts test
```

Expected: all tests pass, including dry-run no-write behavior.

- [ ] **Step 6: Commit**

Run:

```powershell
git add packages/cli/src/commands/project/index.ts packages/cli/src/commands/project/infer.ts apps/cli-e2e/test/cli-e2e.test.mjs
git commit -m "feat: infer defaults for legion init"
```

## Task 4: Read-Only `legion doctor`

**Files:**
- Create: `packages/cli/src/commands/doctor/index.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `apps/cli-e2e/test/cli-e2e.test.mjs`

- [ ] **Step 1: Add failing doctor tests**

Add:

```javascript
test("doctor reports initialized project health", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const inputPath = path.join(workspace, "init.json");
    await mkdir(repositoryRoot, { recursive: true });
    await writeJson(inputPath, initInput());
    assert.equal((await runCanonicalCli(["--repository-root", repositoryRoot, "init", "--input", inputPath])).exitCode, 0);

    const result = await runCanonicalCli(["--repository-root", repositoryRoot, "doctor"]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.status, "healthy");
    assert.ok(result.json.checks.some((check) => check.code === "project_manifest" && check.status === "pass"));
    assert.ok(result.json.checks.some((check) => check.code === "project_validation" && check.status === "pass"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("doctor exits nonzero when project validation fails", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    await mkdir(repositoryRoot, { recursive: true });
    const result = await runCanonicalCli(["--repository-root", repositoryRoot, "doctor"]);
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.json.ok, false);
    assert.ok(result.json.checks.some((check) => check.code === "project_manifest" && check.status === "fail"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Implement doctor command**

Create `packages/cli/src/commands/doctor/index.ts`:

```typescript
import { access, stat } from "node:fs/promises";
import path from "node:path";

import { loadProject, validateProject } from "@legion/artifacts";
import { failure, helpResult, success, type CliContext, type CliResult } from "../../runtime.js";

type DoctorStatus = "pass" | "warn" | "fail";

interface DoctorCheck {
  readonly code: string;
  readonly status: DoctorStatus;
  readonly message: string;
}

const DOCTOR_HELP = `legion doctor

Read-only diagnostics for repository initialization, project validity, runtime state, and CLI helper availability.`;

export async function handleDoctorCommand(context: CliContext): Promise<CliResult> {
  if (context.args.options.has("help")) return helpResult(DOCTOR_HELP);
  const checks: DoctorCheck[] = [];

  try {
    const stats = await stat(context.repositoryRoot);
    checks.push({ code: "repository_root", status: stats.isDirectory() ? "pass" : "fail", message: context.repositoryRoot });
  } catch {
    checks.push({ code: "repository_root", status: "fail", message: `Repository root not found: ${context.repositoryRoot}` });
  }

  const loaded = await loadProject({ repositoryRoot: context.repositoryRoot });
  checks.push({
    code: "project_manifest",
    status: loaded.ok ? "pass" : "fail",
    message: loaded.ok ? "Project manifest loaded." : "Project manifest is missing or invalid."
  });

  const validated = await validateProject({ repositoryRoot: context.repositoryRoot });
  checks.push({
    code: "project_validation",
    status: validated.ok ? "pass" : "fail",
    message: validated.ok ? "Project validation passed." : "Project validation failed."
  });

  try {
    await access(path.join(context.repositoryRoot, ".legion", "var"));
    checks.push({ code: "runtime_state", status: "pass", message: ".legion/var is accessible." });
  } catch {
    checks.push({ code: "runtime_state", status: "warn", message: ".legion/var is not accessible; initialize the project or recreate runtime state." });
  }

  const failed = checks.filter((check) => check.status === "fail");
  const payload = {
    ok: failed.length === 0,
    status: failed.length === 0 ? "healthy" : "unhealthy",
    checks,
    diagnostics: failed.map((check) => ({ code: check.code, message: check.message }))
  };
  return failed.length === 0
    ? success(payload, `Doctor passed with ${checks.length} checks.`)
    : failure(payload, `Doctor found ${failed.length} failing checks.`);
}
```

- [ ] **Step 3: Wire doctor into root dispatch**

Import and route `handleDoctorCommand` in `packages/cli/src/index.ts`.

- [ ] **Step 4: Run focused verification**

Run:

```powershell
pnpm --filter @legion/cli-e2e test
pnpm --filter @legion/cli typecheck
```

Expected: doctor tests and typecheck pass.

- [ ] **Step 5: Commit**

Run:

```powershell
git add packages/cli/src/commands/doctor/index.ts packages/cli/src/index.ts apps/cli-e2e/test/cli-e2e.test.mjs
git commit -m "feat: add legion doctor diagnostics"
```

## Task 5: Harden Release, Eval, Redaction, And Rollback Failure Semantics

**Files:**
- Modify: `packages/cli/src/commands/evals/index.ts`
- Modify: `packages/cli/src/commands/release/index.ts`
- Modify: `scripts/baseline/redact-output.mjs`
- Modify: `scripts/baseline/threat-model.mjs`
- Modify: `scripts/release/release-checklist.mjs`
- Modify: `scripts/release/rollback-policy.mjs`
- Test: `apps/cli-e2e/test/cli-e2e.test.mjs`
- Test: `tests/release-checklist.test.mjs`

- [ ] **Step 1: Add regression tests for helper failures**

Add tests covering:

```javascript
test("threat-model returns nonzero when helper verdict is blocked", async () => {
  const workspace = await tempRoot();
  try {
    const repositoryRoot = path.join(workspace, "repo");
    const runDir = path.join(repositoryRoot, "runs", "bad");
    await mkdir(runDir, { recursive: true });
    await writeText(path.join(runDir, "transcript.redacted.log"), "api_key=[REDACTED_SECRET]\n");

    const result = await runCanonicalCli([
      "--repository-root", repositoryRoot,
      "evals", "threat-model",
      "--run-dir", "runs/bad",
      "--output-root", "runs"
    ]);

    assert.notEqual(result.exitCode, 0);
    assert.equal(result.json.ok, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Resolve all helper paths through `resolveOperatorPath`**

In release and eval adapters, replace path construction like `path.resolve(context.repositoryRoot, value)` with:

```typescript
args.push("--validate-next-log", resolveOperatorPath(context, validateNextLog));
```

Use the same pattern for `--backup-manifest`, `--run-directory`, `--v8-dir`, `--v9-dir`, `--output`, `--run-dir`, `--output-root`, and `--report`.

- [ ] **Step 3: Ensure helper verdict failures return CLI failure**

Use:

```typescript
const verdict = parseJsonObjectFromStdout(result.stdout);
return resultFromHelperVerdict({
  verdict,
  successStatus: "ready",
  failureStatus: "blocked",
  successHuman: `Release checklist ready for ${releaseVersion}.`,
  failureHuman: `Release checklist blocked for ${releaseVersion} - see findings.`,
  missingCode: "release_checklist_verdict_missing",
  missingMessage: "release-checklist.mjs did not emit a JSON verdict"
});
```

Adapt status and messages per command.

- [ ] **Step 4: Harden JSON credential redaction**

In `scripts/baseline/redact-output.mjs`, use:

```javascript
const JSON_CREDENTIAL_RE = /"(?:api[_-]?key|api[_-]?secret|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd|token|secret)"\s*:\s*"(?:[^"\\]|\\.)*"/gi;
```

and replacement:

```javascript
return match.replace(/:\s*"(?:[^"\\]|\\.)*"/, ': "[REDACTED_JSON_SECRET]"');
```

- [ ] **Step 5: Ignore bracketed redaction markers in threat-model credential audit**

In `scripts/baseline/threat-model.mjs`, update the credential assignment leak regex so values starting with `[REDACTED` are ignored. The accepted value guard should treat both `REDACTED_SECRET` and `[REDACTED_SECRET]` as redacted.

- [ ] **Step 6: Scope GA changelog checks to the requested release section**

In `scripts/release/release-checklist.mjs`, extract the requested `## [version]` section before checking for `GA-approved` or `GA-pending`. Older release sections must not satisfy the requested release.

- [ ] **Step 7: Use access checks for rollback writability**

In `scripts/release/rollback-policy.mjs`, import `constants` and `access`, then replace mode-bit checks with:

```javascript
try {
  const parent = path.dirname(legionRoot);
  await access(parent, constants.W_OK);
} catch {
  findings.push({
    code: "restore_target_writable",
    message: `Parent of .legion (${path.dirname(legionRoot)}) is not writable or accessible.`
  });
}
```

- [ ] **Step 8: Run focused verification**

Run:

```powershell
pnpm --filter @legion/cli-e2e test
node --test tests/release-checklist.test.mjs
pnpm run validate:next
```

Expected: all targeted and repo validation checks pass.

- [ ] **Step 9: Commit**

Run:

```powershell
git add packages/cli/src/commands/evals/index.ts packages/cli/src/commands/release/index.ts scripts/baseline/redact-output.mjs scripts/baseline/threat-model.mjs scripts/release/release-checklist.mjs scripts/release/rollback-policy.mjs apps/cli-e2e/test/cli-e2e.test.mjs tests/release-checklist.test.mjs
git commit -m "fix: harden CLI helper failure semantics"
```

## Task 6: Documentation And Compatibility Cleanup

**Files:**
- Modify: `docs/next/cli/README.md`
- Modify: `README.md`
- Modify: `package.json`
- Test: `scripts/validate-next.mjs`

- [ ] **Step 1: Update CLI docs to lead with `legion`**

In `docs/next/cli/README.md`, replace normal examples with:

```powershell
legion init --dry-run
legion init
legion status
legion validate
legion doctor
```

Move `legion next ...` examples into a section named `Compatibility Aliases`.

- [ ] **Step 2: Document advanced command groups**

Add examples:

```powershell
legion migrate preview --from-planning --planning-root .planning --staging-root .legion/var/stage --run-id import-001
legion release checklist --release-version 9.0.0 --validate-next-log docs/next/evidence/P13-CLOSEOUT/validate-next.log
legion evals threat-model --run-dir evals/baseline/runs/example --output-root evals/baseline/runs
```

- [ ] **Step 3: Update root package description**

Change `package.json` description to avoid implementation-era naming:

```json
"description": "Durable workflow orchestration tool for Legion."
```

- [ ] **Step 4: Run docs validation**

Run:

```powershell
pnpm run validate:next
```

Expected: validation passes.

- [ ] **Step 5: Commit**

Run:

```powershell
git add docs/next/cli/README.md README.md package.json
git commit -m "docs: document legion CLI command flow"
```

## Task 7: Final Verification And PR Handoff

**Files:**
- Read: all modified files
- No new source files

- [ ] **Step 1: Run focused CLI gate**

Run:

```powershell
pnpm --filter @legion/cli-e2e test
```

Expected: all CLI e2e tests pass.

- [ ] **Step 2: Run package typecheck**

Run:

```powershell
pnpm --filter @legion/cli typecheck
```

Expected: TypeScript typecheck passes.

- [ ] **Step 3: Run artifact tests**

Run:

```powershell
pnpm --filter @legion/artifacts test
```

Expected: artifacts project/init tests pass.

- [ ] **Step 4: Run repo validation**

Run:

```powershell
pnpm run validate:next
```

Expected: validation passes.

- [ ] **Step 5: Run package dry run**

Run:

```powershell
npm pack --dry-run
```

Expected: output includes `bin/legion.js`, `bin/install.js`, and built `packages/cli/dist` files.

- [ ] **Step 6: Inspect final diff**

Run:

```powershell
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
git status --short --branch
```

Expected: diff contains only CLI hardening, UX, docs, and test changes. `git diff --check` passes.

- [ ] **Step 7: Push branch**

Run:

```powershell
git push -u origin codex/legion-cli-hardening-ux
```

Expected: branch pushes successfully.

## Stop Conditions

- Stop if the execution worktree is not clean before Task 1.
- Stop if root `legion` routing cannot include `packages/cli/dist` in the package without breaking installer compatibility.
- Stop if `legion init` inference requires interactive prompts to succeed.
- Stop if any helper-backed command can return `ok: false` with exit code 0.
- Stop if `npm pack --dry-run` excludes the product CLI entrypoint.
- Stop if `pnpm run validate:next` fails for reasons caused by this workstream.

