---
name: legion:milestone
description: Milestone management — status, definition, completion, and archiving
argument-hint: "--status | --define <name> --phases <range> | --complete <id> --summary <text> | --archive <id>"
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion]
---

<objective>
Display milestone status, define milestone groupings, mark milestones complete with summaries, and archive completed milestone artifacts. Handles the full milestone lifecycle through a single command.

Purpose: Single command for milestone lifecycle management — definition, tracking, completion, and archiving.
Output: Milestone dashboard with actionable operations.
</objective>

<execution_context>
skills/workflow-common-core/SKILL.md
skills/milestone-tracker/SKILL.md
skills/execution-tracker/SKILL.md
</execution_context>

<context>
If `legion` is not found, use `npx legion-ascended` instead.
</context>

<authority>
The CLI owns the milestone record. `legion milestone --status --json` reads
without writing; `--define`, `--complete` and `--archive` mutate and are
recorded. Completing a milestone that is already completed or archived is
refused, so a recorded summary cannot be silently overwritten.

`--phases` is parsed, not stored verbatim. `1-3`, `1,2,5`, `1-3,7` and `4` are
the accepted forms; an unparseable range is refused at `--define` rather than
committed. That parse is what lets the verb join a milestone to its phases, so:

- `--status` reports real progress — completed of covered phases, a bar, and a
  per-phase table naming each phase's change and why an incomplete one is
  incomplete. Do not compute progress yourself.
- `--complete` refuses while any covered phase is incomplete, naming each one.
  The command's "no partial completions" rule is now the verb's.
- A milestone defined before the parser existed holds free text. It is reported
  as `Progress: unresolvable` with the parse error, not as zero progress: a
  milestone nobody can evaluate is a different thing from one with nothing done.

What stays here is what no verb performs: clustering roadmap phases into
proposed groupings, the interactive action loop, the archive confirmation, the
completion commit, and closing the GitHub milestone. No git commit and no gh
invocation exists anywhere in the CLI.
</authority>

<process>
0. CONDITIONAL SKILL LOADING
   - `skills/github-sync/SKILL.md` only if `gh auth status` succeeds and a git remote exists.
   If the condition is not met, skip silently and continue.

1. CHECK PROJECT EXISTS
   - Attempt to read legion status --json
   - If not found:
     Display:
     "No Legion project found in this directory.
      Run `/legion:start` to initialize a new project."
   - Exit — do not proceed to step 2

2. READ PROJECT STATE
   Read these files:
   a. legion status --json — extract project name
   b. legion validate --json — extract:
      - Phase list with status from Progress table
      - Milestones section (if it exists)
   c. legion status --json — extract current phase and status

3. CHECK MILESTONES DEFINED
   Look for `## Milestones` section in ROADMAP.md.

   If NOT found:
     Display:
     "# {project_name} — Milestones

      No milestones defined yet.
      Milestones group phases into major deliverables for tracking and archiving."

     Present via adapter.ask_user:
     "Would you like to define milestones for this project?"
     Options:
     - "Define milestones" — "Analyze phases and propose logical milestone groupings"
     - "Skip for now" — "Return without defining milestones"

     If "Define milestones": Go to Step 7 (DEFINE MILESTONES)
     If "Skip for now": Display "Run `/legion:milestone` anytime to set up milestones." → Exit

   If found: proceed to Step 4

4. DISPLAY MILESTONE STATUS

   ```
   legion milestone --status --json
   ```

   One call. The verb computes progress by joining each milestone's parsed phase
   range to the changes behind those phases and asking whether each is complete.
   Render what it returns.

   Do **not** read the ROADMAP.md Progress table for this. That table is written
   once by `legion start --finalize` and never updated, so every row reads
   Pending forever — a progress report built from it would be wrong on every
   project that has done any work.

   # {project_name} — Milestones

   | # | Milestone | Phases | Progress | Status |
   |---|-----------|--------|----------|--------|
   | 1 | {name} | {phases} | [{bar}] {done}/{total} | {status} |

   Then, for the milestone the operator is acting on, show its per-phase rows as
   the verb reported them:

   | Phase | Change | State |
   |-------|--------|-------|
   | {N} | {changeId} | complete \| not planned \| {reason} |

   A milestone whose range does not parse reports `Progress: unresolvable` with
   the parse error. Show that verbatim; it is a repairable finding, not zero
   progress.

5. PRESENT OPTIONS
   Based on milestone state, determine available actions:

   **Always available**:
   - "View milestone details" — "Deep dive into a specific milestone's phases and deliverables"
   - "Done" — "Return to normal operation"

   **If any milestone has Status = "In Progress" and ALL its phases are "Complete"**:
   - "Complete milestone {N}" — "Mark '{name}' done and generate summary with metrics"

   **If any milestone has Status = "Complete" (not yet Archived)**:
   - "Archive milestone {N}" — "Move '{name}' phase files to archive to reduce clutter"

   **If milestones need redefinition**:
   - "Redefine milestones" — "Re-analyze phase groupings and update milestone boundaries"

   Present options via adapter.ask_user:
   "What would you like to do?"

6. HANDLE USER CHOICE

   **Path A: View milestone details**
   - If multiple milestones: ask which one (adapter.ask_user with milestone names)
   - Display full details for the selected milestone:
     - Goal, phase range
     - Per-phase breakdown: plan count, key deliverables from SUMMARY.md files
     - Requirement coverage: which requirements are satisfied by this milestone's phases
     - If milestone is Complete or Archived: show the summary `legion milestone --status --json` reports
   - Return to Step 5

   **Path B: Complete milestone**
   Follow milestone-tracker Section 3 (Milestone Completion):
   a. Run pre-flight checks — all phases must be Complete
   b. If checks fail: report incomplete phases, return to Step 5
   c. Generate milestone summary:
      - Gather metrics (plans, requirements, files, agents)
      - Gather qualitative data (outcomes, decisions)
      - `legion milestone --complete <id> --summary "<text>"` records it; the CLI owns the index
   d. Mark milestone complete in ROADMAP.md
   e. Update STATE.md with milestone completion
   f. Create git commit following execution-tracker Section 6 milestone completion format:
      ```
      git add .legion/project/workflow/milestone/milestones.json
      git add {the other files the milestone completion touched}
      # .legion/project/ is committed intent and must be staged: legion milestone
      # --complete writes the authoritative record there, and a commit that marks
      # the milestone complete without it leaves a fresh checkout disagreeing and
      # the working tree dirty. Never stage .legion/var/, which is operational.
      git commit -m "chore(legion): complete milestone {N} — {name}

      Phases {start}-{end}: {count} phases, {plans} plans
      Requirements: {req_count} satisfied
      Summary: {summary}

      {adapter.commit_signature}"
      ```
   f2. CLOSE GITHUB MILESTONE (optional — follows github-sync Section 8)
       - Check GitHub availability: gh auth status && git remote get-url origin
       - If github_available and STATE.md ## GitHub section has a milestone number for this milestone:
         Close the GitHub milestone: gh api "repos/{REPO_SLUG}/milestones/{number}" --method PATCH -f state=closed
         (github-sync Section 4.2)
       - If github_available is false: skip silently

   g. Display:
      "Milestone {N}: {name} — Complete!
       Summary recorded on the milestone; `legion milestone --status --json` reports it
       Run `/legion:milestone` to archive when ready."
   - Return to Step 5

   **Path C: Archive milestone**
   Follow milestone-tracker Section 4 (Milestone Archiving):
   a. Run pre-flight checks — milestone must be Complete, summary must exist
   b. If checks fail: report what's missing, return to Step 5
   c. Confirm with user:
      "Archive Milestone {N}: {name}?
       This marks the milestone archived and moves nothing. Phase and change artifacts
       stay exactly where they are, and remain readable at their current paths."
      Options: "Archive" / "Cancel"
   d. If Cancel: return to Step 5
   e. If Archive:
      - `legion milestone --archive <id>` records the archive; no directory is created and nothing is moved
      - Update ROADMAP.md: milestone Status → Archived, phase rows get "(Archived)" note
      - Update STATE.md: condense archived phase results, update Milestones section
      - Update milestone summary: add archive date
   f. Create git commit following execution-tracker Section 6 milestone archive format:
      ```
      git add .legion/project/workflow/milestone/milestones.json
      git add {the other files the archive touched}
      # Same rule as the completion commit: .legion/project/ is committed intent
      # and legion milestone --archive writes the record there. Never `git add -A`,
      # which would stage the operational .legion/var/.
      git commit -m "chore(legion): archive milestone {N} — {name}

      Milestone marked archived; no artifacts relocated
      STATE.md and ROADMAP.md updated

      {adapter.commit_signature}"
      ```
   g. Display:
      "Milestone {N}: {name} — Archived!
       Nothing was moved: phase and change artifacts remain at their current paths
       Summary preserved on the milestone record; `legion milestone --status --json` reports it"
   - Return to Step 5

   **Path D: Redefine milestones**
   - Go to Step 7 (DEFINE MILESTONES) — overwrites existing milestone definitions

   **Path E: Done**
   - Display: "Milestone view closed. Run `/legion:milestone` anytime for milestone management."
   - Exit

7. DEFINE MILESTONES
   Follow milestone-tracker Section 2 (Milestone Definition):
   a. Read ROADMAP.md phase list — all phases with names and goals
   b. Analyze for logical groupings:
      - Look for theme clusters (infrastructure, features, integrations, etc.)
      - Consider dependency chains
      - Use as many milestones as the roadmap needs; there is no fixed phase-count limit per milestone
   c. Present proposed milestones:
      "Based on your {count} phases, here are proposed milestone groupings:"

      | # | Milestone | Phases | Goal |
      |---|-----------|--------|------|
      | 1 | {name} | {start}-{end} | {goal} |
      ...

   d. Ask via adapter.ask_user:
      "Accept these milestone groupings?"
      Options:
      - "Accept" — "Use these milestone definitions"
      - "Modify" — "Let me adjust the groupings"

   e. If "Modify": Ask for specific changes (which phases to regroup, new names, etc.)
   f. If "Accept" or after modifications:
      - Write ## Milestones section to ROADMAP.md per milestone-tracker Section 2
      - Derive initial status for each milestone:
        - All phases Complete → "Complete"
        - Any phase In Progress or later → "In Progress"
        - All phases Pending → "Pending"
      - Display: "Milestones defined in ROADMAP.md. {count} milestones covering {total_phases} phases."
   g. Return to Step 4 to display the newly defined milestone status

IMPORTANT:
- The command always starts by checking if milestones are defined — definition is a prerequisite
- Completion requires ALL phases in the milestone to be Complete — no partial completions
- Archiving is separate from completion — users can keep completed milestones without archiving
- Archive confirmation asks the user explicitly (destructive-ish operation — moving files)
- Git commits use execution-tracker Section 6 conventions
- The action loop (Steps 5-6) keeps the user in milestone context until they choose "Done"
- All operations handle missing/stale state gracefully
</process>
