# Legion CLI Hardening And UX Design

## Status

Approved for implementation planning.

## Context

Legion Ascended has a working structured engine behind the current CLI surface: project artifacts, board state, migration helpers, eval helpers, release helpers, JSON output, and CLI e2e coverage. The current operator experience is still too source-oriented and too namespace-heavy. A normal user should not need to know whether the implementation era was called Next, Ascended, or v9.

The product command is `legion`. Release codenames and implementation eras are internal history, not user-facing command grammar.

This design covers CLI hardening and the first friendly UX layer only. It intentionally excludes Legion IDE integration. The CLI should become stable enough for operators, automation, and a later IDE bridge, but it should not try to become the whole IDE product surface.

## Goals

- Make `legion` the canonical command surface.
- Move first-use project operations to top-level commands.
- Preserve machine-readable `--json` behavior for scripts and gates.
- Make helper-backed commands fail closed when helper verdicts fail.
- Resolve filesystem paths predictably from the operator repository.
- Reduce hand-authored JSON for common flows.
- Add diagnostics that tell an operator what is wrong and how to fix it.
- Keep compatibility shims for existing `legion next ...` scripts during migration.

## Non-Goals

- No Legion IDE integration in this workstream.
- No broad redesign of the artifact model, board model, migration model, or protocol schemas.
- No interactive prompt dependency for v1. Commands must work in noninteractive shells.
- No hidden network calls, telemetry, or hosted behavior.
- No permanent `next` or `ascended` namespace in documented command examples.

## Command Contract

The canonical happy path is top-level:

```powershell
legion init
legion status
legion validate
legion doctor
```

Common options:

```powershell
legion init [--repository-root <path>] [--name <name>] [--slug <slug>] [--owner <id>] [--dry-run] [--json]
legion status [--repository-root <path>] [--json]
legion validate [--repository-root <path>] [--json]
legion doctor [--repository-root <path>] [--json]
```

Advanced domains remain namespaced because they describe real work areas:

```powershell
legion migrate preview|apply|rollback
legion board ...
legion release ...
legion evals ...
legion config ...
```

Compatibility aliases may remain temporarily:

```powershell
legion next ...
legion next project init ...
```

Compatibility aliases should emit a deprecation diagnostic. In human output, the diagnostic can be printed as a warning. In `--json`, it must be represented in the JSON diagnostics array instead of producing unstructured stderr noise.

## First-Run UX

`legion init` should infer safe defaults:

- repository root: current directory, unless `--repository-root` is provided;
- slug: sanitized repository folder name;
- name: repository folder name, preserving obvious user capitalization where possible;
- default branch: `git rev-parse --abbrev-ref HEAD`, falling back to `main`;
- remote URL: `git remote get-url origin`, omitted if unavailable;
- owner: `--owner`, then current OS username if available;
- created timestamp: current UTC time, unless an explicit test-only or advanced override is provided.

If required values cannot be inferred safely, the command should fail with a focused message and the exact override flag. For example:

```text
Owner could not be inferred. Re-run with --owner <id>.
```

`legion init --dry-run` must show the project identity, manifest path, constitution path, ignored runtime path, and files that would be written without mutating the repository.

## Path Resolution Rules

All operator-provided filesystem paths follow one rule:

- absolute paths are used as-is after normal path normalization;
- relative paths resolve against `--repository-root`;
- helper scripts receive absolute paths;
- helper execution cwd must never change the meaning of operator-provided paths.

This applies to release, eval, migration, backup, restore, compare, grade, threat-model, and redaction paths.

The CLI should expose a shared path resolver instead of repeating ad hoc path handling in each command adapter.

## Exit And Output Rules

Every command must obey the same result contract:

- human output by default;
- stable JSON when `--json` is present;
- `ok: true` means exit code 0;
- `ok: false` means nonzero exit;
- blocked, invalid, security, redaction, sandbox, rollback, release-checklist, and threat-model verdicts are failures;
- failed helper JSON must not be wrapped in a successful CLI result;
- malformed helper output is a failure with a parse diagnostic;
- warnings do not change exit code unless the command verdict is blocked or invalid.

Human output should be short and action-oriented. JSON output should preserve the existing diagnostics structure and include enough information for tests and future UI bridge consumers.

## Hardening Areas

### Helper-Backed Commands

Release and eval adapters that call helper scripts must inspect both process exit status and parsed helper payload. If the helper exits nonzero or returns `ok: false`, the CLI command must return a failure result.

### Redaction

Redaction must handle JSON string values containing escaped quotes. Credential assignment audits must not report already-redacted markers such as `[REDACTED_SECRET]` as leaks.

### Threat Model

Threat-model parsing should parse complete JSON output first, then fall back to extracting a JSON object only if wrapper output exists. A parsing failure must be reported as an invalid helper result, not as a successful command.

### Release Checklist

Stable-channel changelog checks must inspect the requested release section, not the entire changelog. Older entries must not satisfy a new release's GA status requirement.

### Rollback Verification

Rollback verification must use robust filesystem access checks instead of fragile mode-bit tests. Missing, stale, hash-drifted, or non-restorable backup manifests must return nonzero CLI status.

## Doctor Command

`legion doctor` should be a read-only diagnostic command. It should check:

- repository root exists;
- Git repository detection and current branch;
- project manifest presence;
- project validation result;
- `.legion/var/` ignore rule;
- Node and pnpm version compatibility;
- installed/source root availability;
- helper script availability;
- runtime directory writability;
- migration source readiness when legacy folders are present;
- JSON/human output health for the local CLI.

Doctor output should group checks into `pass`, `warn`, and `fail`. Any `fail` makes `ok: false` and exits nonzero. Warnings remain exit 0 unless paired with a failed check.

## Config And Defaults

This workstream may introduce a small config surface only if it reduces repeated flags without hiding behavior. Candidate config keys:

- default owner;
- default repository root behavior;
- default output mode;
- migration staging root;
- backup root.

Config must not store secrets. Config discovery and precedence must be explicit:

1. command flags;
2. project config;
3. user config;
4. inferred defaults.

If config adds meaningful implementation cost, defer it and keep flag-based defaults for this iteration.

## Documentation

The docs should stop leading with `node packages/cli/dist/index.js next ...` for normal users. They should instead document:

```powershell
legion init
legion status
legion validate
legion doctor
```

Docs should include copy-pasteable workflows for:

- first-time initialization;
- dry-run initialization;
- validating a repository;
- diagnosing a broken repository;
- migration preview, apply, and rollback;
- board task smoke test;
- release checklist;
- eval threat model;
- JSON automation examples.

Legacy namespace docs should move to a compatibility section.

## Testing Strategy

CLI e2e tests remain the main gate. Add focused regression coverage for:

- top-level `init`, `status`, `validate`, and `doctor`;
- inference of slug, name, default branch, remote URL, and owner;
- `init --dry-run` writes nothing;
- relative path inputs resolve against `--repository-root`;
- helper-backed failures return nonzero exit codes;
- redaction handles escaped JSON strings;
- already-redacted markers are ignored by credential audits;
- threat-model malformed helper output fails closed;
- release checklist scopes changelog status to the requested version;
- rollback verification fails closed for missing or drifted manifests;
- `legion next ...` compatibility aliases still route while producing deprecation diagnostics.

Recommended verification commands:

```powershell
pnpm --filter @legion/cli-e2e test
pnpm --filter @legion/artifacts test
pnpm run validate:next
```

The implementation plan may add narrower package tests as needed once the active PR branch is identified.

## Rollout Plan

1. Harden helper-backed correctness and security behavior.
2. Add shared path resolution and failure mapping utilities.
3. Promote top-level `legion init|status|validate`.
4. Add read-only `legion doctor`.
5. Add compatibility alias diagnostics for `legion next ...`.
6. Update docs and examples.
7. Run focused CLI e2e tests, package tests, and repository validation.

## Open Decisions

The implementation plan must decide:

- whether `legion doctor` ships in the same PR as top-level commands or one follow-up PR;
- whether config support is included now or deferred;
- whether compatibility aliases warn immediately or only after a transition period;
- how the root package binary maps from installed `legion` to the new command router.

These are implementation-slicing decisions. They do not change the user-facing design rule: normal command flow is `legion`, with no `next` or `ascended` namespace.
