# Baseline Evaluation Corpus

This directory contains the Phase 0 v8 benchmark corpus, schemas, rubric references, run templates, and eventual P00-T06 run outputs.

Canonical files:

- `manifest.yaml`
- `corpus-manifest.yaml`
- `schema/manifest.schema.json`
- `schema/corpus-manifest.schema.json`
- `schema/oracle-assertions.schema.json`
- `schema/run-manifest.schema.json`
- `schema/score.schema.json`
- `scenarios/*.json`
- `rubrics/*.yaml`
- `fixture-hashes.sha256`
- `run-manifest-template.yaml`
- `runs/.gitkeep`

Public task packets live in `evals/fixtures/public`. Evaluator-only assertions live in `evals/fixtures/evaluator` and must not be copied into worker prompts or public task context. Fixture hashes are canonicalized as lowercase SHA-256 digests over LF-normalized UTF-8 text with POSIX-relative paths.
