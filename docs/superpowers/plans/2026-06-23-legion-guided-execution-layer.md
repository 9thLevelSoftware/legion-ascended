# Legion Guided Execution Layer Plan

## Summary

Build the next CLI layer as a human-in-loop execution and review system, not an autonomous project generator. `legion build` executes the latest typed taskgraph through an adapter-first runner, captures durable run/evidence artifacts, and keeps context fresh with a generated context pack. `legion review` runs a review gate, writes structured review artifacts, requires manual accept/reject by default, and supports bounded `--auto` review cycles.

## Scope

- Add typed `task-run` and `review` artifacts.
- Add executor adapters for `codex`, `manual`, and deterministic `fake`.
- Generate per-run context packs.
- Wire non-dry-run `legion build`.
- Wire submitted, accepted, rejected, and auto review paths.
- Promote workflow state through `planned`, `built`, `reviewed`, `ship_ready`.
- Keep `legion ship` as a readiness gate only.

## Verification

- `pnpm run build`
- `node --test tests/cli-workflow-ux.test.mjs`
- Focused artifact service tests
- `pnpm run validate:next`
- `npm pack --dry-run --json`
