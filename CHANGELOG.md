# Changelog

All notable Legion Next governance changes are documented here.

## [Unreleased]

### Added
- ADR-011 (`docs/next/adr/ADR-011-ship-gate-producers-and-protocol-0-3-0.md`)
  records which command produces the evidence each of the twenty ship gates
  reads, the waiver rules at both the writer and the reader, and the protocol
  decision below. It amends ADR-010's consequence that `legion ship` cannot
  report ready for an R2 or R3 change; ADR-010's `## Status` carries a pointer to
  it and its body is otherwise unchanged.
- Protocol 0.3.0. `SUPPORTED_PROTOCOL_VERSIONS` is now `0.1.0`, `0.2.0` and
  `0.3.0`, with an identity `legion.protocol.0-2-0.to.0-3-0` upcast registered.
  0.3.0 adds no required field and removes none — two entity kinds
  (`attestation`, `release`) and optional fields on existing ones — but the
  entity schemas are strict, so an older reader refuses a document exercising a
  new field and the version is what tells it why. `PREVIOUS_PROTOCOL_VERSION`
  now names `0.2.0`; the new `LEGACY_PROTOCOL_VERSION` names `0.1.0`.
- `legion ship` reaches `ready` for an R2 and an R3 change end to end, closing
  the ten gates that previously fell through `evaluateGate`'s producerless
  `default:` arm: `approved_delta_spec`,
  `integration_or_real_interface_checks`, `whole_change_acceptance_evidence`,
  `approved_spec_and_oracle`, `independent_baseline`,
  `security_or_e2e_evaluator`, `rollback_or_forward_fix_evidence`,
  `architecture_or_security_review`, `protected_acceptance_tests` and
  `release_observation_plan`. (`explicit_human_approval` was listed here in
  error in the first draft of this entry: it had a producer before this series
  began — any accepted review satisfied it — so it is a **Changed**, not an
  **Added**, and appears below.)
- Established the P00-T01 rewrite charter, v8 maintenance freeze, branch and release-channel policy, CODEOWNERS review routing, and baseline provenance for parallel v8 maintenance and v9 development.
- Recorded the LF-preserving v8 baseline validation and local annotated `v8-baseline-20260619` tag while preserving earlier failed checkout attempts as historical evidence.

### Fixed
Three findings from the automated review of the ship-gate series, each a case
where a check answered a narrower question than its name claimed.

- A rollback-policy report is no longer credited to a tree it did not audit.
  `sameTree` lowercased the whole path, which is correct on the two
  case-insensitive platforms this repository is developed on and wrong on the
  one CI and every deployment run on: `/workspace/Repo` and `/workspace/repo`
  are two directories on Linux and compared equal, defeating the repository-root
  binding the check exists to enforce. Case folding is now confined to the
  Windows drive letter, which a POSIX path cannot match — so it closes the hole
  on Linux without a `process.platform` branch, following the rule
  `isWindowsStreamPath` already set for this codebase.
- `legion attest` no longer discards an authored correction. Its "already
  recorded" test asked the gate's predicate — attester, verdict, still
  satisfying — and `--statement` and `--waiver-reason` participate in no gate
  predicate, that being the point of them. Re-running with corrected wording
  therefore exited 0, reported `unchanged`, and wrote nothing. Satisfying the
  gate and carrying the authored text are now both required for `unchanged`.
- `legion ship` prints its artifact-plane warnings. A change whose risk tier does
  not derive a gate can still hold an unreadable artifact for that plane — an R2
  change with a corrupt `release.json` — and the warning was assembled into the
  JSON payload but omitted from the terminal string. A terminal run printed
  "Ship ready." while telling a JSON consumer that a file could not be read.

And two tests that could only ever have passed on Windows, both caught by the
first CI run this branch got:

- Two acceptance tests called `attrib`, a Windows binary, unconditionally, to
  make a file read-only. On Linux and macOS that is `spawnSync attrib ENOENT`,
  so both failed for a reason having nothing to do with what they assert. The
  platform question is now asked once, in a helper that owns both the `chmod`
  and the `attrib`, and each platform gets the mechanism that actually refuses
  a write on it.
- The new drive-letter fold test is Windows-only, because a POSIX runtime cannot
  express its input: `path.isAbsolute("d:/repo")` is `false` off Windows, so the
  pair under test stops being the pair under test. The half of that behaviour
  which can go wrong on Linux — a segment case fold — is covered by a test that
  runs everywhere.

### Changed
- `explicit_human_approval` no longer answers from "an accepted review decision
  exists". It reads the approval plane for a live `workflow.review.accept` grant
  by a human decision owner, so a review a tool accepted no longer satisfies the
  one gate whose name is the question.
- `legion ship`'s `riskGates.humanJudgementGates` and its
  `risk_gate_human_judgement` warning now also report a declared verification
  surface whose pinned bytes drifted and were re-affirmed by `legion approve
  surface` rather than re-verified. That gate reached `satisfied` silently
  before, and its reason claimed "every pinned reference still matches" about
  bytes that had demonstrably changed.
- The dogfood harness (`scripts/dogfood-workflow.mjs`) now certifies what the
  tool can establish. It drives a real intake session at `risk-tier: R2` with an
  executable acceptance criterion and a declared verification surface, runs
  `legion approve spec --approver` and `legion review --accept --approver`, and
  asserts `legion ship` reports `ready` with seven satisfied gates and no
  human-judgement entry — replacing assertions that had treated a blocked
  ship as the success condition. It then edits the file the surface pins,
  asserts the ship blocks naming `integration_or_real_interface_checks`, runs
  the recovery that payload prints, asserts the ship comes back, and asserts the
  recovered payload names the re-affirmed gate.

### Unchanged
- No v8 runtime behavior, skills, adapters, installers, or personas were changed
  by the P00-T01 governance charter recorded above. The `legion next` command
  surface *is* changed by this release — see **Added**.

## [9.0.0] - GA-pending

### Added
- Phase 13 GA cut-over artefacts: the fail-closed release checklist
  (`scripts/release/release-checklist.mjs`) and the backup-manifest
  verifier (`scripts/release/rollback-policy.mjs`), wired as
  `legion next release {checklist,rollback-verify}`.
- Phase 13 GA decision package under `docs/next/ga/`:
  `RELEASE-RECORD.md`, `MIGRATION-POLICY.md`, `ROLLBACK-POLICY.md`,
  `V8-HANDOFF.md`, `STABLE-CHANNEL-APPROVAL.md`. Each document is
  pinned by the release checklist as a precondition for stable-channel
  promotion.

### Unchanged
- No v8 runtime behavior, commands, skills, adapters, installers, or
  personas were changed by the GA cut-over. The v8 maintenance branch
  policy in `docs/next/V8-MAINTENANCE-POLICY.md` continues to govern
  v8 work; the GA decision does not alter default v8 behavior.
- The held-out `security-sensitive.v1` contract remains in
  `evals/fixtures/evaluator/` and is hash-pinned by
  `tests/evals-baseline.test.mjs`.
