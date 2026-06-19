# V8 Workflow Compatibility Baseline

## Scope Correction

The v8 baseline is a reference for rebuilding Legion as a workflow orchestration tool. It is not a live-model product benchmark and it is not a standalone application benchmark. Phase 0 uses deterministic evidence to freeze the workflow surface that Phase 1 must preserve: package contents, command names, installer/runtime adapters, skills, agents, validation behavior, and representative workflow scenario fixtures.

Live model/runtime A/B evaluation is useful later, but it is not required to start Phase 1 protocol and core work.

## Baseline Identity

- Repository: `C:/Users/dasbl/Documents/legion`
- Package: `@9thlevelsoftware/legion`
- Version: `8.0.5`
- Baseline tag: `v8-baseline-20260619`
- Baseline commit: `855e975beec3bac6dc06db598081b6ac11ea8e14`
- Tag object: `87ef9acc057cde8dd71bc25fc08bc536e9c8076c`

## Deterministic Evidence

| Evidence | Result |
| --- | --- |
| Fresh LF-preserving baseline validation | `npm ci`, `npm run validate`, `npm run release:check`, and `npm test` passed during P00-T01. |
| Package file list | `npm pack --dry-run --json` recorded package `@9thlevelsoftware/legion@8.0.5`, 135 entries, size `742150`, unpacked size `2374176`. |
| Command surface | README lists canonical workflow commands from start, plan, build, review, status, quick, advise, portfolio, milestone, agent, map, explore, board, retro, ship, learn, update, polish, validate. |
| Runtime adapter surface | `docs/runtime-audit.md` records runtime entry points for Codex, Claude, Copilot, Gemini, Antigravity, Kiro, OpenCode, Kilo, Kilo Code, Cursor, Windsurf, and Aider fallback. |
| Scenario corpus | Eight workflow scenario families are sealed in `evals/baseline/manifest.yaml` and fixtures. |

## Compatibility Contract For Phase 1

Phase 1 must not delete or rename the v8 Markdown commands, skills, adapters, agents, or installer surfaces. It may introduce TypeScript protocol/core packages only behind a next/v9 boundary. Any new schema must model existing workflow concepts instead of inventing a standalone app domain.

The workflow concepts that must survive are:

- project start and questioning;
- design/explore handoff;
- phase planning;
- wave build execution;
- review loop and review panel;
- status routing;
- ad-hoc quick/advise flows;
- codebase map;
- board/council distinction;
- ship/retro/learn/update/polish/validate flows;
- runtime-specific install and command discovery behavior.

## Deferred Evidence

Live model/runtime comparisons are deferred to the behavioral evaluation phases after the workflow system has a deterministic typed core and driver boundary. Future live runs must use the sealed corpus and record host/runtime/model metadata when exposed, but their absence does not block Phase 1.
