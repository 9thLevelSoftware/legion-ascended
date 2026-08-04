---
name: legion:retro
description: Run a structured retrospective on completed phases or milestones
argument-hint: "[--dry-run]"
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, Agent, AskUserQuestion]
---

<objective>
Review completed phases/milestones, identify what worked and what didn't, surface reusable patterns, and record findings to memory for future planning.

Purpose: Structured team retrospective after build/review cycles — learn from what happened.
Output: Retrospective report with actionable findings written to recorded learning
</objective>

<execution_context>
skills/workflow-common-core/SKILL.md
skills/memory-manager/SKILL.md
skills/execution-tracker/SKILL.md
</execution_context>

<context>
</context>

<authority>
The CLI owns the retrospective artifact. `legion retro --json` gathers the
project's committed evidence, puts it in front of the executor, and records the
result. `--dry-run` runs the analysis and writes nothing.

`--phase N` scopes the evidence to that phase's change, resolved by the derived
`chg_phase-<N>-` ID — the only phase-to-change link that exists. It refuses on a
phase that was never planned, and on one that is not complete, because a
retrospective runs on completed work.

`--milestone M` stays refused: a milestone's phases are recorded as free text
that nothing parses, so there is no set of changes to gather evidence from. A
retrospective is never labelled with a scope it did not use.

What stays here is the save decision, the edit-before-saving path, and the
cross-project mode, none of which any verb performs.
</authority>

<process>
0. DRY-RUN MODE
   - Check if $ARGUMENTS contains `--dry-run`
   - If present: set DRY_RUN=true, strip flag from arguments
   - In dry-run mode: display all analysis and findings but skip writing any files
   - Display: "DRY RUN — retrospective will be displayed but not saved"

1. CHECK PROJECT EXISTS
   - Attempt to read legion status --json
   - If not found:
     Display:
     "No Legion project found in this directory.
      Run `/legion:start` to initialize a new project."
   - Exit — do not proceed to step 2

2. PARSE ARGUMENTS
   - `--dry-run`: run the analysis and write nothing. Pass it straight through.
   - `--phase <N>`: scope the evidence to that phase's change. Pass it through.

     ```
     legion retro --phase <N> --json
     ```

     The verb refuses if the phase was never planned, or if it is not yet
     complete — evidence, counts and summary all narrow to that one change, so a
     scoped label always means scoped evidence.
   - `--milestone <M>`: refused by the verb, for the reason in `<authority>`.
     Run it so the operator sees the refusal, then offer `--phase` instead.

3. READ PROJECT STATE
   ```
   legion status --json
   ```
   `workflowState.projectId` names the project and `workflowState.stage` says where it
   stands. `legion validate --json` adds requirement coverage when the retrospective
   needs it.

4. CONDITIONAL SKILL LOADING
   - `skills/memory-manager/SKILL.md` only when `legion learn --list --json` reports recorded learning
   - With no recorded learning, the recall steps are skipped rather than failing

5. GATHER DATA
   For the target scope (phase or milestone phases):
   The CLI gathers the evidence and puts it in front of the executor. Run
   `legion retro --dry-run --json` first to see exactly what it will draw on.
   a. `evidence` in that payload carries the counts: changes recorded, tasks
      planned across them, reviews with a passing verdict, and recent runs.
   b. `legion review --json` reports the recorded review decisions for the
      current change — findings, verdicts, and whether a task needed more than
      one cycle.
   c. `legion learn --recall <topic> --json` returns prior lessons relevant to
      the scope, scored by tag, summary and body match.
   d. `legion learn --list --json` reports what learning already exists, so the
      retrospective can add to it rather than restate it.

6. ANALYZE
   For the gathered data, produce analysis across five categories:

   **What Went Well**
   - Phases/plans completed on schedule (SUMMARY.md exists with all tasks done)
   - Agents that excelled: high review pass rates, no escalations, clean handoffs
   - Patterns that worked: verification commands that caught issues, wave structure that enabled parallelism
   - Review cycles that passed on first attempt

   **What Didn't Work**
   - Review cycles that exceeded 2 iterations (extract from REVIEW.md cycle count)
   - Escalations that blocked progress (blocker-severity from SUMMARY.md)
   - Agent mismatches: agents assigned to tasks outside their specialty (cross-reference agent metadata with task types)
   - Plans with missing or incomplete SUMMARY.md sections
   - Verification commands that failed repeatedly

   **Patterns to Keep**
   - Recurring successful approaches across multiple plans/phases
   - Agent combinations that produced clean handoffs
   - Task decomposition strategies that led to first-pass reviews
   - Wave structures that maximized parallel execution

   **Patterns to Drop**
   - Recurring problems that appeared in multiple phases
   - Agent assignments that consistently required rework
   - Plan structures that led to scope creep or file conflicts
   - Processes that added overhead without catching real issues

   **Action Items**
   - Specific, actionable improvements for future phases
   - Agent recommendation adjustments (e.g., "prefer {agent} for {task_type}")
   - Process changes (e.g., "add integration test verification to all API plans")
   - Each action item should reference the evidence that motivated it

7. PRESENT FINDINGS
   Display the formatted retrospective report:

   # Retrospective: {scope_description}
   **Project**: {project_name}
   **Scope**: Phase {N} | Milestone {M} ({name}) — Phases {start}-{end}
   **Date**: {current_date}

   ## What Went Well
   {bulleted findings with evidence references}

   ## What Didn't Work
   {bulleted findings with evidence references}

   ## Patterns to Keep
   {bulleted patterns with examples}

   ## Patterns to Drop
   {bulleted patterns with examples}

   ## Action Items
   | # | Action | Priority | Evidence |
   |---|--------|----------|----------|
   | 1 | {action} | High/Medium/Low | {which phase/plan revealed this} |
   ...

   ## Metrics
   - Plans completed: {count}
   - Review pass rate: {first_pass_count}/{total} ({pct}%)
   - Escalations: {count} ({blocker_count} blockers)
   - Agents used: {count} ({list})
   - Files modified: {count}

8. ASK USER
   Present via adapter.ask_user:
   "Save retrospective findings to memory?"
   Options:
   - "Save to memory" — "Record findings to recorded learning for future planning context"
   - "View only (don't save)" — "Retrospective displayed but not persisted"
   - "Edit before saving" — "Make adjustments to findings before recording"

   If DRY_RUN=true: skip this step, display "DRY RUN — skipping save" and exit

9. HANDLE SAVE CHOICE

   **Path A: Save to memory**
   - If recorded learning does not exist: create the directory
   - If recorded learning does not exist: create with header:
     ```
     # Retrospective Log

     Retrospective findings from completed phases and milestones.
     Referenced by `/legion:plan` for continuous improvement.
     ```
   - Append the retrospective entry:
     ```
     ## {scope_description} — {current_date}

     ### Key Findings
     {condensed what went well / what didn't}

     ### Action Items
     {action items table}

     ### Metrics
     {metrics summary}

     ---
     ```
   - Display: "Retrospective saved to recorded learning"
   - After recording: output reminder
     "Retro findings are automatically available to `/legion:plan` during decomposition.
      Action items from this retro will appear as constraints in future phase planning."

   **Path B: View only**
   - Display: "Retrospective not saved. Run `/legion:retro` again to revisit."
   - Exit

   **Path C: Edit before saving**
   - Present the condensed findings via adapter.ask_user:
     "Which sections need changes?"
     Options: "What Went Well" / "What Didn't Work" / "Patterns" / "Action Items" / "Looks good — save as-is"
   - For each selected section: accept user corrections and update findings
   - After edits: proceed to Path A (save)

10. CROSS-PROJECT MODE
    If invoked from `/legion:portfolio` context (detected via portfolio state or $ARGUMENTS containing `--portfolio`):
    - Iterate across all projects in the portfolio
    - Gather retro data from each project's recorded learning
    - Produce an aggregated retrospective:
      - Common patterns across projects
      - Shared action items
      - Cross-project agent performance trends
    - Display aggregated findings
    - Offer to save to the portfolio-level recorded learning

IMPORTANT:
- Retrospectives are read-only analysis of completed work — they never modify phase files or plans
- The command degrades gracefully: missing SUMMARY.md, REVIEW.md, or OUTCOMES.md files produce warnings but don't block the retrospective
- Evidence references tie every finding back to a specific phase/plan/file — no unsupported claims
- Action items are concrete and specific, not vague suggestions
- Memory recording follows memory-manager conventions for format and structure
- All user-facing questions use adapter.ask_user (AskUserQuestion tool)
</process>
