# Baseline Evaluation Corpus

This directory contains the Phase 0 v8 benchmark corpus, schemas, rubric references, run templates, and eventual P00-T06 run outputs.

Canonical files:

- `manifest.yaml`
- `corpus-manifest.yaml`
- `scenarios/*.json`
- `rubrics/*.yaml`
- `schema/*.schema.json`
- `fixture-hashes.sha256`
- `run-manifest-template.yaml`
- `runs/.gitkeep`

Public task packets live in `evals/fixtures/public`. Evaluator-only assertions live in `evals/fixtures/evaluator` and must not be copied into worker prompts or public task context.
