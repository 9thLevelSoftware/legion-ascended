# Changelog

All notable Legion Next governance changes are documented here.

## [Unreleased]

### Added
- Established the P00-T01 rewrite charter, v8 maintenance freeze, branch and release-channel policy, CODEOWNERS review routing, and baseline provenance for parallel v8 maintenance and v9 development.
- Recorded the LF-preserving v8 baseline validation and local annotated `v8-baseline-20260619` tag while preserving earlier failed checkout attempts as historical evidence.

### Unchanged
- No v8 runtime behavior, commands, skills, adapters, installers, or personas were changed by this governance update.

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
