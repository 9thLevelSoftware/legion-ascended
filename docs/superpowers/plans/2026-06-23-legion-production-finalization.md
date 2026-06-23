# Legion Production Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the remaining Legion workflow product layer so contextual commands produce useful artifacts and feed the human-in-loop build/review flow.

**Architecture:** Add a guidance-run subsystem under the CLI workflow layer, use deterministic local implementations where possible, and route analysis-style commands through the existing executor adapter contract. The core `start -> plan -> build -> review -> accept -> ship` state machine remains the execution path; contextual commands enrich or prepare it.

**Tech Stack:** TypeScript CLI packages, Node.js filesystem/process APIs, existing `@legion/artifacts` and `@legion/protocol` services, Node test runner, pnpm.

---

## Tasks

- [ ] Add guidance-run helpers that write `.legion/project/workflow/<workflow>/<runId>/workflow-run.json` plus markdown, prompt, executor-result, raw-log, and redacted-log artifacts.
- [ ] Implement `legion map --refresh [--scope <path>]`, `legion map --check`, and `legion map --query <text>` with deterministic source fingerprints and index/search artifacts.
- [ ] Implement executor-backed `explore`, `advise`, `council`, and `retro` guidance runs using `fake`, `manual`, or `codex` executors.
- [ ] Implement `learn` as a durable lesson artifact plus knowledge index consumed by context packs.
- [ ] Implement `milestone --status`, `--define <name> --phases <range>`, `--complete <id> --summary <text>`, and `--archive <id>`.
- [ ] Convert `quick` and `polish` from record-only commands into typed taskgraph producers that route to `legion build`.
- [ ] Update context-pack generation and `status` to include guidance/map/learn/milestone state.
- [ ] Expand dogfood and CLI regression coverage, then update README and packaged CLI docs after behavior is implemented.

## Verification

- [ ] `pnpm run build`
- [ ] `node --test tests/cli-workflow-ux.test.mjs`
- [ ] `node --test tests/workflow-command-contract.test.mjs`
- [ ] `node --test tests/workflow-dogfood.test.mjs`
- [ ] `node --test tests/workflow-guidance.test.mjs`
- [ ] `pnpm workflow:dogfood`
- [ ] `pnpm workflow:dogfood -- --target "C:\Users\dasbl\Documents\Asset Mapper" --executor fake`
- [ ] `pnpm run validate:next`
- [ ] `npm pack --dry-run --json`
- [ ] `pnpm pack --dry-run`
