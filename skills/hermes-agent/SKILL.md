---
name: legion
description: "Use when running Legion Ascended workflows (start, plan, build, review, ship). Routes Legion commands to the CLI and dispatches parallel agents via delegate_task."
version: 1.0.0
author: Legion Ascended
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [legion, workflow, planning, review, ship, orchestration]
    related_skills: [plan, subagent-driven-development, requesting-code-review]
---

# Legion Ascended Workflow

Legion Ascended is a guided execution layer for AI-assisted software work.
The core workflow is: `legion start` -> `legion plan` -> `legion build` -> `legion review` -> `legion ship`.

## When to Use

- Starting a new planned change (intake, requirements, constitution)
- Planning a phase into typed task contracts
- Executing work through bounded executors with evidence collection
- Reviewing task outputs with verification gates
- Shipping — running readiness verdicts against risk-tier-derived gates

## Quick Reference

```bash
# Check state
legion status

# Start a new change
legion start --goal "Description of what you want to build"
legion start --accept-draft
legion start --answer "="  # answer interview questions
legion start --finalize

# Plan
legion plan 1  # plan phase 1

# Approve before building (R3 requires this ordering)
legion approve spec --approver <name>

# Build (uses executor — Codex, Claude, etc.)
legion build --executor codex

# Review
legion review --executor codex
legion review --accept --approver <name>

# Ship (readiness verdict, not deployment)
legion ship
```

## Hermes-Specific: Parallel Execution

Hermes Agent can execute Legion plans in PARALLEL using `delegate_task`:

```python
# Execute a wave of independent plans simultaneously
delegate_task(tasks=[
    {"goal": "Execute plan 1-01: ...", "context": "plan context..."},
    {"goal": "Execute plan 1-02: ...", "context": "plan context..."},
    {"goal": "Execute plan 1-03: ...", "context": "plan context..."},
])
```

Up to 3 plans execute concurrently (configurable via `delegation.max_concurrent_children`).
This is unique to Hermes — all other Legion targets execute sequentially.

## Hermes-Specific: Kanban Task Tracking

Use kanban for durable task tracking across sessions:

```python
# Create phase task
kanban_create(title="Phase 1: Auth System", assignee="default")

# Create plan tasks as children
kanban_create(title="1-01: User model", parents=[phase_id], assignee="default")

# Mark done with evidence
kanban_complete(summary="User model created with email/password", metadata={"files": ["src/models/user.py"]})
```

## Hermes-Specific: Gateway Delivery

When running via the Hermes gateway (Telegram, Discord, etc.):
- Interview questions arrive as messages with interactive buttons
- Build/review status is delivered to your configured chat
- Ship gate results are messaged with per-gate status

No configuration needed — the gateway automatically routes Legion output to your active chat.

## Risk Tiers

| Tier | Gates | Typical Use |
|------|-------|-------------|
| R0 | 3 | Small changes, hotfixes |
| R1 | 5 | Planned tasks with lightweight review |
| R2 | 7 | Normal planned phases (default) |
| R3 | 10 | Security-critical, architecture changes |

## Key Rules

1. `legion approve spec` MUST come before `legion build` (R3 enforces via timestamps)
2. `--approver` is NOT optional on `legion review --accept`
3. `legion ship` is a readiness verdict — it does NOT deploy
4. State lives under `.legion/project/` as hash-verified artifacts
