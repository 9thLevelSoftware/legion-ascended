# Legion Ascended

A guided execution layer for AI-assisted software work: human-in-loop, artifact-backed, and built
around one stable `legion` command surface.

The core workflow is:

```powershell
legion start -> legion plan -> legion build -> legion review -> legion ship
```

That sentence is the product contract. Host integrations, skills, commands, and compatibility aliases
are only wrappers around the same `legion <command>` language.

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

| Target | Runtime | Canonical entry |
| --- | --- | --- |
| `claude` | Claude Code | `/legion` |
| `codex` | OpenAI Codex CLI | local: `/project:legion`; global: `/prompts:legion` |
| `copilot` | GitHub Copilot CLI | `/legion` |
| `antigravity` | Antigravity CLI | `/legion` |
| `opencode` | OpenCode | `/legion` |
| `kilocode` | Kilo Code Plugin | Legion mode or `/legion` |

Compatibility, legacy, and manual-only targets install too, but they are not the default happy path.
Run `legion install --list-targets --all-targets` for the current list with tiers:

- **Compatible** — Kiro CLI (formerly Amazon Q Developer CLI), Cursor, Windsurf, Kilo CLI. Cursor and
  Windsurf are local-scope only and have no slash-command entry; you invoke Legion by asking for it
  in plain language.
- **Legacy** — Google Gemini CLI. Installs and works; not where new capability lands first.
- **Manual-only** — Aider. No installer support; wire it yourself.

Claude Desktop is documented in the install matrix but is **not an installable target** —
`legion install --target claude-desktop` reports an unknown target. It needs MCP or desktop-extension
packaging first. Claude Desktop is not Claude Code; the `claude` target above is Claude Code.

## Quickstart

The sequence below is the one `pnpm workflow:dogfood` drives end to end against a real repository, so
it is verified rather than aspirational.

```powershell
legion status
legion start                                    # asks the next intake question
legion start --answer "<node>=<value>"          # repeat until the interview is done
legion start --finalize                         # writes requirements, constitution, and ROADMAP.md
legion plan 1                                   # typed change bundle, oracle, and taskgraph
legion approve spec --approver <your-id>        # before the work, not after
legion build --executor codex
legion review --executor codex
legion review --accept --approver <your-id>
legion ship
```

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
| `R0` | 3 | A task contract or small-change record, deterministic verification, an evidence note. |
| `R1` | 5 | Adds a scoped implementer run, an evidence bundle, and a lightweight independent review. |
| `R2` | 7 | Approved delta specs, a protected oracle, a task contract, deterministic verification, task-level independent review, a real-interface or integration check, and whole-change acceptance. |
| `R3` | 10 | An independent baseline, spec **and** oracle approved before execution, a protected oracle, deterministic verification, an architecture or security review, protected acceptance tests, a security or E2E evaluator, explicit human approval, a release observation plan, and rollback or forward-fix evidence. |

R2 is what a normal planned phase gets by default, and the quickstart above satisfies all seven of its
gates. Note what R3 drops as well as what it adds: it does not ask for `approved_delta_spec` or
`whole_change_acceptance_evidence`, because `approved_spec_and_oracle` and `explicit_human_approval`
ask stricter versions of the same questions.

R3 needs the governance commands, which R2 does not use:

```powershell
legion attest independent-baseline --attested-by <id> --verdict pass --source <path>
legion attest security-evaluation  --attested-by <id> --verdict pass --source <path>
legion attest rollback-evidence    --attested-by <id> --verdict pass --source <path>
legion review --domain architecture --domain security --executor codex
legion release plan --environment staging --rollback-strategy revert `
  --health-criterion "<text>" --rollback-criterion "<text>"
```

Each of those writes a governance artifact and nothing else — it does not run the check it records.
`legion ship` re-verifies every content hash at read time, so a gate cannot be satisfied by a file
that has since changed. A change that genuinely deploys nothing waives the release gate through
`legion attest release-observation --verdict not_applicable`, which is audited rather than silent.

When a gate is satisfied by human judgement rather than a machine check, the ready payload says so in
`riskGates.waivedGates` and `riskGates.humanJudgementGates`. Ready never means "nothing was checked"
without saying which parts.

## Command Surface

### Core loop

| Command | Purpose |
| --- | --- |
| `legion start` | Run the intake interview; `--finalize` writes requirements, constitution, and ROADMAP.md |
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
| `legion map --refresh \| --check \| --query <text>` | Generate, verify, and search deterministic codebase context |
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

| Executor | Use |
| --- | --- |
| `codex` | Live execution and review through `codex exec` with workspace-write sandboxing |
| `manual` | Prompt, context, and evidence preparation without running an agent |
| `fake` | Deterministic tests and dogfood runs |

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
