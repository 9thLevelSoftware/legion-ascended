# Legacy v8 Boundary

The root npm package preserves the v8 installer and prompt asset surface during Milestone A.

Authoritative legacy source directories until Phase 12 migration:

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

The frozen package path snapshot is `docs/next/evidence/P01-PREFLIGHT/v8-npm-pack-dry-run.json`.
The package-content gate is `node scripts/check-package-contents.mjs`.

New v9 packages must not import these Markdown prompt/persona files as runtime domain logic. They remain compatibility assets for the legacy installer path only.
