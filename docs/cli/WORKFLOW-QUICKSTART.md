# Legion Workflow Quickstart

This is the normal CLI path for a human-in-loop Legion project. The CLI writes durable state under `.legion/project`; typed engine operations remain available under `legion dev` for maintainers.

## Install

Use a first-class target unless you have a specific compatibility need:

```powershell
legion install --list-targets
legion install --target codex --local --dry-run
legion install --target codex --local

# Grok Build is a first-class Legion target; the upstream CLI remains alpha
# Verify the installed CLI before installing Legion's native skill surface
grok --version
legion install --target grok --local --dry-run
legion install --target grok --local
```

First-class targets, including Grok Build, expose one primary Legion entry point: `legion <command>` in the terminal, or a single `legion` skill/command/mode in the host. Compatibility, legacy, and manual-only targets are documented in `docs/cli/INSTALL-MATRIX.md` and shown with `legion install --list-targets --all-targets`.

## First Project Setup

```powershell
legion status
legion explore "clarify the first release slice" --executor fake
legion explore "compare the implementation options" --executor grok
legion start --goal "Metadata authoring and deterministic asset resolution"
legion map --refresh --scope .                 # only when start returns map_refresh_required
legion start --stage-draft .legion/var/intake-drafts/intake-draft.json # ignored host input from the review contract
legion start --accept-draft                    # only after the complete grouped review is displayed and accepted
legion start                                   # remaining question or complete
legion start --answer "<node>=<value>"         # repeat only for unresolved graph nodes
legion start --finalize
legion plan 1 --from-roadmap ROADMAP.md
legion status
```

Bare `legion start --json` owns preflight, map freshness, draft/session state, and the next exact action. The staged response groups requirements, executable proofs, constraints/non-goals, risk/budget/verification defaults, deduplicated evidence paths/kinds/hashes/anchors, diagnostics, and unresolved items. Its `nextAction.type` is `human_decision`: pause for the operator rather than executing it. Revise by staging and displaying a new draft ID; discard with `legion start --discard-draft`; neither staging nor silence is acceptance. Active and supplied-ID decisions are bound to the exact displayed digest, so stale or undisplayed bytes are rejected.

Compose draft input under `.legion/var/intake-drafts/`. That runtime-input directory is excluded from authored-source mapping, so writing the requested JSON after `legion map --refresh --scope .` does not immediately stale the map evidence it cites.

Preparation selectors and edits are valid only during bare preparation or alongside `--stage-draft`; persist them first, then enter the interview with a later `--next`. `--accept-draft` and `--discard-draft` are terminal decisions and reject combinations with preparation selectors, `--next`, `--session`, or another action before changing lifecycle state.

Use `legion explore` before start when discovery is useful; start can automatically select a compatible completed exploration, select one explicitly with `--from-exploration`, or opt out with `--without-exploration`. `legion map --query <text>` searches the latest generated map. Direct `legion start --name ...` initialization remains available for callers that intentionally want no intake requirements. Normal users should not edit worker bundle manifests or compute prompt hashes; those are `legion dev worker` extension workflows.

Use `legion assess` for a read-only brownfield assessment that produces evidence-bound audit reports without modifying source files or runtime configuration.

## Guidance Commands

```powershell
legion advise "release risk" --executor manual
legion learn "Prefer temp-clone dogfood before touching a real repo"
legion milestone --define MVP --phases 1-3
legion milestone --status
```

Guidance runs write `workflow-run.json` plus command-specific markdown under `.legion/project/workflow/<workflow>/<runId>/`. `manual` prepares prompts and artifacts without executing; `fake` is deterministic for tests.

## Executors

`--executor` selects the driver that does the work. With the flag omitted, the first installed one wins: `claude`, then `codex`, `hermes`, `grok`, then `manual`.

| Executor | What runs the task |
| --- | --- |
| `claude` | Claude Code, headless (`claude --print --output-format json`). `LEGION_CLAUDE_EXEC_TIMEOUT_MS` overrides the 15-minute cap. |
| `codex` | Codex CLI (`codex exec`). `LEGION_CODEX_EXEC_TIMEOUT_MS` overrides the 5-minute cap. |
| `hermes` | Hermes Agent (`hermes chat -q`). `LEGION_HERMES_EXEC_TIMEOUT_MS` overrides the 10-minute cap. |
| `grok` | Grok Build headless JSON (`grok --prompt-file <promptAbsolutePath> --cwd <repositoryRoot> --output-format json --permission-mode bypassPermissions`). `LEGION_GROK_EXEC_TIMEOUT_MS` overrides the 10-minute cap. The upstream Grok CLI is alpha, but the Legion install target and executor are first-class. Grok has no native parallel-subagent primitive, so Legion runs this path sequentially. |
| `manual` | Nothing. It writes the instruction prompt, records `blocked`, and leaves the work to you. |
| `fake` | A scripted in-memory adapter, for tests. |

Two things worth knowing before relying on the default:

- **Grok owns authentication.** Legion only runs the bounded `grok --version` detection probe and never reads or transmits browser login state or `XAI_API_KEY`. Local installs write `.grok/skills/legion/SKILL.md`; global installs write `$GROK_HOME/skills/legion/SKILL.md`, falling back to `<home>/.grok` when `GROK_HOME` is unset.
- **Grok execution is sequential.** `legion build --executor grok` and `legion review --executor grok` invoke one bounded headless process at a time. The completed `--output-format json` envelope is normalized by Legion; `streaming-json`/ACP NDJSON is not treated as a Legion result in this release.

- **Inside a Claude Code session, auto-selection skips `claude`.** The installed `/legion` entry point runs `legion build` from within such a session, and auto-selecting there would spawn a second agent with permissions bypassed to do work the agent that asked for it could do itself. You get `manual` instead, whose prompt artifact hands the task to the session you are already in. `--executor claude` is still honored when you ask for it by name.
- **`--executor claude` runs with `--permission-mode bypassPermissions`,** matching the codex adapter's `approval_policy="never"` — there is no human attached to answer a prompt. A read-only run additionally denies `Edit`, `Write`, and `NotebookEdit`. Claude Code has no OS-level sandbox flag, so unlike codex's `--sandbox read-only` a `Bash` command that writes is not refused; the guarded-execution harness is what keeps such a write out of the evidence.

Ad-hoc work still goes through the normal evidence gate:

```powershell
legion quick "fix the failing validation"
legion polish packages/cli
legion build --executor codex
legion build --executor grok
```

## Approving Delta Specs

`legion plan` writes one delta spec per requirement — the proposed change to that requirement's specification — and nothing approves them by default. An R2 change cannot ship until every one carries a granted approval, so this step sits between planning and building:

```powershell
legion approve spec --dry-run --approver dasbl --json
legion approve spec --approver dasbl
```

`--approver` names a human recorded in the project manifest's `policy.decisionOwners`. No approver is inferred from the environment, from git config, or from a project having only one owner. The dry run resolves the approver and shows exactly which bytes would be pinned, so a mistyped id fails before anything is written.

The approval records the delta spec's content hash, and `legion ship` re-hashes the file before it trusts the approval. In practice an edited delta spec is caught earlier still: the change bundle also pins those bytes, so a spec changed after planning stops the change loading at all and `legion ship` reports `delta_artifact_mismatch` rather than an unmet gate. Nothing in Legion rewrites a delta spec — `legion plan` is create-only — so the repair is to restore the file, not to re-approve it, and `legion approve spec` refuses to launder an out-of-band edit into a governance record.

Re-running after a successful approval reports `unchanged` and rewrites nothing. If the approval on disk is anything the gate would not accept — withdrawn, expired, or edited so it no longer pins the spec — the rerun re-grants it instead; a withdrawn decision is copied to its own file first, so re-approving supersedes it rather than erasing it. Changes built by `legion plan` carry a single requirement today; on a change with more than one, `legion approve spec --requirement <id>` approves just that one and the payload's `unapproved` list names the requirements still without a grant.

## Declaring And Maintaining A Verification Surface

At `legion start --intake`, each executable acceptance criterion can declare what its command actually reaches — `unit`, `integration`, `real-interface` or `end-to-end` — the interface it reaches, why reaching it catches something a smaller check would miss, and the repository files that make that true. The surface is **declared, never inferred from the command string**: `pnpm test --filter integration` may be a pure unit suite and `node scripts/smoke.mjs` may drive a live database, so inference misclassifies in both directions and does so silently.

The declaration is optional. Skipping it leaves `integration_or_real_interface_checks` reporting `unevaluable` at R2 — nobody said, so nothing is known. Declaring `unit` on every criterion of a change is a *recorded negative* and reports `unsatisfied`: a change that states it crosses no boundary has answered the question, and the answer is no. The determination is made for the change as a whole, so one honest `unit` criterion alongside one that reaches a real interface does not block anything.

The pinned files are hashed three times: when the declaration is authored, while the verification command runs, and again at `legion ship`. The middle one is what makes the claim mean something — without it, a passing check established only that the declared bytes are on disk *now*, so swapping the compose file for one naming an in-memory fake, building, and reverting the swap would go unnoticed.

When you legitimately edit a pinned file — bumping the image tag on the service the integration check stands up — the gate stops believing the declaration, and that is the gate working. The way back is a decision, not a rewrite:

```powershell
legion approve surface --dry-run --approver dasbl --json
legion approve surface --approver dasbl
```

This records a named human saying the declaration still describes what they meant, against the bytes on disk now. It re-affirms only pins that have actually drifted, covers exactly one revision of each file — edit it again and the gate blocks again — and refuses a pinned file that is not there. No command re-mints a pin silently: that would launder an out-of-band edit into a declaration.

## Guided Build And Review

```powershell
legion build --dry-run --json
git status
# Commit/stash generated workflow artifacts, or use --allow-dirty when the dirty state is intentional.
legion build --executor codex
legion review --executor codex
legion review --accept --approver dasbl
```

`--executor` takes `claude`, `codex`, `hermes`, `grok`, `manual`, or `fake`; see [Executors](#executors) above for what each one runs and what the default probes. Omitting `--approver` on the accept still exits 0 but records no human, which costs `whole_change_acceptance_evidence` at ship.

`legion build` blocks on a dirty git worktree unless you pass `--allow-dirty`. Use that override only when the current uncommitted state is intentional.

## Ship Readiness

```powershell
legion status
legion ship
legion retro
```

`legion ship` is a readiness gate in this layer. It requires accepted build evidence and an accepted review decision before it evaluates anything, then derives the ADR-006 gate set for each task's risk tier and reports every gate's verdict. It does not publish, deploy, or release.

### The R2 path, end to end

Every R2 gate has a producer, so an R2 change reaches `ready`. The commands, in the order they have to run:

```powershell
legion start --intake intake.json      # risk-tier R2, one executable criterion, a declared surface
legion start --finalize
legion plan 1
legion approve spec --approver dasbl   # approved_delta_spec
legion build --executor codex          # protected_oracle, deterministic_verification, the surface check
legion review --executor codex
legion review --accept --approver dasbl # whole_change_acceptance_evidence
legion ship
```

Two of those are easy to leave out and each costs a gate. Without `--approver` on the accept the command still exits 0, but the acceptance records no human and `whole_change_acceptance_evidence` reports `unevaluable`. Without an executable criterion declaring a non-unit surface, `protected_oracle` and `integration_or_real_interface_checks` have nothing to read. R3 additionally needs `legion approve oracle`, `legion attest`, `legion review --domain` and `legion release plan`.

`riskGates.satisfied` is not by itself the claim: a gate satisfied by an audited `not_applicable` waiver, by a human-judgement attestation, or by a re-affirmed verification-surface pin is counted there too. `riskGates.waivedGates` and `riskGates.humanJudgementGates` name every gate whose `satisfied` rests on a named person's decision standing in for a check, and the same gates are echoed as `risk_gate_waived` and `risk_gate_human_judgement` warnings.

The pin case is the one to know about, because it is reachable at R2 and it looks like nothing. `legion approve surface --approver <id>` is the recovery for a declared surface whose pinned file was edited after the check ran; it re-affirms the declaration against the bytes now on disk and does not re-run anything. The ship comes back `ready`, and `humanJudgementGates` is where it says at what cost.

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
