# Legion Workflow Quickstart

This is the normal CLI path for a human-in-loop Legion project. The CLI writes durable state under `.legion/project`; typed engine operations remain available under `legion dev` for maintainers.

## Install

Use a first-class target unless you have a specific compatibility need:

```powershell
legion install --list-targets
legion install --target codex --local --dry-run
legion install --target codex --local
```

First-class targets expose one primary Legion entry point: `legion <command>` in the terminal, or a single `legion` skill/command/mode in the host. Compatibility, legacy, and manual-only targets are documented in `docs/cli/INSTALL-MATRIX.md` and shown with `legion install --list-targets --all-targets`.

## First Project Setup

```powershell
legion status
legion explore "clarify the first release slice" --executor fake
legion map --refresh
legion map --check
legion start --name "Asset Mapper" --summary "Metadata authoring and deterministic asset resolution" --owner dasbl
legion plan 1 --from-roadmap ROADMAP.md
legion status
```

Use `legion explore` or `legion map` before `legion plan` when the project needs discovery or codebase context. `legion map --query <text>` searches the latest generated map. Normal users should not edit worker bundle manifests or compute prompt hashes; those are `legion dev worker` extension workflows.

## Guidance Commands

```powershell
legion advise "release risk" --executor manual
legion learn "Prefer temp-clone dogfood before touching a real repo"
legion milestone --define MVP --phases 1-3
legion milestone --status
```

Guidance runs write `workflow-run.json` plus command-specific markdown under `.legion/project/workflow/<workflow>/<runId>/`. `manual` prepares prompts and artifacts without executing; `fake` is deterministic for tests.

Ad-hoc work still goes through the normal evidence gate:

```powershell
legion quick "fix the failing validation"
legion polish packages/cli
legion build --executor codex
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
