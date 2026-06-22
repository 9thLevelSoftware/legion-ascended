---
name: workflow-common-github
description: Optional GitHub interaction conventions shared across commands
pack_id: workflow-common-github
pack_version: 1.0.0
pack_status: extracted
triggers: [github, issue, pr, milestone]
token_cost: low
summary: "Shared rules for optional GitHub issue/PR/milestone interactions when github-sync is active."
---

# Workflow Common GitHub Extension

Use only when GitHub integration is enabled and available.

## Versioned Domain Pack v1.0.0
Reusable GitHub integration bundle extracted from the v8 workflow-common-github skill.

- GitHub is optional and must never fail the core workflow when unavailable.
- Require both `gh auth status` success and a valid git remote.
- Prefer idempotent updates (comment/edit) over duplicate issue or PR creation.
- Mirror every GitHub write back into `.planning/STATE.md` during the same invocation.
- Leave read-only GitHub operations side-effect free.

## Rules
- Treat GitHub as optional integration; never fail core workflow if unavailable.
- Require both: `gh auth status` success and a valid git remote.
- Prefer idempotent updates (comment/edit) over duplicate issue creation.

### Local state mirror trigger (concrete — no "when relevant")

After any GitHub WRITE operation, mirror the result into `.planning/STATE.md` under the `## GitHub` section within the same command invocation. Write operations that trigger the mirror:

- Create issue, update issue body/title, close/reopen issue, comment on issue
- Create PR, update PR body/title, merge PR, close PR
- Create milestone, close milestone, assign issue/PR to milestone
- Apply or remove the `legion` label on any issue/PR

Read-only operations (`gh issue view`, `gh pr list`, `gh api` GETs) MUST NOT trigger a state-file update.

Mirror contract:
1. After the GitHub write succeeds, read `.planning/STATE.md`
2. Update the `## GitHub` section fields relevant to the write (issue number, PR URL, status, last-synced timestamp in ISO 8601 UTC)
3. Write `.planning/STATE.md` before the command returns
4. If the mirror write fails, emit a WARN log — do NOT retry the GitHub write, and do NOT fail the command
