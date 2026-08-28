# Legion Ascended

A guided execution layer for AI-assisted software work: human-in-loop, artifact-backed, and built
around one stable `legion` command surface.

The core workflow is:

```powershell
legion start -> legion plan -> legion build -> legion review -> legion ship
```

That sentence is the product contract. Host integrations, skills, commands, and compatibility aliases
are only wrappers around the same `legion <command>` language.

## Brownfield Assessment

`legion assess` performs a read-only brownfield assessment of an existing repository.
It produces evidence-bound audit reports without modifying source files or runtime configuration.

## What It Does

Legion Ascended is not an autonomous "build my app" button. It is a workflow system that interviews
you into a specification, turns that into typed task contracts, runs bounded executor-backed work,
collects evidence, and then refuses to call a change shippable until the evidence its risk tier
demands actually exists.

The last part is the point. `legion ship` does not ask "did someone approve this?" — it derives a set
of gates from the change's risk tier and reports each one as **satisfied**, **unsatisfied**, or
**unevaluable**. A gate with no evidence behind it blocks, because the absence of evidence is not
evidence of satisfaction.

What it deliberately does not do: publish, deploy, release, or run canary probes. `legion ship` is a
readiness verdict and nothing else.

The static product page lives at [docs/site/index.html](docs/site/index.html). The operator quickstart
is [docs/cli/WORKFLOW-QUICKSTART.md](docs/cli/WORKFLOW-QUICKSTART.md). Runtime support details are in
[docs/cli/INSTALL-MATRIX.md](docs/cli/INSTALL-MATRIX.md).

## Install

Requires Node.js `>=24 <26`.

`legion install` writes adapter and command files into an AI runtime's config directory. It does
**not** put a `legion` binary on your `PATH`, and neither does `npx` — so pick one of these two.

**Option A — no install, `npx` prefix on every call.** Nothing lands on `PATH`; `npx` runs the
package from a throwaway cache each time:

```powershell
npx legion-ascended
npx legion-ascended install --list-targets
npx legion-ascended install --target codex --local
```

**Option B — install globally once, then use the bare `legion` command.** This is the step that puts
`legion` on `PATH`:

```powershell
npm i -g legion-ascended@latest
legion install --list-targets
```

Either way, the full command surface is the same:

```powershell
legion install --list-targets --all-targets
legion install --target codex --explain
legion install --target codex --local --dry-run
legion install --target codex --local

# Grok Build: verify the host CLI, preview, then install its native Legion skill
grok --version
legion install --target grok --local --dry-run
legion install --target grok --local
```

Note that `--global` here means "install the adapter files into your home directory instead of the
current project" — it is a Legion scope flag, unrelated to `npm i -g`.

### What gets installed

By default, only the runtime entry points: a `/legion` command or skill for the target runtime, a
thin alias per workflow command, and a manifest. They dispatch to the `legion` CLI, which is where
the workflow engine actually lives. For Claude Code that is two files.

`--legacy-prompts` additionally installs the v8 markdown surface — 49 agent personas, 22 command
prompts, 33 skills, and 13 dispatch adapters, about 2.4 MB — and points the entry points at those
files instead of at the CLI. The CLI does not read them. Use it if you want the prompt-driven
agent-swarm workflow; otherwise you do not need it.

Recommended first-class targets:

| Target | Runtime | Canonical entry |
| --- | --- | --- |
| `claude` | Claude Code | `/legion` |
| `codex` | OpenAI Codex CLI | local: `/project:legion`; global: `/prompts:legion` |
| `copilot` | GitHub Copilot CLI | `/legion` |
| `antigravity` | Antigravity CLI | `/legion` |
| `opencode` | OpenCode | `/legion` |
| `hermes` | Hermes Agent | `/legion` |
| `grok` | Grok Build | `/legion` |
| `kilocode` | Kilo Code Plugin | Legion mode or `/legion` |

Compatibility, legacy, and manual-only targets are documented too, but they are not the default happy
path and the tiers mean genuinely different things. Run `legion install --list-targets --all-targets`
for the current list:

- **Compatible** — Kiro CLI (formerly Amazon Q Developer CLI), Cursor, Windsurf, Kilo CLI. Cursor and
  Windsurf are local-scope only and have no slash-command entry; you invoke Legion by asking for it
  in plain language.
- **Legacy** — Google Gemini CLI. Installs and works; not where new capability lands first.
- **Manual-only** — Aider. There is no installer for it; the tier name means exactly that. Wire it up
  yourself against the same `legion <command>` surface.

Claude Desktop is documented in the install matrix but is **not an installable target** —
`legion install --target claude-desktop` reports an unknown target. It needs MCP or desktop-extension
packaging first. Claude Desktop is not Claude Code; the `claude` target above is Claude Code.

## Semantic Map v2

The `map` command gives the workflow a deterministic, inspectable view of a repository before a human
plans or reviews a change. Release `9.4.0` ships Semantic Map v2 and the first-class Grok Build
install target and executor in the npm package, including the
published Tree-sitter WASM grammars used by the structural profile. It requires Node.js `>=24 <26`.

Install or update the global CLI with the current package:

```powershell
npm i -g legion-ascended@latest
```

Or run the packaged CLI without a global install:

```powershell
npx legion-ascended map --refresh --profile structural
```

### Refresh profiles and artifacts

`legion map --refresh` defaults to the `structural` profile. Both profiles preserve the legacy v1
file-inventory artifacts under `.legion/project/workflow/map/<runId>/`:

- `codebase.md` — human-readable file inventory
- `index.jsonl` — one v1 file record per line
- `symbols.json` — v1 symbol listing
- `search.md` — v1 search-oriented rendering
- `map.json` — the v1 machine-readable map and its source fingerprint

A structural refresh adds two Semantic Map v2 artifacts in that same run directory:

- `semantic-index.json` — the hash-pinned structural snapshot and durable authority for parsed coverage
  and facts
- `semantic-index.sqlite` — a local FTS5 acceleration of that snapshot, not a second source of truth

Use the inventory profile when a v1-only artifact set is required:

```powershell
legion map --refresh --profile structural
legion map --refresh --profile inventory
```

Structural extraction reports coverage per file, including `parsed`, `metadata-only`, `size-limited`,
`opaque`, `parser-error`, and `unsupported`. Parser errors remain visible and block the structural
refresh; they are not silently reported as parsed. The host-side architecture narrative is separate
from these CLI artifacts and belongs in `.planning/CODEBASE.md`.

### Check, query, and explain

`map --check`, `map --query`, and `map --why` are read-only. They do not append workflow runs or
rewrite map artifacts. They may read current source metadata and fingerprints to verify freshness.
Only `map --refresh` writes a new map run.

```powershell
# Check the legacy inventory profile by default; select structural explicitly when needed.
legion map --check
legion map --check --profile structural

# Search the newest valid structural index (the default when one exists).
legion map --query "resolve asset"
legion map --query "resolve asset" --profile structural

# Explain one structural symbol, import, or export fact.
legion map --why sym_<fact-id>
```

`map --check` reports `fresh`, `stale`, `partial`, or `absent`. Structural checks validate the
snapshot, its SQLite materialization, and the bound v1 `map.json` before reporting freshness. A
`map --query` uses the newest valid structural snapshot when one exists; if no structural snapshot
exists, it can fall back to the legacy v1 lexical query. Passing `--profile structural` requires a
valid structural snapshot. `--profile inventory` is valid only for inventory refreshes and inventory
freshness checks, not structural query or `--why` mode.

`map --why <fact-id>` requires a fresh structural snapshot. Fact IDs use `sym_`, `imp_`, or `exp_`
prefixes; `idx_` snapshot IDs are not fact IDs and are rejected. The response carries provenance such
as the snapshot, source path, source SHA-256, extractor version, and exact source range, but no raw
source text.

### Scope and review boundary

Use `--scope <path>` with refresh, check, or a bare summary when you need a scoped dataset. The
path must exist and remain inside the current project. A scoped refresh records that scope in the
artifacts; later query and why reads use the stored dataset and refuse `--scope`, so refresh with the
desired scope instead. `--why` also rejects `--refresh`, `--check`, `--query`, and inventory selection,
and each map invocation accepts only one mode.

A map result is **provenance and retrieval context, not behavioral proof**. It tells a human which
source bytes, symbols, imports, exports, and ranges were indexed. Open the cited files and verify
actual behavior before planning, changing, approving, or reviewing work. The human-review boundary
remains the workflow: use the map to focus inspection, then let `legion plan`, `legion build`,
`legion review`, and explicit human acceptance produce the evidence that `legion ship` evaluates.

## Quickstart

The sequence below is the one `pnpm workflow:dogfood` drives end to end against a real repository, so
it is verified rather than aspirational.

```powershell
legion status
legion start --goal "Map assets deterministically" # CLI preflight returns the exact preparation action
legion start --stage-draft .legion/var/intake-drafts/intake-draft.json # ignored input; validates and displays the grouped review
legion start --accept-draft                    # only after explicit human acceptance
legion start                                    # asks only the remaining intake question, or reports complete
legion start --answer "<node>=<value>"          # repeat until the interview is done
legion start --finalize                         # writes requirements, constitution, and ROADMAP.md
legion plan 1                                   # typed change bundle, oracle, and taskgraph
legion approve spec --approver <your-id>        # before the work, not after
legion build --executor codex
legion review --executor codex
legion review --accept --approver <your-id>
legion ship
```

`draft_review.nextAction.type` is `human_decision`, so hosts pause instead of
executing another bare start. Accept and discard are bound to the exact displayed
draft digest; replacement or evidence drift requires a new full review.

Two things in there are easy to get wrong.

**`legion approve spec` comes before `legion build`.** At R3 the `approved_spec_and_oracle` gate asks
whether the spec was approved *before* the work was executed, and compares timestamps: approving
afterwards records the approval and still leaves the gate unmet, with no way to repair the ordering
except re-planning. `legion build` itself does not enforce this — it will run unapproved — so the
order is yours to get right. A granted spec approval routes you straight back to `legion build`.

**`--approver` is not optional.** `legion review --accept` without it records the change as `ready`,
not `accepted` — a state that is short of a sign-off. `legion ship` then exits 1 on
`whole_change_acceptance_evidence` with "no named approver signed off", which is a change-scoped
verdict rather than a per-task one. The approver must be a human decision owner recorded in
`.legion/project/project.json`; no identity is inferred from the environment, from git config, or from
a project having only one owner. At R3 the stricter `explicit_human_approval` gate reads the approval
plane directly, so a review a tool accepted does not satisfy it.

`legion build` refuses a dirty worktree and routes to `legion build --allow-dirty`. Planning and
approval both write artifacts under `.legion/project`, so in practice you either commit those between
steps or pass `--allow-dirty` when the dirty state is intentional.

## Risk Tiers and Ship Gates

Every task carries a risk tier, chosen during intake. The tier derives which gates `legion ship`
requires — this is what makes the readiness verdict mean something.

Each tier names its **own** set — R3 is not R2 with extras, and the two overlap only partly. The
authoritative lists live in `DEFAULT_RISK_POLICY` (`packages/core/src/risk/`).

| Tier | Gates | What it asks for |
| --- | --- | --- |
| `R0` | 3 | A task contract *or* a small-change record, deterministic verification, and an evidence note. |
| `R1` | 5 | Tightens both of R0's loose arms — a real task contract, and an evidence bundle or log rather than a note — keeps deterministic verification, and adds a scoped implementer run and a lightweight independent review. |
| `R2` | 7 | Approved delta specs, a protected oracle, a task contract, deterministic verification, task-level independent review, a real-interface or integration check, and whole-change acceptance. |
| `R3` | 10 | An independent baseline, spec **and** oracle approved before execution, a protected oracle, deterministic verification, an architecture or security review, protected acceptance tests, a security or E2E evaluator, explicit human approval, a release observation plan, and rollback or forward-fix evidence. |

R2 is what a normal planned phase gets by default, and the quickstart above satisfies all seven of its
gates. Note what R3 drops as well as what it adds: it does not ask for `approved_delta_spec` or
`whole_change_acceptance_evidence`, because `approved_spec_and_oracle` and `explicit_human_approval`
ask stricter versions of the same questions.

R3 needs the governance commands, which R2 does not use:

```powershell
legion approve oracle --approver <your-id>       # R3 needs spec AND oracle, both before build
legion attest independent-baseline --attested-by <id> --verdict pass --source <path>
legion attest security-evaluation  --attested-by <id> --verdict pass --source <path>
legion attest rollback-evidence    --attested-by <id> --verdict pass --source <path>
legion review --domain architecture --domain security --executor codex
legion release plan --environment staging --rollback-strategy revert `
  --health-criterion "<text>" --rollback-criterion "<text>"
```

Each of those writes a governance artifact and nothing else — it does not run the check it records.
`legion ship` re-verifies every content hash at read time, so a gate cannot be satisfied by a file
that has since changed. A change that genuinely deploys nothing waives the release gate
instead, and the waiver is audited rather than silent:

```powershell
legion attest release-observation --attested-by <id> --verdict not_applicable `
  --source docs/decisions/no-deployment.md `
  --waiver-reason "This change ships no artifact and touches no deployed surface."
```

`--source` is required for every verdict including a waiver — a waiver still names the bytes it is
about — and `--waiver-reason` is required for `not_applicable`, refused for anything else, and must
be at least 24 characters and more than one word. A waiver is a reason a reviewer can disagree with,
which is a sentence rather than a token.

When a gate is satisfied by human judgement rather than a machine check, the ready payload says so in
`riskGates.waivedGates` and `riskGates.humanJudgementGates`. Ready never means "nothing was checked"
without saying which parts.

## Command Surface

### Core loop

| Command | Purpose |
| --- | --- |
| `legion start` | Prepare and review an intake draft, require explicit accept/revise/discard, then ask only unresolved questions; `--finalize` writes requirements, constitution, and ROADMAP.md |
| `legion plan <phase>` | Turn a roadmap phase into a change bundle, oracle, and typed taskgraph |
| `legion build` | Execute the latest taskgraph through an executor and collect evidence |
| `legion review` | Review collected evidence; `--accept --approver <id>` is the human boundary |
| `legion ship` | Report readiness against the derived risk gates. Publishes nothing |

### Governance

| Command | Purpose |
| --- | --- |
| `legion approve spec\|oracle\|surface\|protected-paths` | Record a human decision about part of the change |
| `legion attest <kind>` | Record that a named human asserts specific hash-pinned files are this change's evidence |
| `legion release plan` | Record how the release is observed and taken back |

### Guidance

These enrich the core loop without bypassing it. Runs write artifacts under
`.legion/project/workflow/<workflow>/<runId>/`, which later context packs read back.

| Command | Purpose |
| --- | --- |
| `legion explore <topic>` | Write a design discovery artifact; can seed an intake session |
| `legion map --refresh \| --check \| --query <text> \| --why <fact-id> [--profile inventory|structural]` | Generate, verify, search, and explain deterministic codebase context |
| `legion quick <task>` | One ad-hoc task with a task record and risk classification |
| `legion advise <topic>` | Read-only advisory analysis |
| `legion polish [target]` | Scoped cleanup as an ad-hoc workflow |
| `legion learn <lesson>` | Record durable operational learning |
| `legion retro` | Record retrospective evidence for future planning |
| `legion milestone` | Define, inspect, complete, and archive milestones |
| `legion council <topic>` | Structured governance deliberation |

### Diagnostics

| Command | Purpose |
| --- | --- |
| `legion status` | Current workflow state and the next recommended action |
| `legion validate` | Validate committed Legion project state |
| `legion doctor` | Project state plus `.legion/var` and bundle-index path presence |

Every workflow command above accepts `--json` for machine-readable output and `--repository-root
<path>` to operate on a repository other than the current directory. (`legion install` is the
installer router rather than a workflow command, and prints its own human-readable tables.) Workflow
commands declare the flags they read and refuse the rest, so a mistyped flag is an error rather than a
silently ignored argument.

Typed internals live under `legion dev` (`project`, `change`, `board`, `migrate`, `evals`, `release`,
`worker`). Normal use should not require authoring worker manifests or computing prompt hashes.

## Executors

`--executor` selects the driver that does the work. With the flag omitted, the first installed one wins:
`claude`, then `codex`, `hermes`, `grok`, then `manual`.

| Executor | Use |
| --- | --- |
| `claude` | Live execution and review through Claude Code's headless JSON surface |
| `codex` | Live execution and review through `codex exec` with workspace-write sandboxing |
| `hermes` | Live execution and review through `hermes chat -q` |
| `grok` | Grok Build headless JSON through `grok --prompt-file <promptAbsolutePath> --cwd <repositoryRoot> --output-format json --permission-mode bypassPermissions` |
| `manual` | Prompt, context, and evidence preparation without running an agent |
| `fake` | Deterministic tests and dogfood runs |

Grok Build authentication remains owned by Grok: Legion only performs the bounded `grok --version`
detection probe and never stores, reads, or transmits browser login state or `XAI_API_KEY`. The verified
Grok CLI is an upstream alpha, so this release keeps that caveat explicit even though the Legion install
and executor are first-class. Grok has no native parallel-subagent primitive; the execution mode is
sequential, so `legion build --executor grok` and `legion review --executor grok` run one bounded
process at a time.

Install and invoke it explicitly:

```powershell
grok --version
legion install --target grok --local
legion build --executor grok
legion review --executor grok
```

Every writable dispatch goes through one guarded path. Control artifacts under `.legion/project` are
snapshotted before the run and restored afterwards; a run that modifies them is blocked and told
which paths it touched. Declared acceptance tests are watched and *reported* rather than restored,
because a task may legitimately add one — the gate decides, the harness only observes.

## Where State Lives

Legion writes project state under `.legion/project`:

- project metadata, requirements, current specs, changes, oracles, and taskgraphs
- task-run artifacts, context packs, executor prompts, executor results, and redacted logs
- evidence indexes, review decisions, approvals, attestations, and release plans
- lessons, milestones, maps, retrospectives, and guidance runs

These are durable artifacts, not conversational memory. The workflow's answer to "what happened" is
always a file with a hash, which is what lets a later command re-verify a claim instead of trusting it.

## Development

Prerequisites:

- Node.js `>=24 <26`
- pnpm `>=11.4 <12`
- On Windows, **symlink creation privilege** — see below

Useful verification commands:

```powershell
pnpm install
pnpm run build
pnpm run validate:next        # the full gate: typecheck, boundaries, schemas, tests, packaging
pnpm test
pnpm workflow:dogfood         # drives the whole workflow against a temp repository
```

Dogfood a real repository without mutating it:

```powershell
pnpm workflow:dogfood -- --target "C:\path\to\some\repo" --executor fake
```

### Running the tests on Windows

Seven tests guard symlink-shaped attacks: an executor planting a link inside the protected control
tree, a pinned reference whose path leaves the repository through one, a protected acceptance test
swapped for a link whose bytes still match. Each needs to create a real file symlink first.

Windows refuses `symlink(2)` with `EPERM` unless the process holds `SeCreateSymbolicLinkPrivilege`.
Grant it once:

- **Settings > System > For developers > Developer Mode: On**, or
- run the test suite from an elevated shell.

Without it the suite **fails** rather than skipping, and prints these steps. That is deliberate: a
security boundary that quietly stops being tested is worse than a red build, because the red build
gets fixed.

If you cannot enable Developer Mode:

```powershell
$env:LEGION_ALLOW_SYMLINK_SKIP=1; pnpm test
```

Those seven then skip, each naming the errno and printing a `COVERAGE GAP` diagnostic. The
directory-link test runs either way, because Windows junctions need no privilege. Use the opt-out to
get unblocked locally, not to land a change: CI runs the full set on Linux, macOS, and Windows.

## Package Layout

```text
bin/                     CLI entrypoints and installer runtime registry
packages/protocol/       Shared schemas, protocol entities, and version upcasts
packages/core/           Risk policy, gate derivation, and state machines
packages/artifacts/      Typed .legion/project artifact services
packages/cli/            Workflow commands, executor adapters, context packs, ship gates
packages/board/          Kanban projections and portfolio reducers
packages/board-store/    Event-store contracts for board state
packages/store-sqlite/   SQLite-backed board and event storage
packages/legacy-bridge/  Importers for v8 and .planning/ project state
packages/runtime-eve/    Runtime driver integration
apps/cli-e2e/            End-to-end CLI tests
adapters/ agents/ skills/ commands/   Host integration assets installed into targets
docs/cli/                Packaged operator docs and install matrix
docs/site/               Self-contained static website
evals/                   Behavioral eval corpus and held-out fixtures
scripts/                 Validation, dogfood, release, and packaging tools
tests/                   Regression tests for CLI, artifacts, packaging, and docs
```

## The Tithe

The Legion asks not for blood, but for sustenance. Those who have commanded the many and found them
worthy may offer tribute, that the voices may continue to serve.

[Make an Offering](https://ko-fi.com/vitruvianredux)

Your sacrifice sustains the many.

## License

MIT
