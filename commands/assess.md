---
name: legion:assess
description: Run a read-only brownfield assessment that produces an evidence-bound audit bundle
argument-hint: "[--effort 1|2|3|4|5] [--scope <path>] [--resume <assessment-id>]"
allowed-tools: [Read, Bash, Grep, Glob]
---

`legion assess` runs a read-only brownfield assessment from a fresh structural
code index. The CLI owns `.legion/project/assessment/<assessment-id>/` and
writes the evidence-bound assessment bundle there. It does not modify source
files, manifests, or runtime configuration.

Run `legion map --refresh --profile structural` first when no fresh structural
map is available. Use `--resume <assessment-id>` to continue a persisted
assessment from its current phase.
