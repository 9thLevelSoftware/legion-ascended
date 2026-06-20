# P01-T10 Installer Matrix Output

## Command

`node --test tests/legacy/legacy-package-contract.test.mjs tests/legacy/installer-smoke.test.cjs`

## Result

PASS. See raw output in `docs/next/evidence/P01-T10/legacy-installer-matrix.log`.

## Covered Matrix

| Area | Coverage |
| --- | --- |
| Local installs | Claude, Codex, Cursor, Copilot, Gemini, Antigravity, Kiro, Windsurf, OpenCode, Kilo, Kilo Code |
| Global installs | Claude, Codex, Copilot, Gemini, Antigravity, Kiro, OpenCode, Kilo, Kilo Code |
| Uninstall | Local and global supported runtime paths remove Legion-owned files and manifests |
| Integrity verification | `--verify` validates `checksums.sha256` in local source installs |
| Kilo Code mode merge | Existing user modes, comments, workflows, and skills are preserved |
| Unsupported scopes | Cursor/Windsurf global and Aider native installs reject explicitly |
| Legacy alias | `--amazon-q` still maps to the Kiro runtime contract |
| Failure seeds | Omitted command, persona checksum drift, installer path drift, and workspace package publication are detected |
