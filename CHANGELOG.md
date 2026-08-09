# Changelog

All notable Legion Next governance changes are documented here.

## [9.0.0] - GA-pending

### Added
- `legion start` now exposes stable `preflight`, `draft_review`, `question`, and
  `complete` JSON states. Draft review groups validated graph answers into
  requirements, criteria and executable proofs, constraints, non-goals,
  risk/budget/verification defaults, evidence/confidence, diagnostics, and
  unresolved items, with explicit accept, revise, and discard actions.
- `legion start --accept-draft` and `--discard-draft` act on the active staged
  draft; supplied IDs remain compatible. Discard durably records `discarded`
  without creating a session, while staging a new validated ID marks only the
  prior open draft `invalidated` and never rewrites an accepted draft.
- Draft decisions now use one CAS-managed active-review record bound to the exact
  displayed draft digest. Replacement is serialized and journal-recoverable,
  evidence drift invalidates content without rewriting it, and review returns a
  typed `human_decision` pause with inspectable evidence details.
- Start now rejects terminal-draft/action/selector combinations before recovery
  while preserving stage-time goal, exploration, opt-out, and map-failure edits.
- Start modes now use explicit option allowlists: preparation selectors are
  limited to bare preparation and staging, while documented session-selected
  interview forms remain compatible.
- A `claude` execution adapter, so Claude Code can drive `legion build` and
  `legion review` the way Codex already could. It runs `claude --print
  --output-format json` with the prompt on stdin, reads the contract reply out
  of the envelope's `result` field rather than out of the transcript — the
  distinction `structuredOutput` exists for — and records the run's driver as
  `anthropic`/`claude-code`.

  Three things it does that a thinner wrapper would have missed. `claude` exits
  0 and reports an API failure *in band* (`is_error: true`, `api_error_status`),
  so a status taken from the exit code alone records a rate-limited run as a
  success; the envelope's verdict outranks the exit code. A denied tool is how a
  run reports success having been stopped from doing the work, so
  `permission_denials` becomes a blocking finding rather than a line in a log
  nobody reads. And the timeout is 15 minutes, not codex's 5
  (`LEGION_CLAUDE_EXEC_TIMEOUT_MS` overrides): a task contract that builds and
  verifies is one agentic session here, not one completion.

  **Auto-selection deliberately skips it inside a Claude Code session.** The
  installed `/legion` entry point runs `legion build` from within one, so
  auto-selecting would spawn a second agent — permissions bypassed, billed
  again — to do work the agent that asked for it is already sitting in the
  repository to do. The `manual` executor's prompt artifact hands the task to
  that session instead, which is what the entry point documents. An explicit
  `--executor claude` is still honored: a nested run asked for by name is a
  choice, not a surprise.

  One guarantee is weaker than codex's and the code says so rather than implying
  parity. Codex gets `--sandbox read-only` from the OS; Claude Code has no
  sandbox flag, so a read-only run denies `Edit`, `Write`, and `NotebookEdit`
  and leaves `Bash` — which a review pass needs for its test command, and which
  codex's read-only sandbox also permits. What differs is that a `Bash` write is
  refused there and is not refused here; the guarded-execution harness, which
  snapshots the control plane across every dispatch, is what keeps such a write
  from surviving as evidence.

  `modelManifestForExecutor` is now exhaustive over `ExecutionAdapterKind` and
  is the single producer of the manifest — the two hand-written ternaries it
  replaces would have attributed a new driver to provider `legion`, which is the
  field an auditor reads to learn who actually ran the task.

### Changed
- Bare `legion start` is the canonical preparation/resume entrance. Generated
  first-class runtime guidance now displays the CLI's complete grouped review,
  pauses for the human decision, and uses the active-draft action commands;
  `--next` remains an interview compatibility form rather than an equivalent
  description of bare start.
- `legion install` no longer writes the v8 prompt bundle by default. A default
  install writes the target runtime's own entry points — a `/legion` command or
  skill, a thin alias per workflow command, and the manifest — and those entry
  points dispatch to the `legion` CLI. For Claude Code that is 2 files and 12 KB
  where it was 128 files and 2.4 MB. The 49 agent personas, 22 command prompts,
  33 skills, and 13 dispatch adapters are `--legacy-prompts`, which also
  repoints the entry points back at the markdown, and `legion update` preserves
  whichever surface the install chose via a new `legacyPrompts` field in the
  manifest.

  The bundle was never wired into the v9 engine — `legacy/README.md` has said
  since Milestone A that these are "compatibility assets for the legacy
  installer path only" and that v9 packages must not read them — but the
  installer shipped them to everyone and the generated `/legion` router pointed
  the host at them, so a fresh install presented the v8 prompt surface as the
  product and gave no indication the CLI existed. The router now describes the
  CLI contract instead: run the command, read `nextAction`, do not work around a
  `blocked` status, and execute the prompt artifact `legion build` writes when it
  selects the manual executor.

  `bin/runtime-metadata.js` gains `LEGION_CLI_COMMANDS`, the mapping the aliases
  are generated from. It is deliberately not `LEGION_COMMANDS`: three of that
  list's entries have no CLI verb behind them (`board` is `council`, `portfolio`
  lives under `dev board`, and `agent` was a prompt-only authoring flow with no
  CLI counterpart, so it is the one alias a default install does not create), and
  four CLI verbs — `approve`, `attest`, `release`, `doctor` — had no v8 prompt and
  so had no alias at all. A test drives `legion --help` and fails if any mapped
  command stops being a real verb.

  The install banner now names `legion status` as the terminal entry point
  alongside the host's slash command.

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
