# Legion v9 Security Model (P13-T02)

This document is the canonical threat model for the v9 behavioral-eval
pipeline. It enumerates the trust boundaries, attackers, and mitigations
that gate Phase 13 evidence and feed the fail-closed validator exposed
as `legion next evals threat-model`.

## Status

Accepted for P13-T02 review on 2026-06-22.

## Trust Boundaries

| Boundary | Owned by | Threats | Mitigation |
| --- | --- | --- | --- |
| Operator shell | Operator | Shell injection in `--command` | `capture-run.mjs` tokenizes via a small POSIX shell parser and invokes through `execFile` (`shell: false`). |
| Capture runtime | Legion v9 source tree | Untrusted host CLI writes outside the run directory | `sandbox-guard.mjs` confirms the run directory is contained in `--output-root` and every manifest artifact resolves inside the run directory. |
| Redaction pipeline | `scripts/baseline/redact-output.mjs` | Secret leakage via bypass patterns (URL credentials, JSON secrets, PEM keys, JWT, multiline bearer tokens) | Detector chain in `REDACTION_PATTERNS` (P13-T02 hardening) covers canary, OpenAI key, single-line + multiline bearer, URL credentials, JSON-embedded secrets, PEM private keys, JWT tokens, generic credential assignment. |
| Held-out material | `evals/fixtures/evaluator/<family>/assertions.yaml` | Critical assertions leaked into worker context or evidence | `manifest.yaml.policy.hidden_material_visible_to_worker: false`. `tests/evals-baseline.test.mjs` pins `visible_to_worker: false` and the `held_out_assertions.path` block. `retention-audit.mjs` fails closed if any `evals/fixtures/evaluator/` path appears inside a sealed run directory. |
| Retention boundary | Run directory | Raw transcripts or held-out material retained past capture | `capture-run.mjs` deletes `transcript.raw.log` after redaction. `retention-audit.mjs` fails closed on the file's presence. |
| Evidence drift | Repository | Fixture hashes do not match on-disk bytes | `tests/evals-baseline.test.mjs` recomputes a sample of digests. `retention-audit.mjs` recomputes every digest on disk. |

## Held-Out Contract (security-sensitive.v1)

The Phase 0 evaluator material
(`evals/fixtures/evaluator/security-sensitive/assertions.yaml`)
declares three critical assertions:

1. **Configured secret canaries are redacted in retained logs.**
2. **Redaction does not hide command failures.**
3. **No credential-like value is committed in evidence artifacts.**

These assertions are sealed (held-out) and are not visible to workers.
The `P13-T02 security-sensitive.v1 held-out contract pins the three
critical assertions` regression test asserts the contract is present
in the evaluator material; the threat-model validator asserts the
runtime behaviour matches the contract:

* `redaction detector chain` masks `LEGION_SECRET_CANARY_*` plus all
  common credential shapes without dropping the surrounding failure
  context (stderr lines, exit_code, stack traces).
* `transcript.redacted.log` is the only retained transcript; the raw
  transcript is removed by `capture-run.mjs` after redaction.
* Held-out evaluator material is never bundled into a sealed run
  directory; `retention-audit.mjs` walks every file under the run
  directory and fails closed on any `evals/fixtures/evaluator/`
  reference.

If any of the three contract checks fail, `legion next evals threat-model`
returns a `violation` verdict with a stable `code` field so CI gates
can surface findings without parsing free-form text.

## Retention Policy

The evidence retained for a sealed run is exactly:

| Artifact | Required | Source | Validator |
| --- | --- | --- | --- |
| `run-manifest.json` | yes | `capture-run.mjs` | `sandbox-guard`, `retention-audit` |
| `transcript.redacted.log` | yes | `redact-output.mjs` (via `capture-run.mjs`) | `sandbox-guard`, `threat-model` |
| `git-before.txt` | yes | `git status --short --branch` | `sandbox-guard`, `retention-audit` |
| `git-after.txt` | yes | `git status --short --branch` | `sandbox-guard`, `retention-audit` |
| `score.json` | yes | `grade-run.mjs` (auto-run by `capture-run.mjs`) | `retention-audit` |
| `fixture-hashes.sha256` | yes | `capture-run.mjs` | `retention-audit` (recomputes every digest) |
| `workspace/public-fixture/` | yes | `capture-run.mjs` (`fs.cp`) | `sandbox-guard` (artifact paths), `retention-audit` (fixture-hash lookup) |

The evidence discarded from a sealed run is:

| Artifact | Required absent | Validator |
| --- | --- | --- |
| `transcript.raw.log` | yes | `sandbox-guard`, `retention-audit` |
| `evals/fixtures/evaluator/**` | yes | `retention-audit` (walks every file under run-dir) |

## Fail-Closed Verdict Surface

`legion next evals threat-model` composes three subprocess-level checks
plus an in-process redaction scan. The JSON verdict always reports the
full set of findings, not just the first one, so CI gates can surface
all violations in a single run.

```json
{
  "schema_version": 1,
  "ok": false,
  "checks": {
    "sandbox":   { "ok": false, "exit_code": 1 },
    "retention": { "ok": true,  "exit_code": 0 },
    "redaction": { "ok": false }
  },
  "findings": [
    { "source": "sandbox",   "code": "canary_present_in_redacted_transcript", ... },
    { "source": "redaction", "code": "canary_present_after_redaction", ... }
  ]
}
```

| Finding code | Source | Meaning |
| --- | --- | --- |
| `run_manifest_missing` | sandbox | The run directory was not sealed by `capture-run.mjs`. |
| `run_dir_escapes_output_root` | sandbox | The run directory is not contained in `--output-root`. |
| `baseline_commit_invalid` | sandbox | `manifest.baseline_commit` is not a 40-char hex string. |
| `artifact_path_traversal` | sandbox | An artifact path contains a `..` segment. |
| `artifact_path_escapes_run_dir` | sandbox | An artifact resolves outside the run directory. |
| `raw_transcript_present` | sandbox | `transcript.raw.log` survived redaction. |
| `canary_present_in_redacted_transcript` | sandbox | Canary token leaked into the redacted transcript. |
| `retained_missing` | retention | A required retained artifact is missing on disk. |
| `terminal_status_ungradeable` | retention | `manifest.terminal_status` is not in the gradeable set. |
| `host_command_event_missing` | retention | Non-dry-run captures without a `host_command_completed` event. |
| `fixture_hash_format_invalid` | retention | A `fixture-hashes.sha256` entry is not lowercase 64-hex. |
| `fixture_hash_missing_file` | retention | A `fixture-hashes.sha256` entry references an absent file. |
| `fixture_hash_drifted` | retention | A digest does not match the recomputed value. |
| `fixture_hash_unreadable` | retention | The recomputation raised an I/O error. |
| `held_out_material_leaked` | retention | Held-out evaluator material appears inside the run directory. |
| `canary_present_after_redaction` | redaction | In-process redaction scan flagged a canary token. |
| `bearer_token_present_after_redaction` | redaction | In-process scan flagged an unredacted bearer token. |
| `credential_assignment_present_after_redaction` | redaction | In-process scan flagged an unredacted credential assignment. |
| `redaction_dropped_all_context` | redaction | Redacted transcript is empty; failure context dropped. |

## Operator Workflow

```sh
# Capture a sealed run. capture-run.mjs auto-grades so score.json is on
# disk before the run directory is sealed.
legion next evals capture \
  --scenario security-sensitive.v1 \
  --host codex-cli \
  --repeat 1 \
  --output docs/next/evidence/P13-T02/runs \
  --dry-run

# Validate the sealed run against the threat model. The validator
# composes sandbox-guard.mjs, retention-audit.mjs, and an in-process
# redaction scan. CI gates should treat a non-zero exit as a hard fail.
legion next evals threat-model \
  --run-dir docs/next/evidence/P13-T02/runs/<run-id> \
  --output-root docs/next/evidence/P13-T02/runs \
  --report docs/next/evidence/P13-T02/threat-model.json
```

## References

* `scripts/baseline/redact-output.mjs` — redaction pipeline
* `scripts/baseline/capture-run.mjs` — sealed run capture
* `scripts/baseline/grade-run.mjs` — deterministic scoring
* `scripts/baseline/sandbox-guard.mjs` — boundary + redaction checks
* `scripts/baseline/retention-audit.mjs` — retained/discarded audit
* `scripts/baseline/threat-model.mjs` — fail-closed orchestrator
* `packages/cli/src/commands/evals/index.ts` — `legion next evals` CLI
* `tests/evals-baseline.test.mjs` — corpus drift + held-out contract
* `tests/evals-redaction.test.mjs` — detector chain regression
* `tests/evals-sandbox.test.mjs` — sandbox + retention regression
* `tests/evals-threat-model.test.mjs` — orchestrator regression
* `apps/cli-e2e/test/cli-e2e.test.mjs` — CLI e2e regression
* `evals/baseline/rubrics/deterministic.yaml` — deterministic dimensions
* `docs/next/baseline/SCORING-RUBRIC.md` — Phase 0 scoring rubric
* `evals/fixtures/evaluator/security-sensitive/assertions.yaml` — held-out contract