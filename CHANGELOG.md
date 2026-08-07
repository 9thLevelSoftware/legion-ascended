# Changelog

All notable Legion Next governance changes are documented here.

## [9.0.0] - GA-pending

### Added
- ADR-012 (`docs/next/adr/ADR-012-post-ga-governance.md`) scopes the phase
  ledger, evidence-index and independent-phase-review gates to the rewrite
  program, phases 0-13, and states the gates that govern work after the Phase 13
  cut line: PR review per `REVIEW.md`, a CHANGELOG entry per behavioural change,
  an ADR for protocol or gate-semantics changes, and `validate:next` green on
  every supported platform. Phases 14-19 shipped under that lighter process
  without it being written down; the ADR ratifies it rather than backfilling six
  phases of ledgers whose per-task `run_id`, `assignee` and decomposition have no
  ground truth. `docs/legion-next-roadmap.md` and
  `docs/next/REWRITE-CHARTER.md` carry the matching scope note.
- `tests/helpers/symlink-capability.mjs`, one probe deciding whether this machine
  can create symlinks, replacing nine inline `catch`/skip blocks that had drifted
  into three different error-code sets. When file symlinks are unavailable the
  suite now **fails** with setup instructions rather than skipping;
  `LEGION_ALLOW_SYMLINK_SKIP=1` restores skipping and prints a `COVERAGE GAP`
  diagnostic per test that did not run.
- `pnpm run check:symlink-coverage` (`scripts/check-symlink-coverage.mjs`), a
  `validate:next` step that re-runs the symlink-owning test files with file
  symlinks forced unavailable and asserts the run still passes with exactly seven
  reported coverage gaps. GitHub's hosted Windows runners hold symlink privilege,
  so unprivileged Windows — what a contributor on a stock box actually runs — was
  the one configuration CI could never observe. That blind spot is what let the
  nine inline skips accumulate.
- `check:symlink-coverage` also scans the test sources, because the run alone
  cannot see the case it most needs to catch. `LEGION_FORCE_SYMLINK_UNAVAILABLE`
  is read only by the shared helper — it does not make `symlink()` fail — so a new
  test with its own inline creation would make a real link, pass, and leave the
  skip count untouched. The first draft of that script claimed to catch exactly
  that and did not. Every test file that creates a symlink must now import the
  helper, with one stated exemption for the junction pin, which asserts what a
  junction *is* rather than testing a guard.
- `tests/windows-junction.test.mjs` pins that a Windows junction reports
  `isSymbolicLink() === true`, `isDirectory() === false`, and a readable
  `readlink` target. Six production modules refuse paths on exactly that answer,
  and nothing in the repository asserted it — every existing junction test
  checked a `realpath`-based containment guard, which resolves junctions whatever
  `isSymbolicLink()` returns. Verified true on Windows.
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
- Phase 13 GA cut-over artefacts: the fail-closed release checklist
  (`scripts/release/release-checklist.mjs`) and the backup-manifest
  verifier (`scripts/release/rollback-policy.mjs`), wired as
  `legion next release {checklist,rollback-verify}`.
- Phase 13 GA decision package under `docs/next/ga/`:
  `RELEASE-RECORD.md`, `MIGRATION-POLICY.md`, `ROLLBACK-POLICY.md`,
  `V8-HANDOFF.md`, `STABLE-CHANNEL-APPROVAL.md`. Each document is
  pinned by the release checklist as a precondition for stable-channel
  promotion.
- Established the P00-T01 rewrite charter, v8 maintenance freeze, branch and release-channel policy, CODEOWNERS review routing, and baseline provenance for parallel v8 maintenance and v9 development.
- Recorded the LF-preserving v8 baseline validation and local annotated `v8-baseline-20260619` tag while preserving earlier failed checkout attempts as historical evidence.

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
- A guarded run that cannot restore a protected path now reports **why**.
  `GuardedExecutionOutcome.unrestored` carries `{ path, reason }` instead of a
  bare path, and the operator-facing diagnostic renders the reason beside the
  path. "Could not restore X" could not be acted on: it read identically whether
  the worktree held a disk error or the platform was structurally unable to
  recreate the artifact. The verdict is unchanged — an unrestored protected path
  is still a containment failure and the run still blocks.

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
  `covers` is in that comparison too, and was missed in the first draft of this
  fix: it looks like a gate input rather than authored text, but the gate reads
  it from the *existing* document, so a corrected task list with unchanged prose
  took the same branch and was dropped. It is compared as a set, so a reordered
  `--covers` does not force a pointless rewrite.
- `legion ship` prints its artifact-plane warnings. A change whose risk tier does
  not derive a gate can still hold an unreadable artifact for that plane — an R2
  change with a corrupt `release.json` — and the warning was assembled into the
  JSON payload but omitted from the terminal string. A terminal run printed
  "Ship ready." while telling a JSON consumer that a file could not be read.

And two in the guarded-execution path, both Windows-shaped:

- Restoring a snapshotted symlink passed no `type` to `symlinkSync`, so on
  Windows every directory-symlink restore failed even in a privileged process,
  and every symlink restore failed without `SeCreateSymbolicLinkPrivilege`. The
  error was swallowed by a bare `catch` and the path was reported `unrestored`
  with no explanation, which made containment restore silently unimplementable
  on Windows. The type is now resolved from the target, and `EPERM`/`EACCES` is
  reported as a named privilege limitation. A symlink is deliberately **not**
  substituted with a junction: a junction is not the artifact that was
  snapshotted, and this function's contract is that whatever it cannot recreate
  faithfully is left alone and reported.
- The symlink restore above resolved its `type` from the target at restore time,
  which reads post-run state. A run that swapped the target from a file to a
  directory (or the reverse) got the link back with the wrong reparse kind and
  the path reported `restored` — a false restore, which is worse than the honest
  failure the same function reports elsewhere, because nothing downstream
  re-checks it. The kind is now captured in the pre-dispatch snapshot beside the
  target and used verbatim.
- The fake executor swallowed every error from planting a symlink, on the stated
  reasoning that a platform refusing symlink creation "simply does not exercise
  this case; the test that needs it skips". Two tests consequently inferred
  symlink unavailability from a *missing outcome* — the same observation a
  regression in the guard under test produces — so a broken
  `classifyAcceptancePath` or post-run scan would have skipped green on every
  platform, Linux included. The errors now propagate, like the write and delete
  loops beside them, and both tests establish capability from a probe before
  asserting unconditionally.

And two tests that could only ever have passed on Windows, both caught by the
first CI run this branch got:

- Two acceptance tests called `attrib`, a Windows binary, unconditionally, to
  make a file read-only. On Linux and macOS that is `spawnSync attrib ENOENT`,
  so both failed for a reason having nothing to do with what they assert. The
  platform question is now asked once, in a helper that owns both the `chmod`
  and the `attrib`.

  That alone did not make them pass off Windows, and the reason is worth
  recording rather than papering over: artifact writes here are atomic, and
  POSIX `rename` consults the *directory's* permissions rather than the target
  file's, so a read-only `taskgraph.json` does not refuse the write at all.
  Making the directory read-only would refuse it — and would also block the
  `change.yaml` write both tests need to land, that being the half they exist to
  prove is not lost. Windows refuses to replace a read-only file even by rename,
  which is the one-file granularity these tests need and POSIX does not offer.
  So both are Windows-only, and the gap is stated in the file: on Linux and
  macOS the `change_inputs_not_repointed` recovery path is exercised by no test
  in that suite. Closing it portably needs a fault-injection seam in the
  artifact writer.
- The new drive-letter fold test is Windows-only, because a POSIX runtime cannot
  express its input: `path.isAbsolute("d:/repo")` is `false` off Windows, so the
  pair under test stops being the pair under test. The half of that behaviour
  which can go wrong on Linux — a segment case fold — is covered by a test that
  runs everywhere.

### Unchanged
- No v8 runtime behavior, skills, adapters, installers, or personas were changed
  by the P00-T01 governance charter or by the GA cut-over. The v8 maintenance
  branch policy in `docs/next/V8-MAINTENANCE-POLICY.md` continues to govern v8
  work; the GA decision does not alter default v8 behavior. The `legion next`
  command surface *is* changed by this release — see **Added**.
- The held-out `security-sensitive.v1` contract remains in
  `evals/fixtures/evaluator/` and is hash-pinned by
  `tests/evals-baseline.test.mjs`.
