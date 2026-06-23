# Legion Workflow Quickstart

This is the normal CLI path for a human-in-loop Legion project. The CLI writes durable state under `.legion/project`; typed engine operations remain available under `legion dev` for maintainers.

## First Project Setup

```powershell
legion status
legion start --name "Asset Mapper" --summary "Metadata authoring and deterministic asset resolution" --owner dasbl
legion plan 1 --from-roadmap ROADMAP.md
legion status
```

Use `legion explore` or `legion map` before `legion plan` when the project needs discovery or codebase context. Normal users should not edit worker bundle manifests or compute prompt hashes; those are `legion dev worker` extension workflows.

## Guided Build And Review

```powershell
legion build --dry-run --json
git status
# Commit/stash generated workflow artifacts, or use --allow-dirty when the dirty state is intentional.
legion build --executor codex
legion review --executor codex
legion review --accept
```

Executors:

| Executor | Use |
| --- | --- |
| `codex` | Live implementation or review through `codex exec`. |
| `manual` | Prepare prompts, context packs, and evidence placeholders without executing. |
| `fake` | Deterministic test and dogfood runs. |

`legion build` blocks on a dirty git worktree unless you pass `--allow-dirty`. Use that override only when the current uncommitted state is intentional.

## Ship Readiness

```powershell
legion status
legion ship
legion retro
```

`legion ship` is a readiness gate in this layer. It verifies accepted build evidence and accepted review decisions; it does not publish, deploy, or release.

## Disposable Dogfood

Validate the full loop in a temporary workspace:

```powershell
pnpm workflow:dogfood
```

Validate against a temp clone of a real repo without mutating the original:

```powershell
pnpm workflow:dogfood -- --target "C:\Users\dasbl\Documents\Asset Mapper" --executor fake
```

Live Codex smoke checks are explicit:

```powershell
pnpm workflow:dogfood -- --target "C:\Users\dasbl\Documents\Asset Mapper" --executor codex --live-codex
```
