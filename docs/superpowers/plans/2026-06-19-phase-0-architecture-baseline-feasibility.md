# Phase 0 Architecture Baseline Feasibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute Phase 0 for Legion Next by establishing rewrite governance, freezing and measuring v8, approving architecture decisions, completing storage and Eve feasibility spikes, and producing an explicit go/no-go handoff for Phase 1.

**Architecture:** Phase 0 is a governance and evidence phase, not the v9 product build. The new repository owns Phase 0 ledgers, ADRs, evidence indexes, spike outputs, review records, backlog, and handoff artifacts; the original v8 repository remains a read-only reference except for explicitly approved baseline capture work. Each task maps to the authoritative P00 task contract in the rebuild package and commits one coherent evidence-backed result.

**Tech Stack:** Git, PowerShell, Markdown, YAML, Node/npm for v8 verification, shell transcripts for evidence capture, and bounded spike prototypes under `spikes/storage` and `spikes/eve` only after the relevant ADR task authorizes their exact tool choices.

---

## Source Documents

Authoritative sources for every task:

- Roadmap: `C:/Users/dasbl/Documents/Legion Retooled/docs/legion-next-roadmap.md`
- Phase 0 contract: `C:/Users/dasbl/Documents/legion/docs/rebuild/00-phase-architecture-contract-baseline-and-rewrite-guardrails.md`
- Transformation plan: `C:/Users/dasbl/Documents/legion/docs/rebuild/legion-next-transformation-plan.md`
- Dependency map: `C:/Users/dasbl/Documents/legion/docs/rebuild/CROSS-PHASE-DEPENDENCY-MAP.md`
- Execution guide: `C:/Users/dasbl/Documents/legion/docs/rebuild/AGENT-EXECUTION-GUIDE.md`
- v8 local reference: `C:/Users/dasbl/Documents/legion`
- v8 remote reference: `https://github.com/9thLevelSoftware/legion`

If any listed source is missing or materially contradicts the current checkout, stop and record `BLOCKED` in the phase ledger.

## File Structure

Phase 0 creates or modifies only these surfaces unless the Phase 0 source contract explicitly requires a narrower task-specific path:

- `.legion/project/changes/LEGION-NEXT/implementation/phase-00/ledger.yaml` - durable phase ledger.
- `.legion/project/changes/LEGION-NEXT/implementation/phase-00/HANDOFF.md` - Phase 1 handoff.
- `.legion/project/changes/LEGION-NEXT/implementation/phase-00/evidence-index.yaml` - canonical index of evidence artifacts.
- `docs/next/README.md` - entry point for Legion Next governance docs.
- `docs/next/REWRITE-CHARTER.md` - rewrite boundary, roles, governance, and phase gates.
- `docs/next/V8-MAINTENANCE-POLICY.md` - frozen v8 maintenance policy.
- `docs/next/PHASE-00-DECISION.md` - final go/no-go decision.
- `docs/next/IMPLEMENTATION-BACKLOG.yaml` - Phase 1 and later backlog produced from accepted ADRs.
- `docs/next/DEPENDENCY-MAP.md` - implementation dependency map.
- `docs/next/adr/ADR-001-runtime-product.md` through `docs/next/adr/ADR-008-local-store.md` - accepted architecture decision records.
- `docs/next/baseline` - baseline reports, scoring rubric, and aggregate summaries.
- `docs/next/spikes` - spike decision reports and comparison matrices.
- `docs/next/reviews` - premortem, findings register, and independent phase review.
- `evals/baseline` - v8 benchmark corpus, fixture hashes, run manifests, and scoring outputs.
- `spikes/storage` - storage spike prototypes and fault tests.
- `spikes/eve` - Eve public-contract spike prototype and event captures.

Do not create v9 product packages such as `packages/protocol`, `packages/core`, `apps/daemon`, or `workers` during Phase 0. Those begin in later phases after the Phase 0 go/no-go gate.

## Task 1: Bootstrap Phase 0 Branch, Ledger, and Preflight Evidence

**Files:**
- Create: `.legion/project/changes/LEGION-NEXT/implementation/phase-00/ledger.yaml`
- Create: `.legion/project/changes/LEGION-NEXT/implementation/phase-00/evidence-index.yaml`
- Create: `docs/next/README.md`
- Create: `docs/next/evidence/P00-PREFLIGHT/preflight.log`
- Modify: no existing files

- [ ] **Step 1: Create the Phase 0 branch**

Run from `C:/Users/dasbl/Documents/Legion Retooled`:

```powershell
git status --short --branch
git switch -c legion-next/phase-00
git status --short --branch
```

Expected: the first status shows a clean working tree on `master`; the final status shows `legion-next/phase-00`.

- [ ] **Step 2: Create Phase 0 directories**

```powershell
$dirs = @(
  '.legion/project/changes/LEGION-NEXT/implementation/phase-00',
  'docs/next/evidence/P00-PREFLIGHT',
  'docs/next/adr',
  'docs/next/baseline',
  'docs/next/spikes',
  'docs/next/reviews',
  'evals/baseline',
  'spikes/storage',
  'spikes/eve'
)
foreach ($dir in $dirs) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}
```

Expected: all directories exist under the new implementation repository.

- [ ] **Step 3: Write the bootstrap ledger**

```powershell
$baseCommit = git rev-parse HEAD
$sourceDocument = 'C:/Users/dasbl/Documents/legion/docs/rebuild/00-phase-architecture-contract-baseline-and-rewrite-guardrails.md'
$ledger = @"
phase: 0
phase_id: P00
status: NOT_STARTED
source_document: "$sourceDocument"
base_commit: "$baseCommit"
started_at: null
completed_at: null
active_wave: null
tasks:
  P00-T01: { status: NOT_STARTED, run_id: null, commit: null }
  P00-T02: { status: NOT_STARTED, run_id: null, commit: null }
  P00-T03: { status: NOT_STARTED, run_id: null, commit: null }
  P00-T04: { status: NOT_STARTED, run_id: null, commit: null }
  P00-T05: { status: NOT_STARTED, run_id: null, commit: null }
  P00-T06: { status: NOT_STARTED, run_id: null, commit: null }
  P00-T07: { status: NOT_STARTED, run_id: null, commit: null }
  P00-T08: { status: NOT_STARTED, run_id: null, commit: null }
  P00-T09: { status: NOT_STARTED, run_id: null, commit: null }
  P00-T10: { status: NOT_STARTED, run_id: null, commit: null }
decisions: []
blockers: []
evidence:
  - docs/next/evidence/P00-PREFLIGHT/preflight.log
"@
Set-Content -Path '.legion/project/changes/LEGION-NEXT/implementation/phase-00/ledger.yaml' -Value $ledger -Encoding utf8
```

Expected: `ledger.yaml` contains the current repository commit as `base_commit` and every P00 task in `NOT_STARTED`.

- [ ] **Step 4: Write the evidence index**

```powershell
$evidenceIndex = @"
phase: 0
phase_id: P00
source_documents:
  roadmap: C:/Users/dasbl/Documents/Legion Retooled/docs/legion-next-roadmap.md
  phase_contract: C:/Users/dasbl/Documents/legion/docs/rebuild/00-phase-architecture-contract-baseline-and-rewrite-guardrails.md
  transformation_plan: C:/Users/dasbl/Documents/legion/docs/rebuild/legion-next-transformation-plan.md
  dependency_map: C:/Users/dasbl/Documents/legion/docs/rebuild/CROSS-PHASE-DEPENDENCY-MAP.md
  execution_guide: C:/Users/dasbl/Documents/legion/docs/rebuild/AGENT-EXECUTION-GUIDE.md
entries:
  - task: P00-PREFLIGHT
    artifact: docs/next/evidence/P00-PREFLIGHT/preflight.log
    description: Phase 0 source, repository, and v8 preflight capture
"@
Set-Content -Path '.legion/project/changes/LEGION-NEXT/implementation/phase-00/evidence-index.yaml' -Value $evidenceIndex -Encoding utf8
```

Expected: `evidence-index.yaml` names every source document used to start Phase 0.

- [ ] **Step 5: Write the Legion Next docs entry point**

```powershell
$readme = @"
# Legion Next

This directory contains governance, decisions, evidence, spikes, reviews, and handoffs for the Legion Next rewrite.

Authoritative phase execution starts from:

- Roadmap: C:/Users/dasbl/Documents/Legion Retooled/docs/legion-next-roadmap.md
- Phase 0 contract: C:/Users/dasbl/Documents/legion/docs/rebuild/00-phase-architecture-contract-baseline-and-rewrite-guardrails.md
- Transformation plan: C:/Users/dasbl/Documents/legion/docs/rebuild/legion-next-transformation-plan.md

The original v8 repository at C:/Users/dasbl/Documents/legion is a reference and baseline source. Do not mutate it from this repository except through an explicitly approved Phase 0 baseline task.
"@
Set-Content -Path 'docs/next/README.md' -Value $readme -Encoding utf8
```

Expected: `docs/next/README.md` points workers to the roadmap and Phase 0 contract.

- [ ] **Step 6: Capture preflight state**

```powershell
$log = 'docs/next/evidence/P00-PREFLIGHT/preflight.log'
"Legion Retooled status" | Tee-Object -FilePath $log
git status --short --branch 2>&1 | Tee-Object -FilePath $log -Append
"Legion Retooled HEAD" | Tee-Object -FilePath $log -Append
git rev-parse HEAD 2>&1 | Tee-Object -FilePath $log -Append
"Original Legion status" | Tee-Object -FilePath $log -Append
git -C 'C:/Users/dasbl/Documents/legion' status --short --branch 2>&1 | Tee-Object -FilePath $log -Append
"Original Legion origin/main" | Tee-Object -FilePath $log -Append
git -C 'C:/Users/dasbl/Documents/legion' rev-parse origin/main 2>&1 | Tee-Object -FilePath $log -Append
"Original Legion package version" | Tee-Object -FilePath $log -Append
node -e "const p=require('C:/Users/dasbl/Documents/legion/package.json'); console.log(p.version)" 2>&1 | Tee-Object -FilePath $log -Append
"Node and npm versions" | Tee-Object -FilePath $log -Append
node --version 2>&1 | Tee-Object -FilePath $log -Append
npm --version 2>&1 | Tee-Object -FilePath $log -Append
```

Expected: `preflight.log` records both repository states, original v8 version, and Node/npm versions. If the original Legion status includes uncommitted non-rebuild changes, record `BLOCKED` before executing v8 baseline tasks.

- [ ] **Step 7: Verify bootstrap files**

```powershell
git diff --check
Test-Path '.legion/project/changes/LEGION-NEXT/implementation/phase-00/ledger.yaml'
Test-Path '.legion/project/changes/LEGION-NEXT/implementation/phase-00/evidence-index.yaml'
Test-Path 'docs/next/README.md'
Test-Path 'docs/next/evidence/P00-PREFLIGHT/preflight.log'
```

Expected: `git diff --check` exits successfully and every `Test-Path` prints `True`.

- [ ] **Step 8: Commit bootstrap**

```powershell
git add .legion/project/changes/LEGION-NEXT/implementation/phase-00 docs/next/README.md docs/next/evidence/P00-PREFLIGHT
git commit -m "docs: bootstrap Phase 0 governance"
```

Expected: a commit is created with the ledger, evidence index, docs entry point, and preflight log.

## Task 2: Execute P00-T01 Rewrite Charter and V8 Freeze

**Files:**
- Create: `docs/next/REWRITE-CHARTER.md`
- Create: `docs/next/V8-MAINTENANCE-POLICY.md`
- Create: `docs/next/evidence/P00-T01/fresh-checkout-validation.log`
- Modify: `.legion/project/changes/LEGION-NEXT/implementation/phase-00/ledger.yaml`
- Modify: `.legion/project/changes/LEGION-NEXT/implementation/phase-00/evidence-index.yaml`

- [ ] **Step 1: Read the authoritative task contract**

Open `C:/Users/dasbl/Documents/legion/docs/rebuild/00-phase-architecture-contract-baseline-and-rewrite-guardrails.md` and execute section `P00-T01 - Create rewrite charter, branch policy, and v8 freeze` exactly. Do not rely on this plan for acceptance details if it conflicts with that source section.

- [ ] **Step 2: Create task evidence directory**

```powershell
New-Item -ItemType Directory -Force -Path 'docs/next/evidence/P00-T01' | Out-Null
```

Expected: `docs/next/evidence/P00-T01` exists.

- [ ] **Step 3: Draft charter and v8 policy**

Create `docs/next/REWRITE-CHARTER.md` with these concrete sections:

```markdown
# Legion Next Rewrite Charter

## Status
Draft for P00-T01 review

## Program Boundary
Legion Next is a controlled v9 rewrite focused on typed contracts, durable work state, fresh worker contexts, independent oracles, independent review, and evidence-backed release flow.

## V9 Goals
- Establish a durable development control plane.
- Replace default persona-first execution with functional worker bundles.
- Preserve user-owned project artifacts during migration.
- Keep runtime providers replaceable behind typed interfaces.
- Require evidence before task, phase, and release acceptance.

## Explicit Anti-Goals
- Do not implement the production TypeScript workspace in Phase 0.
- Do not delete v8 personas, commands, adapters, or installers in Phase 0.
- Do not change default user-visible v8 behavior in Phase 0.
- Do not claim v9 quality, speed, portability, or durability without recorded evidence.

## Governance Roles
- Decision owner: record the named approver before accepting ADRs.
- Architecture reviewers: record owners for ADRs, protocol schemas, runtime drivers, migrations, security, and eval fixtures.
- Phase coordinator: owns ledger integrity, evidence indexing, and handoff completion.

## Phase Gates
- Phase 0 closes only after ADRs, v8 baseline, storage spike, Eve spike, premortem, backlog, go/no-go decision, integrated verification, independent review, and handoff pass.
- Later phases cannot begin until the Phase 0 decision is GO or CONDITIONAL GO with assigned, testable conditions.

## Change Control
Approved ADRs, baseline fixtures, or accepted evidence are revised only by adding a new revision, recording impact, invalidating affected work, and reapproving.
```

Create `docs/next/V8-MAINTENANCE-POLICY.md` with these concrete sections:

```markdown
# V8 Maintenance Policy

## Status
Draft for P00-T01 review

## Policy
The v8 line is frozen for defects, security fixes, host compatibility fixes, packaging correctness, and documentation corrections. New workflow architecture, durable runtime behavior, persona removal, control-plane implementation, migration tooling, and release automation belong to v9.

## Permitted V8 Changes
- Security fixes.
- Broken installer or packaging fixes.
- Runtime compatibility fixes for already-supported surfaces.
- Documentation corrections that reflect shipped behavior.
- Test fixes that preserve existing behavior.

## V9-Only Changes
- Durable board or queue implementation.
- Eve runtime integration.
- Functional worker bundle runtime.
- Persona purge from default execution.
- New artifact model or migration engine.
- Dashboard, deployment, release observation, or rollback automation.

## Baseline Rule
Any v8 baseline tag must point to a clean, reproducibly tested commit. If a baseline correction is needed, create a superseding baseline tag and preserve the original.
```

Expected: both files exist and contain no unresolved placeholder text.

- [ ] **Step 4: Run v8 validation from a clean baseline checkout**

Use a fresh temporary checkout so the original working tree is not mutated:

```powershell
$baselineDir = Join-Path $env:TEMP 'legion-v8-baseline-phase00'
if (Test-Path $baselineDir) {
  Remove-Item -LiteralPath $baselineDir -Recurse -Force
}
git clone 'C:/Users/dasbl/Documents/legion' $baselineDir
git -C $baselineDir checkout origin/main
$log = 'docs/next/evidence/P00-T01/fresh-checkout-validation.log'
"Baseline checkout HEAD" | Tee-Object -FilePath $log
git -C $baselineDir rev-parse HEAD 2>&1 | Tee-Object -FilePath $log -Append
"npm ci" | Tee-Object -FilePath $log -Append
npm --prefix $baselineDir ci 2>&1 | Tee-Object -FilePath $log -Append
"npm run validate" | Tee-Object -FilePath $log -Append
npm --prefix $baselineDir run validate 2>&1 | Tee-Object -FilePath $log -Append
"npm run release:check" | Tee-Object -FilePath $log -Append
npm --prefix $baselineDir run release:check 2>&1 | Tee-Object -FilePath $log -Append
"npm test" | Tee-Object -FilePath $log -Append
npm --prefix $baselineDir test 2>&1 | Tee-Object -FilePath $log -Append
```

Expected: all v8 commands exit successfully. If any fail, stop Phase 0 and record a blocker because P00-T01 acceptance requires a reproducible v8 baseline.

- [ ] **Step 5: Create the baseline tag only after validation passes**

Run in the original v8 checkout only if Step 4 passed:

```powershell
$date = Get-Date -Format 'yyyyMMdd'
$tag = "v8-baseline-$date"
$target = git -C 'C:/Users/dasbl/Documents/legion' rev-parse origin/main
git -C 'C:/Users/dasbl/Documents/legion' tag -a $tag $target -m "Phase 0 v8 baseline $date"
git -C 'C:/Users/dasbl/Documents/legion' tag -n --list "v8-baseline-*"
```

Expected: a local annotated baseline tag exists and points to the tested v8 commit. Do not push the tag until the decision owner approves publication policy.

- [ ] **Step 6: Update ledger and evidence index**

Mark `P00-T01` as `DONE` only after the Phase 0 contract acceptance criteria pass. Record the commit SHA and evidence log path in the ledger and evidence index.

- [ ] **Step 7: Verify and commit P00-T01**

```powershell
git diff --check
git add docs/next/REWRITE-CHARTER.md docs/next/V8-MAINTENANCE-POLICY.md docs/next/evidence/P00-T01 .legion/project/changes/LEGION-NEXT/implementation/phase-00
git commit -m "docs: establish rewrite charter and v8 freeze"
```

Expected: one commit contains P00-T01 outputs and evidence references.

## Task 3: Execute P00-T02 and P00-T03 Architecture ADRs

**Files:**
- Create: `docs/next/adr/ADR-001-runtime-product.md`
- Create: `docs/next/adr/ADR-002-functional-workers.md`
- Create: `docs/next/adr/ADR-003-state-ownership.md`
- Create: `docs/next/adr/ADR-004-runtime-driver.md`
- Create: `docs/next/adr/ADR-005-events-idempotency.md`
- Create: `docs/next/adr/ADR-006-risk-adaptive-gates.md`
- Create: `docs/next/adr/ADR-007-naming-migration-policy.md`
- Create: `docs/next/evidence/P00-T02/adr-review.log`
- Create: `docs/next/evidence/P00-T03/adr-review.log`
- Modify: `.legion/project/changes/LEGION-NEXT/implementation/phase-00/ledger.yaml`
- Modify: `.legion/project/changes/LEGION-NEXT/implementation/phase-00/evidence-index.yaml`

- [ ] **Step 1: Read the authoritative task contracts**

Open the Phase 0 contract and execute both sections:

- `P00-T02 - Approve ADR-001 through ADR-003: product, workers, and state ownership`
- `P00-T03 - Approve ADR-004 through ADR-007: runtime, events, risk gates, and naming`

Expected: the worker follows the task-specific read scopes, write scopes, forbidden changes, acceptance criteria, and stop conditions from the source contract.

- [ ] **Step 2: Create ADR evidence directories**

```powershell
New-Item -ItemType Directory -Force -Path 'docs/next/evidence/P00-T02' | Out-Null
New-Item -ItemType Directory -Force -Path 'docs/next/evidence/P00-T03' | Out-Null
```

Expected: both evidence directories exist.

- [ ] **Step 3: Write each ADR using one consistent structure**

Each ADR file must use this section structure and replace `Status` with `Accepted` only after review:

```markdown
# ADR-001: Runtime Product Boundary

## Status
Draft for P00-T02 review

## Context
Describe the repository evidence and transformation-plan sections that create this decision.

## Decision
State the selected architecture decision in one concrete paragraph.

## Consequences
- Record the positive consequences.
- Record the implementation costs.
- Record the compatibility risks.

## Rejected Alternatives
- Name each alternative and the evidence-based reason it was rejected.

## Review And Approval
- Approver: record the decision owner name before acceptance.
- Date: record the approval date before acceptance.
- Supersession rule: record what evidence can reopen this ADR.
```

Expected: all seven ADRs use the same reviewable structure and contain decision-specific content from the Phase 0 source contract.

- [ ] **Step 4: Run ADR structural checks**

```powershell
$required = @('## Status','## Context','## Decision','## Consequences','## Rejected Alternatives','## Review And Approval')
$adrFiles = Get-ChildItem -LiteralPath 'docs/next/adr' -Filter 'ADR-*.md'
foreach ($file in $adrFiles) {
  $content = Get-Content -LiteralPath $file.FullName -Raw
  foreach ($heading in $required) {
    if ($content -notmatch [regex]::Escape($heading)) {
      throw "$($file.Name) missing $heading"
    }
  }
}
```

Expected: the command exits with no exception.

- [ ] **Step 5: Record adversarial review evidence**

Write review logs to:

- `docs/next/evidence/P00-T02/adr-review.log`
- `docs/next/evidence/P00-T03/adr-review.log`

Each log must include reviewer identity, source files reviewed, findings, resolutions, and the final acceptance decision. If an ADR is not accepted, update the ledger with `BLOCKED` and stop before later tasks consume it.

- [ ] **Step 6: Mark P00-T02 and P00-T03 done only after acceptance**

Update the ledger task statuses and evidence index entries. Include ADR file hashes:

```powershell
Get-FileHash docs/next/adr/ADR-*.md -Algorithm SHA256
```

Expected: every accepted ADR has a recorded hash in the evidence index.

- [ ] **Step 7: Verify and commit ADRs**

```powershell
git diff --check
git add docs/next/adr docs/next/evidence/P00-T02 docs/next/evidence/P00-T03 .legion/project/changes/LEGION-NEXT/implementation/phase-00
git commit -m "docs: approve Phase 0 architecture ADRs"
```

Expected: one commit contains ADR-001 through ADR-007 and their evidence references.

## Task 4: Execute P00-T04 and P00-T05 Benchmark Corpus and Harness

**Files:**
- Create: `docs/next/baseline/BENCHMARK-CORPUS.md`
- Create: `docs/next/baseline/SCORING-RUBRIC.md`
- Create: `docs/next/baseline/V8-MEASUREMENT-HARNESS.md`
- Create: `evals/baseline/corpus-manifest.yaml`
- Create: `evals/baseline/fixture-hashes.sha256`
- Create: `evals/baseline/run-manifest-template.yaml`
- Create: `docs/next/evidence/P00-T04/corpus-review.log`
- Create: `docs/next/evidence/P00-T05/harness-review.log`
- Modify: `.legion/project/changes/LEGION-NEXT/implementation/phase-00/ledger.yaml`
- Modify: `.legion/project/changes/LEGION-NEXT/implementation/phase-00/evidence-index.yaml`

- [ ] **Step 1: Read the authoritative task contracts**

Open the Phase 0 contract and execute both sections:

- `P00-T04 - Define benchmark corpus, fixture governance, and scoring rubric`
- `P00-T05 - Build v8 measurement and run-capture harness`

Expected: corpus and harness work follows the source read/write scopes and evidence policy.

- [ ] **Step 2: Create evidence directories**

```powershell
New-Item -ItemType Directory -Force -Path 'docs/next/evidence/P00-T04' | Out-Null
New-Item -ItemType Directory -Force -Path 'docs/next/evidence/P00-T05' | Out-Null
```

- [ ] **Step 3: Define the corpus manifest**

Create `evals/baseline/corpus-manifest.yaml` with concrete fixture IDs before running any baseline:

```yaml
schema_version: 1
corpus_id: legion-v8-baseline-corpus
status: draft
fixtures:
  - id: fixture-small-doc-change
    kind: documentation-change
    risk_tier: R1
    source: record the local fixture path or repository URL during P00-T04
    expected_outputs:
      - accepted code or document change
      - verification command transcript
  - id: fixture-bugfix-with-test
    kind: bugfix
    risk_tier: R2
    source: record the local fixture path or repository URL during P00-T04
    expected_outputs:
      - failing regression evidence
      - passing regression evidence
  - id: fixture-multi-file-refactor
    kind: refactor
    risk_tier: R2
    source: record the local fixture path or repository URL during P00-T04
    expected_outputs:
      - scoped diff
      - affected test evidence
  - id: fixture-security-sensitive-change
    kind: security-sensitive-change
    risk_tier: R3
    source: record the local fixture path or repository URL during P00-T04
    expected_outputs:
      - explicit approval evidence
      - security review evidence
governance:
  mutation_policy: fixture corrections create a new manifest version
  secrets_policy: fixtures contain no credentials or private customer data
  hash_policy: every fixture input is recorded in fixture-hashes.sha256
```

Expected: P00-T04 replaces each `source` sentence with an actual local path or URL before acceptance. Do not leave any draft source lines in an accepted corpus.

- [ ] **Step 4: Define the run manifest template**

Create `evals/baseline/run-manifest-template.yaml`:

```yaml
schema_version: 1
run_id: generated per run
fixture_id: selected from corpus-manifest.yaml
legion_version: recorded from package.json
legion_commit: recorded from git
host_runtime: recorded per run
node_version: recorded per run
npm_version: recorded per run
os: recorded per run
started_at: recorded per run
completed_at: recorded per run
commands:
  - command: recorded command line
    exit_code: recorded exit code
artifacts:
  - path: recorded artifact path
    sha256: recorded hash
scores:
  deterministic: recorded deterministic score
  judge: recorded judge score or not_run
```

Expected: P00-T05 uses this shape or a stricter shape for captured v8 runs.

- [ ] **Step 5: Hash fixtures**

After P00-T04 fixture paths are finalized, run:

```powershell
$fixtureRoot = 'evals/baseline'
Get-ChildItem -LiteralPath $fixtureRoot -Recurse -File |
  Where-Object { $_.Name -ne 'fixture-hashes.sha256' } |
  Sort-Object FullName |
  ForEach-Object {
    $hash = Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256
    "$($hash.Hash.ToLower())  $($_.FullName.Replace((Get-Location).Path + '\',''))"
  } | Set-Content -Path 'evals/baseline/fixture-hashes.sha256' -Encoding ascii
```

Expected: `fixture-hashes.sha256` contains one SHA256 line per baseline fixture input file.

- [ ] **Step 6: Review corpus and harness**

Record P00-T04 review output in `docs/next/evidence/P00-T04/corpus-review.log` and P00-T05 review output in `docs/next/evidence/P00-T05/harness-review.log`. Each review must confirm that benchmark fixtures are immutable after baseline execution and do not contain secrets.

- [ ] **Step 7: Verify and commit benchmark definitions**

```powershell
git diff --check
git add docs/next/baseline evals/baseline docs/next/evidence/P00-T04 docs/next/evidence/P00-T05 .legion/project/changes/LEGION-NEXT/implementation/phase-00
git commit -m "docs: define v8 benchmark corpus and harness"
```

Expected: one commit contains the corpus, scoring rubric, harness design, fixture hashes, and evidence references.

## Task 5: Execute P00-T06 Frozen V8 Baseline

**Files:**
- Create: `evals/baseline/runs`
- Create: `docs/next/baseline/V8-BASELINE-REPORT.md`
- Create: `docs/next/evidence/P00-T06/baseline-run.log`
- Modify: `.legion/project/changes/LEGION-NEXT/implementation/phase-00/ledger.yaml`
- Modify: `.legion/project/changes/LEGION-NEXT/implementation/phase-00/evidence-index.yaml`

- [ ] **Step 1: Read the authoritative task contract**

Open and execute `P00-T06 - Execute and publish the frozen v8 baseline` from the Phase 0 contract.

- [ ] **Step 2: Create baseline output directories**

```powershell
New-Item -ItemType Directory -Force -Path 'evals/baseline/runs' | Out-Null
New-Item -ItemType Directory -Force -Path 'docs/next/evidence/P00-T06' | Out-Null
```

- [ ] **Step 3: Verify corpus hash stability before running**

```powershell
Get-Content -LiteralPath 'evals/baseline/fixture-hashes.sha256'
git status --short -- evals/baseline
```

Expected: fixture hash file exists and benchmark fixture inputs are not modified after P00-T04 acceptance.

- [ ] **Step 4: Run the v8 baseline according to P00-T06**

Use the v8 baseline tag and the P00-T05 harness. Capture raw output under `evals/baseline/runs` and record the aggregate summary in `docs/next/baseline/V8-BASELINE-REPORT.md`.

Minimum report requirements:

The report must contain these headings: `Baseline Identity`, `Run Matrix`, `Aggregate Results`, `Known Limitations`, and `Evidence Index`. `Baseline Identity` must include the exact v8 tag, v8 commit, corpus manifest path, and fixture hash file path. `Run Matrix` must include each host runtime, operating system, Node version, and npm version used. `Aggregate Results` must include evidence-backed quality, recovery, cost, duration, human-intervention, and duplicate-work behavior results. `Evidence Index` must point to run manifests, raw logs, and scoring outputs.

Expected: before acceptance, every blank field is populated with evidence-backed values or the task is marked `BLOCKED`.

- [ ] **Step 5: Verify baseline artifacts**

```powershell
Get-ChildItem -LiteralPath 'evals/baseline/runs' -Recurse -File
Select-String -Path 'docs/next/baseline/V8-BASELINE-REPORT.md' -Pattern 'v8 tag:|v8 commit:|corpus manifest:|fixture hash file:'
git diff --check
```

Expected: run artifacts exist, baseline identity fields are present, and Markdown has no whitespace errors.

- [ ] **Step 6: Commit baseline results**

```powershell
git add evals/baseline/runs docs/next/baseline/V8-BASELINE-REPORT.md docs/next/evidence/P00-T06 .legion/project/changes/LEGION-NEXT/implementation/phase-00
git commit -m "docs: publish frozen v8 baseline"
```

Expected: one commit contains the baseline report, manifests, raw run references, and evidence index updates.

## Task 6: Execute P00-T07 Transactional Store Spike

**Files:**
- Create: `spikes/storage`
- Create: `docs/next/spikes/STORAGE-SPIKE.md`
- Create: `docs/next/adr/ADR-008-local-store.md`
- Create: `docs/next/evidence/P00-T07/storage-spike.log`
- Modify: `.legion/project/changes/LEGION-NEXT/implementation/phase-00/ledger.yaml`
- Modify: `.legion/project/changes/LEGION-NEXT/implementation/phase-00/evidence-index.yaml`

- [ ] **Step 1: Read the authoritative task contract**

Open and execute `P00-T07 - Complete transactional store spike and select local persistence` from the Phase 0 contract.

- [ ] **Step 2: Create spike evidence directory**

```powershell
New-Item -ItemType Directory -Force -Path 'docs/next/evidence/P00-T07' | Out-Null
```

- [ ] **Step 3: Keep spike dependencies isolated**

If the storage spike needs dependencies, install them only inside `spikes/storage` after ADR scope approval. Do not add storage spike dependencies to the root package unless P00-T07 accepts them as production choices.

Expected: root package files remain unchanged unless the accepted ADR explicitly requires a root-level change.

- [ ] **Step 4: Write the storage comparison report**

Create `docs/next/spikes/STORAGE-SPIKE.md` with concrete sections:

```markdown
# Storage Spike

## Question
Which local transactional store should Legion Next use for Phase 3 board state while preserving a future hosted-store path?

## Candidates
Each candidate entry records package name, version, license, installation requirements, Windows support, transaction model, migration support, backup support, and test command.

## Required Fault Tests
- concurrent claimers cannot own the same task generation
- crash after event append but before projection is recoverable
- migration commits completely or rolls back
- backup restores task and event hashes exactly

## Results
Each candidate result references a command log, operating system, pass/fail status for every required fault test, and any unsupported requirement.

## Decision
The decision records the selected provider, rejected candidates, fallback, hosted migration constraint, and exact evidence paths.

## Evidence
- docs/next/evidence/P00-T07/storage-spike.log
```

Expected: before acceptance, candidate names, results, decision, fallback, and hosted migration constraints are populated from actual spike evidence.

- [ ] **Step 5: Write ADR-008**

Create `docs/next/adr/ADR-008-local-store.md` using the same ADR structure from Task 3 and mark it `Accepted` only after P00-T07 review passes.

- [ ] **Step 6: Run and capture spike tests**

Run the candidate-specific test commands selected in P00-T07 and capture output:

```powershell
$log = 'docs/next/evidence/P00-T07/storage-spike.log'
"Storage spike started" | Tee-Object -FilePath $log
Get-Date -Format o | Tee-Object -FilePath $log -Append
"Spike commands and outputs must be appended below by P00-T07 worker" | Tee-Object -FilePath $log -Append
```

Expected: the worker appends actual fault-test commands and outputs before acceptance.

- [ ] **Step 7: Verify and commit storage spike**

```powershell
git diff --check
git add spikes/storage docs/next/spikes/STORAGE-SPIKE.md docs/next/adr/ADR-008-local-store.md docs/next/evidence/P00-T07 .legion/project/changes/LEGION-NEXT/implementation/phase-00
git commit -m "docs: select Phase 0 local store"
```

Expected: one commit contains spike evidence, ADR-008, and ledger/evidence updates.

## Task 7: Execute P00-T08 Eve Public-Contract Compatibility Spike

**Files:**
- Create: `spikes/eve`
- Create: `docs/next/spikes/EVE-COMPATIBILITY.md`
- Modify: `docs/next/adr/ADR-004-runtime-driver.md`
- Create: `docs/next/evidence/P00-T08/eve-compatibility.log`
- Modify: `.legion/project/changes/LEGION-NEXT/implementation/phase-00/ledger.yaml`
- Modify: `.legion/project/changes/LEGION-NEXT/implementation/phase-00/evidence-index.yaml`

- [ ] **Step 1: Read the authoritative task contract**

Open and execute `P00-T08 - Complete Eve public-contract compatibility spike` from the Phase 0 contract.

- [ ] **Step 2: Verify current Eve public documentation before coding**

Use official Eve documentation and package metadata at execution time. Record source URLs, package version, and access date in `docs/next/spikes/EVE-COMPATIBILITY.md`. If current public docs do not expose a required capability, mark P00-T08 `BLOCKED` rather than using private internals.

- [ ] **Step 3: Create spike evidence directory**

```powershell
New-Item -ItemType Directory -Force -Path 'docs/next/evidence/P00-T08' | Out-Null
```

- [ ] **Step 4: Keep Eve spike dependencies isolated**

If the Eve spike needs dependencies, install them only inside `spikes/eve` after P00-T08 confirms the public package and version. Do not add Eve dependencies to root package files in Phase 0 unless ADR-004 explicitly accepts them.

- [ ] **Step 5: Write the Eve compatibility report**

Create `docs/next/spikes/EVE-COMPATIBILITY.md` with concrete sections:

```markdown
# Eve Compatibility Spike

## Question
Can Legion Next implement the required durable runtime lifecycle using only Eve public APIs while preserving a local-driver fallback?

## Public Sources
Each public source entry records title, URL, access date, and the required runtime capability it supports.

## Pinned Version
The pinned-version section records package name, exact package version, lockfile path, and Node requirement.

## Required Compatibility Checks
- durable session creation
- multi-step event stream inspection
- crash and resume behavior
- approval or question pause across restart
- subagent isolation
- sandbox filesystem and network policy
- real-session eval result export

## Event Mapping
Each mapping entry records Eve public event name, proposed Legion runtime event name, required fields, unsupported fields, and fallback.

## Decision
The decision records whether public APIs satisfy MVP runtime requirements, the fallback driver, pinned-version policy, and upgrade test policy.

## Evidence
- docs/next/evidence/P00-T08/eve-compatibility.log
```

Expected: before acceptance, every section contains evidence-backed values from the current public Eve API and no private/internal API dependency.

- [ ] **Step 6: Run and capture compatibility checks**

Capture output:

```powershell
$log = 'docs/next/evidence/P00-T08/eve-compatibility.log'
"Eve compatibility spike started" | Tee-Object -FilePath $log
Get-Date -Format o | Tee-Object -FilePath $log -Append
"Spike commands and public source references must be appended below by P00-T08 worker" | Tee-Object -FilePath $log -Append
```

Expected: the worker appends actual commands, event captures, crash-resume evidence, sandbox evidence, eval output, and public source references before acceptance.

- [ ] **Step 7: Amend ADR-004**

Update `docs/next/adr/ADR-004-runtime-driver.md` with the Eve compatibility result, fallback policy, version pin, and upgrade test policy. Keep core model decisions provider-neutral.

- [ ] **Step 8: Verify and commit Eve spike**

```powershell
git diff --check
git add spikes/eve docs/next/spikes/EVE-COMPATIBILITY.md docs/next/adr/ADR-004-runtime-driver.md docs/next/evidence/P00-T08 .legion/project/changes/LEGION-NEXT/implementation/phase-00
git commit -m "docs: validate Eve runtime compatibility"
```

Expected: one commit contains Eve spike evidence, ADR-004 amendment, and ledger/evidence updates.

## Task 8: Execute P00-T09 Independent Premortem

**Files:**
- Create: `docs/next/reviews/PHASE-00-PREMORTEM.md`
- Create: `docs/next/reviews/PHASE-00-FINDINGS.yaml`
- Create: `docs/next/evidence/P00-T09/premortem-review.log`
- Modify: `.legion/project/changes/LEGION-NEXT/implementation/phase-00/ledger.yaml`
- Modify: `.legion/project/changes/LEGION-NEXT/implementation/phase-00/evidence-index.yaml`

- [ ] **Step 1: Read the authoritative task contract**

Open and execute `P00-T09 - Perform architecture, security, portability, and migration pre-mortem` from the Phase 0 contract.

- [ ] **Step 2: Create review evidence directory**

```powershell
New-Item -ItemType Directory -Force -Path 'docs/next/evidence/P00-T09' | Out-Null
```

- [ ] **Step 3: Write the findings register**

Create `docs/next/reviews/PHASE-00-FINDINGS.yaml`:

```yaml
schema_version: 1
phase: 0
findings:
  - id: P00-PREMORTEM-001
    severity: critical
    status: open
    title: first critical finding title recorded by reviewer
    evidence: evidence path recorded by reviewer
    owner: owner recorded by reviewer
    closure_criteria: closure criteria recorded by reviewer
```

Expected: the example finding is replaced with actual findings before acceptance. If there are no critical findings, use an empty `findings: []` list and record the no-critical-finding rationale in the premortem report.

- [ ] **Step 4: Write the premortem report**

Create `docs/next/reviews/PHASE-00-PREMORTEM.md` with sections for architecture, security, portability, migration, state ownership, v8 baseline, storage, Eve, and accepted risks. Every critical or important finding must have an owner and closure criteria.

- [ ] **Step 5: Resolve or block on critical findings**

If any finding has `severity: critical` and is not resolved or explicitly accepted by the decision owner with rationale, mark P00-T09 `BLOCKED` and do not execute P00-T10.

- [ ] **Step 6: Verify and commit premortem**

```powershell
git diff --check
git add docs/next/reviews/PHASE-00-PREMORTEM.md docs/next/reviews/PHASE-00-FINDINGS.yaml docs/next/evidence/P00-T09 .legion/project/changes/LEGION-NEXT/implementation/phase-00
git commit -m "docs: complete Phase 0 premortem"
```

Expected: one commit contains premortem findings, evidence, and ledger/evidence updates.

## Task 9: Execute P00-T10 Go/No-Go Decision and Backlog

**Files:**
- Create: `docs/next/PHASE-00-DECISION.md`
- Create: `docs/next/IMPLEMENTATION-BACKLOG.yaml`
- Create: `docs/next/DEPENDENCY-MAP.md`
- Create: `docs/next/evidence/P00-T10/go-no-go-review.log`
- Modify: `.legion/project/changes/LEGION-NEXT/implementation/phase-00/ledger.yaml`
- Modify: `.legion/project/changes/LEGION-NEXT/implementation/phase-00/evidence-index.yaml`

- [ ] **Step 1: Read the authoritative task contract**

Open and execute `P00-T10 - Finalize Phase 0 decisions, delivery backlog, and go/no-go gate` from the Phase 0 contract.

- [ ] **Step 2: Create decision evidence directory**

```powershell
New-Item -ItemType Directory -Force -Path 'docs/next/evidence/P00-T10' | Out-Null
```

- [ ] **Step 3: Write the implementation backlog**

Create `docs/next/IMPLEMENTATION-BACKLOG.yaml`:

```yaml
schema_version: 1
program: LEGION-NEXT
backlog:
  - id: P01-BOOTSTRAP-WORKSPACE
    phase: 1
    milestone: typed-foundation
    criticality: phase-1-critical
    source_decision: ADR-001
    depends_on:
      - P00-GO-DECISION
    owner: owner assigned during P00-T10
    verification:
      - command or evidence requirement assigned during P00-T10
    completion_artifact:
      - artifact path assigned during P00-T10
```

Expected: P00-T10 expands this into issue-sized backlog items for Phase 1 and later only where supported by accepted ADRs and roadmap requirements.

- [ ] **Step 4: Write the go/no-go decision**

Create `docs/next/PHASE-00-DECISION.md` with these sections and populate each section from Phase 0 evidence before acceptance:

```markdown
# Phase 0 Decision

## Decision
The decision is exactly one of GO, CONDITIONAL GO, or NO-GO.

## Decision Owner
The authorized decision owner is named here.

## Conditions
Each condition is testable, assigned to an owner, and linked to evidence. If there are no conditions, this section states that explicitly.

## Evidence
This section links to accepted ADR hashes, v8 baseline, storage spike, Eve spike, premortem, and backlog evidence.

## Dissent
This section records dissenting views or states that no dissent was recorded.

## Phase 1 Starting Point
This section records the exact base commit, first eligible task, and required artifacts for Phase 1.
```

Expected: before acceptance, the decision value is exactly `GO`, `CONDITIONAL GO`, or `NO-GO`, and every evidence field points to a real artifact.

- [ ] **Step 5: Write the dependency map**

Create `docs/next/DEPENDENCY-MAP.md` with the critical path from Phase 1 through Phase 13, referencing the roadmap and cross-phase dependency map. Do not restate all 151 task contracts.

- [ ] **Step 6: Verify backlog coverage**

```powershell
Select-String -Path 'docs/next/IMPLEMENTATION-BACKLOG.yaml' -Pattern 'ADR-001|ADR-002|ADR-003|ADR-004|ADR-005|ADR-006|ADR-007|ADR-008'
Select-String -Path 'docs/next/PHASE-00-DECISION.md' -Pattern 'GO|CONDITIONAL GO|NO-GO'
git diff --check
```

Expected: backlog references accepted ADRs and the decision file contains one explicit decision state.

- [ ] **Step 7: Commit decision and backlog**

```powershell
git add docs/next/PHASE-00-DECISION.md docs/next/IMPLEMENTATION-BACKLOG.yaml docs/next/DEPENDENCY-MAP.md docs/next/evidence/P00-T10 .legion/project/changes/LEGION-NEXT/implementation/phase-00
git commit -m "docs: finalize Phase 0 decision and backlog"
```

Expected: one commit contains the decision record, backlog, dependency map, and evidence updates.

## Task 10: Run Phase 0 Integration Gate, Independent Review, and Handoff

**Files:**
- Create: `.legion/project/changes/LEGION-NEXT/implementation/phase-00/HANDOFF.md`
- Create: `docs/next/reviews/PHASE-00-INDEPENDENT-REVIEW.md`
- Create: `docs/next/evidence/PHASE-00-INTEGRATION/integration.log`
- Modify: `.legion/project/changes/LEGION-NEXT/implementation/phase-00/ledger.yaml`
- Modify: `.legion/project/changes/LEGION-NEXT/implementation/phase-00/evidence-index.yaml`

- [ ] **Step 1: Read the authoritative integration sections**

Open the Phase 0 contract and execute sections:

- `8. Phase integration gate`
- `9. Rollback and recovery`
- `10. Handoff to the next phase`
- `11. Definition of done`

- [ ] **Step 2: Create integration evidence directory**

```powershell
New-Item -ItemType Directory -Force -Path 'docs/next/evidence/PHASE-00-INTEGRATION' | Out-Null
```

- [ ] **Step 3: Run integrated verification commands**

Capture integration output:

```powershell
$log = 'docs/next/evidence/PHASE-00-INTEGRATION/integration.log'
"Phase 0 integration started" | Tee-Object -FilePath $log
Get-Date -Format o | Tee-Object -FilePath $log -Append
"git diff --check" | Tee-Object -FilePath $log -Append
git diff --check 2>&1 | Tee-Object -FilePath $log -Append
"ADR status check" | Tee-Object -FilePath $log -Append
Select-String -Path 'docs/next/adr/ADR-*.md' -Pattern '## Status|Accepted' 2>&1 | Tee-Object -FilePath $log -Append
"Findings check" | Tee-Object -FilePath $log -Append
Get-Content -LiteralPath 'docs/next/reviews/PHASE-00-FINDINGS.yaml' 2>&1 | Tee-Object -FilePath $log -Append
"Decision check" | Tee-Object -FilePath $log -Append
Select-String -Path 'docs/next/PHASE-00-DECISION.md' -Pattern 'GO|CONDITIONAL GO|NO-GO' 2>&1 | Tee-Object -FilePath $log -Append
```

Expected: integration log includes the mandatory checks plus any additional v8, storage, Eve, and baseline verification commands required by Phase 0 section 8.

- [ ] **Step 4: Write independent review**

Create `docs/next/reviews/PHASE-00-INDEPENDENT-REVIEW.md` with separate verdicts for:

- requirement coverage;
- architecture compliance;
- implementation quality;
- test and evidence sufficiency;
- migration safety;
- unresolved risk.

Expected: Phase 0 cannot close with open critical or important findings.

- [ ] **Step 5: Write handoff**

Create `.legion/project/changes/LEGION-NEXT/implementation/phase-00/HANDOFF.md` with these sections and populate each section from Phase 0 evidence before acceptance:

```markdown
# Phase 0 Handoff

## Status
The status is PASS or BLOCKED.

## Delivered Capabilities
This section links to the rewrite charter, v8 maintenance policy, ADR set, v8 baseline, storage decision, Eve compatibility decision, premortem, and go/no-go decision.

## Public Contracts And Schemas
This section links to ADR references, selected versions, and compatibility constraints.

## Decisions And Deviations
This section links to decision records and records deviations from the source phase contract. If there are no deviations, it states that explicitly.

## Verification Summary
This section links to v8 baseline verification, ADR validation, corpus hash verification, storage fault tests, Eve compatibility suite, and findings register evidence.

## Known Risks And Deferred Work
This section lists accepted risks with assigned future phase and revisit trigger.

## Exact Starting Point For The Next Phase
This section records the exact base commit, required artifacts, and recommended first task for Phase 1.
```

Expected: before acceptance, every field references real Phase 0 evidence or records `BLOCKED` with the narrow blocker.

- [ ] **Step 6: Mark the phase ledger complete**

Set the phase ledger `status` to `DONE` only when all ten P00 tasks are `DONE`, integrated verification passes, independent review has no open critical or important findings, the decision owner signs the go/no-go record, and Phase 1 has an exact base commit.

- [ ] **Step 7: Commit integration and handoff**

```powershell
git diff --check
git add .legion/project/changes/LEGION-NEXT/implementation/phase-00 docs/next/reviews/PHASE-00-INDEPENDENT-REVIEW.md docs/next/evidence/PHASE-00-INTEGRATION
git commit -m "docs: complete Phase 0 handoff"
```

Expected: one commit contains the final ledger, evidence index, independent review, integration log, and Phase 1 handoff.

## Final Verification

Run after Task 10:

```powershell
git status --short --branch
git log --oneline --decorate -10
git diff --check HEAD~1..HEAD
Test-Path '.legion/project/changes/LEGION-NEXT/implementation/phase-00/HANDOFF.md'
Test-Path 'docs/next/PHASE-00-DECISION.md'
Test-Path 'docs/next/reviews/PHASE-00-INDEPENDENT-REVIEW.md'
```

Expected: working tree is clean, recent commits show one coherent commit per Phase 0 task group, `git diff --check` passes, and required final artifacts exist.

## Stop Conditions

Stop execution and update the ledger to `BLOCKED` when any of these occur:

- v8 validation fails before rewrite changes.
- a required local path or source document is missing.
- a phase worker needs to mutate the original v8 repository outside the approved baseline task.
- an ADR cannot name a decision owner.
- benchmark fixtures contain credentials, private data, or licensing restrictions.
- storage candidate loses acknowledged events or cannot support required platforms.
- Eve compatibility requires undocumented private APIs.
- critical premortem finding lacks a credible mitigation.
- final decision cannot be expressed as `GO`, `CONDITIONAL GO`, or `NO-GO`.
