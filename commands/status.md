---
name: legion:status
description: Show where the project stands and what to run next
argument-hint: ""
allowed-tools: [Bash, Read]
---

<objective>
Render the project state that `legion status` computes. The CLI reads the artifacts, derives the stage, and decides the next action. Your job is to display that and stop.
</objective>

<authority>
You are not the state machine. You are the screen its output is displayed on.

Do not derive the stage yourself, do not compute progress from files you read directly, and do not substitute your own next action for the one the CLI returned. If the CLI's answer looks wrong, show it and say why you doubt it — do not quietly correct it.

This matters more here than it looks. Status is the command someone runs *because* they have lost the thread — after a compaction, after a week away. A dashboard assembled from a model's reading of the repository is exactly as trustworthy as that reading, and its errors are invisible: a phase silently omitted looks identical to a phase that does not exist. The CLI reading the artifacts is what makes the dashboard checkable.
</authority>

<process>
1. READ THE STATE

   ```
   legion status --json
   ```

   One call. Everything below comes out of that payload; there is no second source to reconcile it against.

2. RENDER

   Show these in order, omitting a section only when the payload says it is absent:

   - **Stage and project** — `workflowState.stage`, `workflowState.projectId`.
   - **Intake** — from `intake`. `status: "active"` means an interview is open: name `sessionId`, `answered`, and `pendingNodeId`. `status: "unreadable"` means a session is corrupt; show `reason`.
   - **Requirements** — from `requirements`. Show `count` and whether the hash verified. `status: "drifted"` means the requirement set no longer matches its recorded hash; list every `drift` entry.
   - **Traceability** — from `traceability`. Show `planned` of `requirements`, and name the `unplanned` IDs when there are any. `status: "unverifiable"` means the requirement set could not be read, so nothing was checked — report that, never as a clean result.
   - **Specs, map, guidance** — `workflowState.currentSpecCount`, `map.status`, `guidance.latestRuns`.
   - **Diagnostics** — `diagnostics`, when non-empty. Show them; they are why the stage is what it is.

   Do not report interview progress as a percentage. `intake.applicable` is a floor, not a total — the graph grows as answers arrive — so a percentage would fall while the user was making progress. Counts and the pending question are the honest rendering, which is why the CLI emits those and not a fraction.

3. ROUTE

   Show `nextAction.command` and `nextAction.reason` as the recommended next step. It is already the resolved answer: the CLI folds an open interview and a drifted requirement set into it, so it may differ from what the bare stage implies.

   Present it as a recommendation, not an instruction to be executed. Do not run it.
</process>

<inspection>
- `legion status` without `--json` renders the same state as text, if you only need to show it.
- `legion validate` is the deeper check. Status reports drift; validate explains it.
- Nothing in this command writes. If a section is missing, the artifact is missing — that is a finding, not a rendering bug to work around.
</inspection>

<decision_matrix>
| Situation | Action |
|-----------|--------|
| `intake.status` is `active` | Report the open interview and its pending question; the next action resumes it |
| `intake.graphMismatch` is set | Show it; the session was started under a superseded graph and cannot be resumed or finalized by this CLI |
| `intake.status` is `unreadable` | Show `reason`; the session needs repair before the interview can resume |
| `traceability.status` is `unverifiable` | Say traceability could not be checked, and why. It is not a clean result |
| `requirements.status` is `drifted` | Show every drift entry; the next action is `legion validate` and outranks resuming an interview |
| `traceability.unplanned` is non-empty | Name the requirements no task covers |
| `workflowState.stage` is `blocked` | Show `diagnostics`; they are the reason |
| The payload looks wrong | Show it as returned and say what you doubt; do not substitute your own reading |
</decision_matrix>
