# Eve Compatibility

## Scope Correction

Legion Next is a workflow tool, not a standalone chat application. Eve is evaluated only as a replaceable runtime driver for executing workflow tasks with durable sessions, sandboxes, approvals, subagents, traces, and evals. It is not the source of Legion project truth, the board, the task database, the command surface, or the Phase 1 product boundary.

## Current Public Evidence

The public Eve documentation identifies Eve as a filesystem-first durable agent framework. The published package name and CLI binary are `eve`; the docs state Eve is preview and subject to API/behavior change before GA. The TypeScript API docs define public authoring helpers such as `defineAgent`, `defineTool`, `defineSkill`, `defineRemoteAgent`, `defineSandbox`, `defineEval`, route helpers, approval predicates, and runtime `ctx` accessors including `ctx.session`, `ctx.getSandbox()`, and `ctx.getSkill()`.

`npm view eve version engines license --json` returned:

```json
{
  "version": "0.11.7",
  "engines": {
    "node": ">=24"
  },
  "license": "Apache-2.0"
}
```

## Mapping To Legion

| Legion workflow need | Eve public surface | Phase 0 decision |
| --- | --- | --- |
| Functional worker bundles | Filesystem agent layout, tools, skills, instructions, subagents | Compatible as an adapter target. |
| Durable task attempts | Session state, `sessionId`, `continuationToken`, reconnectable stream | Promising, but live crash-resume proof belongs in Phase 5. |
| HITL approvals | Approval predicates and auth helpers | Compatible; Legion policy remains authoritative. |
| Sandbox execution | `defineSandbox`, `ctx.getSandbox()` | Compatible in principle; deny-by-default policy tests required later. |
| Subagents | `defineRemoteAgent`, subagent filesystem layout | Compatible as worker delegation substrate. |
| Evals | `defineEval`, `defineEvalConfig`, reporters, expect helpers | Useful as one backend for behavioral evals. |

## Decision

Do not block Phase 1 on live Eve execution. Phase 1 defines provider-neutral protocol and core contracts. Phase 5 owns the real `runtime-eve` implementation, exact version pin, crash-resume tests, sandbox secret canary, event stream capture, approval persistence, subagent isolation, and eval export.

Until Phase 5 proves those behaviors, the default runtime for deterministic development and tests is `runtime-local`; `runtime-legacy-cli` remains the transitional path for v8-like host workflows.

## Required Phase 5 Proof

- Start/resume/cancel/inspect/stream through public contracts only.
- Crash/restart resumes from a documented completed-step boundary.
- Waiting approval survives restart and does not hold a board lease.
- Sandbox cannot access host secrets or unrelated filesystem paths.
- Subagent context and workspace are isolated unless explicitly passed.
- Compatibility test fails when an expected public event or field changes.

## Evidence

- Public contract map: `spikes/eve/public-contract-map.json`
- Package metadata: `docs/next/evidence/P00-T08/eve-package-metadata.log`
- Official documentation checked on 2026-06-19:
  - `https://github.com/vercel/eve/blob/main/docs/README.md`
  - `https://github.com/vercel/eve/blob/main/docs/reference/typescript-api.md`
  - `https://vercel.com/blog/introducing-eve`
