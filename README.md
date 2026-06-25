# Legion Ascended

Legion is still Legion. Ascended is the new version and product treatment, not a new command namespace. The tool is a guided execution layer for AI-assisted software work: human-in-loop, artifact-backed, and built around one stable `legion` command surface.

The core workflow is:

```powershell
legion start -> legion plan -> legion build -> legion review -> legion ship
```

That sentence is the product contract. Host integrations, skills, commands, and compatibility aliases are only wrappers around the same `legion <command>` language.

## What It Does

Legion Ascended is not an autonomous "build my app" button. It is a workflow system that helps you keep context fresh, prepare executable taskgraphs, run bounded executor-backed work, collect evidence, submit structured reviews, and decide when the work is ready to ship.

It writes project state under `.legion/project`, including:

- project metadata, current specs, changes, oracles, and taskgraphs
- task-run artifacts, context packs, executor prompts, executor results, and redacted logs
- evidence indexes, review decisions, lessons, milestones, maps, retrospectives, and guidance runs

The static product page lives at [docs/site/index.html](docs/site/index.html). The operator quickstart is [docs/cli/WORKFLOW-QUICKSTART.md](docs/cli/WORKFLOW-QUICKSTART.md). Runtime support details are in [docs/cli/INSTALL-MATRIX.md](docs/cli/INSTALL-MATRIX.md).

## Install

First-run bootstrap, before `legion` is on `PATH`:

```powershell
npx legion-ascended install --list-targets
npx legion-ascended install --target codex --local
```

After installation, use the installed `legion` command:

```powershell
legion install --list-targets
legion install --list-targets --all-targets
legion install --target codex --explain
legion install --target codex --local --dry-run
legion install --target codex --local
```

Recommended first-class targets:

| Target | Runtime | Canonical experience |
| --- | --- | --- |
| `claude` | Claude Code | One `/legion` workflow entrypoint plus aliases |
| `codex` | OpenAI Codex CLI | One `legion` bridge skill plus local/global prompt wrapper |
| `copilot` | GitHub Copilot CLI | Legion skill plus custom agent profile |
| `antigravity` | Antigravity CLI | Legion plugin with skills, agents, and command aliases |
| `opencode` | OpenCode | One `/legion` command plus a Legion subagent |
| `kilocode` | Kilo Code Plugin | Legion mode or `/legion` workflow plus Agent Skills |

Compatibility, legacy, and manual-only targets are still documented and can be requested explicitly, but they are not the default happy path: Cursor, Google Gemini CLI, Kiro CLI (formerly Amazon Q Developer CLI), Windsurf, Kilo CLI, Aider, and Claude Desktop.

## Getting Started

```powershell
legion status
legion start --name "My Project" --summary "What this project is trying to accomplish" --owner dasbl
legion plan 1 --from-roadmap ROADMAP.md
git status
# Commit/stash generated workflow artifacts, or use --allow-dirty when the dirty state is intentional.
legion build --executor codex
legion review --executor codex
legion review --accept
legion ship
```

`legion build` executes the latest typed taskgraph through an adapter and records pending evidence. `legion review` submits structured review decisions. `legion review --accept` is the explicit human approval boundary. `legion ship` is a readiness gate; it does not publish, deploy, or release.

Executors:

| Executor | Use |
| --- | --- |
| `codex` | Live execution and review through `codex exec` with workspace-write sandboxing |
| `manual` | Prompt, context, and evidence preparation without running an agent |
| `fake` | Deterministic tests and dogfood runs |

## Claude Opus 4.7 Hardening

Legion Ascended keeps the hot path small for literal, high-context models: the CLI resolves typed state first, builds focused context packs, loads guidance records only when useful, and records evidence instead of relying on conversational memory. Host-specific prompt aliases remain compatibility details; the durable workflow state is the source of truth.

## Guidance Layer

These commands enrich the core loop without bypassing it:

| Command | Purpose |
| --- | --- |
| `legion explore <topic>` | Write a design discovery artifact with approaches, constraints, questions, and handoff notes |
| `legion map --refresh` / `--check` / `--query` | Generate, verify, and search deterministic codebase map artifacts |
| `legion quick <task>` | Create a typed ad-hoc change and one-task taskgraph for `legion build` |
| `legion advise <topic>` | Produce read-only advisory guidance and decision notes |
| `legion learn <lesson>` | Record durable lessons that future context packs can use |
| `legion retro` | Analyze accepted/rejected evidence and write follow-up guidance |
| `legion milestone` | Define, inspect, complete, and archive project milestones |
| `legion council <topic>` | Record structured governance deliberation |
| `legion polish [target]` | Create a scoped polish taskgraph for the normal build/review path |

Guidance runs write artifacts under `.legion/project/workflow/<workflow>/<runId>/`. The context-pack generator reads those artifacts back into later planning, build, and review prompts.

## Workflow Reference

#### `legion start` (alias: `/legion:start`)

Initializes typed project state under `.legion/project/project.json` and routes to planning. Use it once per project after any optional `legion explore` or `legion map --refresh` discovery.

#### `legion plan` (alias: `/legion:plan`)

Turns a roadmap phase or ad-hoc request into current specs, a change record, an oracle, and a typed taskgraph that `legion build` can execute.

#### `legion build` (alias: `/legion:build`)

Loads the latest typed taskgraph, blocks dirty worktrees unless `--allow-dirty` is supplied, generates task context packs, and executes it through the selected executor adapter with durable evidence.

#### `legion review` (alias: `/legion:review`)

Reads the latest task runs and evidence index, submits structured review decisions against collected build evidence, and leaves acceptance to the human boundary at `legion review --accept`.

#### `legion ship` (alias: `/legion:ship`)

Checks ship readiness from accepted evidence and accepted review decisions. It reports readiness only; publishing and deployment stay outside this layer.

## v2.0 Advisory Features

The guidance layer adds discovery, maps, advice, lessons, retrospectives, milestones, and council decisions as first-class workflow artifacts. These commands inform the core loop, but they do not replace `plan -> build -> review -> ship`.

## Development

Prerequisites:

- Node.js `>=24 <26`
- pnpm `>=11.4 <12`

Useful verification commands:

```powershell
pnpm run build
node --test tests/cli-workflow-ux.test.mjs
node --test tests/workflow-guidance.test.mjs
pnpm workflow:dogfood
pnpm run validate:next
npm pack --dry-run --json
pnpm pack --dry-run
```

Dogfood a real repository without mutating it:

```powershell
pnpm workflow:dogfood -- --target "C:\Users\dasbl\Documents\Asset Mapper" --executor fake
```

## Package Layout

```text
bin/                    CLI entrypoints and installer runtime registry
packages/cli/           Workflow commands, executor adapters, context packs, and status/ship gates
packages/artifacts/     Typed .legion/project artifact services
packages/protocol/      Shared schemas and protocol entities
docs/cli/               Packaged operator docs and install matrix
docs/site/              Self-contained Legion Ascended static website
scripts/                Validation, dogfood, release, and package verification tools
tests/                  Node regression tests for CLI, artifacts, packaging, and docs
```

Typed internals and worker-bundle authoring live under `legion dev`. Normal users should not need to author worker manifests, compute prompt hashes, or manage bundle contracts by hand.

## The Tithe

The Legion asks not for blood, but for sustenance. Those who have commanded the many and found them worthy may offer tribute, that the voices may continue to serve.

[Make an Offering](https://ko-fi.com/vitruvianredux)

Your sacrifice sustains the many.

## License

MIT
