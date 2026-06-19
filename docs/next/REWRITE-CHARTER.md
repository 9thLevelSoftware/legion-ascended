# Legion Next Rewrite Charter

## Status
Draft for P00-T01 review. Blocked on fresh v8 baseline validation as of 2026-06-19.

Decision owner: `dasbl`

Review evidence: [P00-T01 charter review](evidence/P00-T01/charter-review.log)

## Program Boundary
Legion Next is a controlled v9 rewrite focused on typed contracts, durable work state, fresh worker contexts, independent oracles, independent review, and evidence-backed release flow.

The v8 line remains the shipped maintenance line until v9 reaches an approved GA release decision. Phase 0 may create governance, evidence, ADRs, baseline fixtures, and spikes, but it must not alter default v8 runtime behavior or remove v8 commands, skills, adapters, installers, or personas.

## V8 Baseline Context
- Baseline source repository: `C:/Users/dasbl/Documents/legion`
- Intended baseline ref in the source repository: `refs/remotes/origin/main`
- Intended baseline commit in the source repository: `855e975beec3bac6dc06db598081b6ac11ea8e14`
- Source repository local `main` at validation time: `84d6b69920c877fc6f7b2b8dbc979c32b97bbb92`
- Baseline package at failed validation checkout: `@9thlevelsoftware/legion`
- Baseline package version at failed validation checkout: `8.0.2`
- Proposed P00-T01 baseline tag: `v8-baseline-20260619`
- Tag status: not created because `npm run validate` failed in the fresh checkout.

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
| Role | Owner | Responsibility |
| --- | --- | --- |
| Decision owner | `dasbl` | Approves ADRs, baseline publication, breaking architecture decisions, go/no-go decisions, and dissent dispositions. |
| ADR review owner | `dasbl` | Reviews architecture decision records for evidence, rejected alternatives, reversibility, and supersession rules. |
| Protocol schema owner | `dasbl` | Reviews protocol entities, event schemas, compatibility rules, and versioning policy. |
| Runtime driver owner | `dasbl` | Reviews runtime abstraction, Eve integration, fallback driver policy, and provider boundaries. |
| Migration owner | `dasbl` | Reviews migration strategy, rollback, user-owned artifact preservation, and compatibility fixtures. |
| Security owner | `dasbl` | Reviews threat models, secret handling, sandbox boundaries, approval authority, and evidence retention. |
| Evaluation fixture owner | `dasbl` | Reviews baseline corpus governance, scoring fixtures, hashes, and accepted evidence. |
| Phase coordinator | `dasbl` | Owns ledger integrity, evidence indexing, phase-state transitions, and handoff completion. |

## Decision Process
- Consequential architecture choices require an ADR with context, options, decision drivers, selected decision, consequences, reversal conditions, evidence, and approver.
- The decision owner approves ADRs only after required reviewers have either signed off or recorded dissent with a disposition.
- Dissent is preserved in the ADR or review evidence; it is not deleted after resolution.
- A breaking architecture decision cannot be inferred from implementation code. It must be recorded before dependent production work begins.
- If an owner is unavailable for a required decision, downstream work stops or reports `DONE_WITH_CONCERNS` only when the task contract explicitly permits it.

## Security Expectations
- Do not commit secrets, credentials, private customer data, raw chain-of-thought, or sensitive transcripts as evidence.
- Evidence must preserve command names, versions, outputs, exit status, artifact paths, and hashes where practical.
- Runtime drivers and worker execution must be reviewed for sandbox boundaries, tool authority, host filesystem access, approval bypass, and secret exposure.
- Migration plans must preserve user-controlled project artifacts and define rollback behavior before any destructive migration step is implemented.
- Security findings classified as critical block phase completion until resolved or the decision owner rejects the rewrite.

## Phase Gates
- Phase 0 closes only after ADRs, v8 baseline, storage spike, Eve spike, premortem, backlog, go/no-go decision, integrated verification, independent review, and handoff pass.
- Later phases cannot begin until the Phase 0 decision is GO or CONDITIONAL GO with assigned, testable conditions.

## Branch, PR, Review, and Release Policy
- Use `legion-next/phase-XX` for phase integration branches and `legion-next/PXX-TYY-short-name` for task branches when task isolation is needed.
- Use `v8-maintenance/scope-name` or `v8-hotfix/issue-id` for v8 defect, security, compatibility, packaging, documentation, or test-preserving work.
- Label PRs with the affected line and surface: `legion-next`, `phase-00`, `v8-maintenance`, `adr`, `evidence`, `runtime`, `protocol`, `migration`, `security`, or `eval-fixture`.
- CODEOWNERS entries are authoritative for review routing on ADRs, protocol schemas, runtime drivers, migrations, security material, and evaluation fixtures.
- `next` is reserved for v9 preview packages after explicit release approval.
- `alpha` is reserved for early v9 integration packages with known incomplete surfaces.
- `beta` is reserved for v9 packages with complete MVP workflows and unresolved beta-class risks only.
- `rc` is reserved for v9 release candidates that pass the approved release checklist and have no open critical or important findings.
- GA may use the stable release channel only after the decision owner approves the release record, migration policy, rollback policy, and v8 handoff.
- v8 remains on the stable maintenance channel until v9 GA is approved.

## Change Control
Approved ADRs, baseline fixtures, or accepted evidence are revised only by adding a new revision, recording impact, invalidating affected work, and reapproving.
