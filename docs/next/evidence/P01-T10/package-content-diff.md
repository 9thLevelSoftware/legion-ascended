# P01-T10 Package-Content Diff

## Inputs

- Frozen v8 package snapshot: `docs/next/evidence/P01-PREFLIGHT/v8-npm-pack-dry-run.json`
- Current package snapshot: `docs/next/evidence/P01-T10/npm-pack-dry-run.json`
- Current package-content gate: `docs/next/evidence/P01-T10/package-content-check.json`

## Result

| Check | Result |
| --- | --- |
| Package name | `@9thlevelsoftware/legion` retained |
| Root bin | `legion -> bin/install.js` retained |
| Published path count | `135` current, `135` frozen v8 |
| Missing legacy paths | none |
| Extra package paths | none |
| Workspace package paths | none |
| Missing checksum paths | none |
| Legacy checksum mismatches | none |

The package version is intentionally `9.0.0-alpha.0`; the preserved contract is the v8 installer and prompt asset path set, not the old package version.

## Notes

The dry-run tarball byte sizes differ from the LF-normalized P01 preflight baseline because this working tree is on Windows, because `package.json` now carries the v9 package version, validation scripts, and `yaml` dependency required by the legacy installer, and because reviewed installer hardening changed `bin/install.js`. The path-set and approved legacy checksum gates are the compatibility contract for P01-T10.
