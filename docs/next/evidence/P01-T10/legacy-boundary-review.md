# P01-T10 Legacy Boundary Review

## Authoritative Legacy Sources

Until Phase 12 migration, the following root package paths remain frozen legacy compatibility assets:

- `.codex-plugin/`
- `adapters/`
- `agents/`
- `bin/`
- `commands/`
- `skills/`
- `settings.json`
- `docs/control-modes.md`
- `docs/runtime-audit.md`
- `docs/runtime-certification-checklists.md`
- `docs/security/`
- `docs/settings.schema.json`

These paths were mechanically copied from the v8 reference checkout and are documented in `legacy/README.md`.

## Boundary Rules

- The root package publishes the legacy installer and prompt assets only.
- `packages/` and generated protocol schemas are not included in the root npm package.
- `packages/protocol` and `packages/core` continue to be checked by `scripts/check-package-boundaries.mjs`; they must not import legacy prompt/persona Markdown as runtime domain logic.
- `scripts/check-package-contents.mjs` gates the package path set, root `legion` bin, workspace package exclusion, and legacy checksum drift.
- Root `package.json` no longer declares `"type": "module"` so the preserved CommonJS v8 `bin/install.js` executes at the same path without rewriting.

## Review Result

PASS. The root package exposes `legion -> bin/install.js`, the package path set matches the frozen v8 snapshot, and the installer smoke matrix passes.
