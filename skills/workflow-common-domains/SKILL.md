---
name: workflow-common-domains
description: Optional cross-domain conventions for design/marketing/specialized workflows
pack_id: workflow-common-domains
pack_version: 1.0.0
pack_status: extracted
triggers: [design, marketing, domain, campaign, brief]
token_cost: low
summary: "Shared optional conventions for domain workflows that are not always loaded in core execution."
---

# Workflow Common Domain Extension

Use for domain-specific workflows only.

## Versioned Domain Pack v1.0.0
Reusable domain-activation bundle extracted from the v8 workflow-common-domains skill.

- Activate only for MKT-* or DSN-* requirements, matching frontmatter, or explicit domain flags.
- Keyword-based detection is a hint only; it is not a trigger.
- Marketing workflows produce campaign artifacts under `.planning/campaigns/`.
- Design workflows produce design artifacts under `.planning/designs/`.
- Domain extensions refine execution; they never replace core phase/state flow.

## Rules

### Activation trigger (concrete — no "when relevant")

Activate this extension ONLY when at least one of the following conditions holds for the current phase. Keyword-based detection in prose is NOT a trigger — use it only as a hint to prompt the user.

1. A requirement ID in ROADMAP.md or REQUIREMENTS.md matches `^(MKT|DSN)-\d+`
2. The phase's CONTEXT.md YAML frontmatter declares `workflow_type: marketing` or `workflow_type: design`
3. The user passed `--domain=marketing` or `--domain=design` to `/legion:plan`

If none of the above hold: DO NOT activate this extension. Fall back to standard phase decomposition.

### Operational rules

- Marketing workflows produce campaign artifacts under `.planning/campaigns/`.
- Design workflows produce design artifacts under `.planning/designs/`.
- Domain extensions refine execution; they never replace core phase/state flow.
- Canonical phase-detection rules live in `workflow-common/SKILL.md` § Marketing Phase Detection and § Design Phase Detection. This file references them — do not re-implement detection here.
