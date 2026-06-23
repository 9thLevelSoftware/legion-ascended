# Unified Legion Installation Platform Plan

## Summary

Prioritize a consistent Legion experience over broad platform count. Users install Legion once, then use the same workflow language everywhere: `legion start`, `legion plan`, `legion build`, `legion review`, `legion ship`, plus guidance commands. Platforms that cannot offer a single clear Legion entry point are downgraded to compatibility, legacy, or manual tiers instead of being advertised as normal installs.

## Research Baseline

- Codex: Agent Skills are current; custom prompts are deprecated, so Codex support moves toward skills/plugins with prompt aliases as compatibility.
- Claude Code: skills, commands, plugins, and live skill discovery make it a first-class target.
- Claude Desktop: requires MCP or desktop extension packaging and is separate from Claude Code.
- Gemini CLI: consumer Gemini CLI moved to Antigravity on June 18, 2026; Gemini remains legacy unless enterprise/pinned usage is explicit.
- Antigravity: plugins and skills are the replacement-style surface for Gemini-like workflows.
- Copilot CLI, Kiro, OpenCode, and Kilo Code expose skills, agents, commands, or modes and are evaluated by tier.
- Cursor and Windsurf stay compatibility-only unless they expose real command or skill installation beyond rules.

## Key Changes

- Add `docs/cli/INSTALL-MATRIX.md` as the human-facing target matrix.
- Extend `bin/runtime-metadata.js` with first-class, compatibility, legacy, manual-only, and unsupported support tiers plus canonical entry points, parity gaps, smoke status, lifecycle metadata, and verified official docs.
- Update `bin/install.js` with `--list-targets`, `--detect`, `--target <id>`, `--dry-run`, `--explain`, and `--all-targets`.
- Keep legacy flags such as `--claude` and `--codex` as aliases.
- Hide non-first-class targets from the default prompt and default target list.
- Install a single primary `legion` wrapper for first-class native surfaces; keep per-command aliases only as compatibility paths.
- Update docs so README and quickstart recommend only first-class targets and link to the install matrix for everything else.

## Test Plan

- Add registry tests proving no target can be `first-class` without official docs, canonical entry points, parity metadata, lifecycle metadata, and smoke status.
- Add installer tests for target listing, detection, target explanation, dry-run, compatibility warnings, and legacy aliases.
- Add golden install smoke tests for first-class targets using temp homes/projects.
- Add docs tests ensuring recommended docs do not advertise compatibility or legacy targets as the happy path.
- Run:
  - `pnpm run build`
  - `node --test tests/bin-router.test.mjs`
  - `node --test tests/package-install-smoke.test.mjs`
  - `node --test tests/installer-matrix.test.mjs`
  - `pnpm workflow:dogfood`
  - `pnpm run validate:next`
  - `npm pack --dry-run --json`
  - `pnpm pack --dry-run`

## Acceptance Criteria

- A new user can run one command to see supported targets and the recommended install path.
- Docs no longer imply all platforms provide the same experience.
- First-class targets expose the same Legion workflow language and pass install verification.
- Compatibility and legacy targets are discoverable but clearly labeled.
- Gemini CLI is no longer presented as a normal consumer first-class target.
- Automated installer tests do not write to real user config.
