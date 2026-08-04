---
name: legion:learn
description: Record, recall, and manage project-specific patterns, pitfalls, and preferences
argument-hint: <lesson> [--recall <topic>] [--list]
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion]
---

<objective>
Explicitly record patterns, pitfalls, and preferences to project memory. Recall relevant learnings during planning and execution.

Purpose: Build project-specific institutional knowledge that persists across sessions.
Output: A lesson artifact and an appended entry in the CLI's lesson index.
</objective>

<execution_context>
skills/workflow-common-core/SKILL.md
skills/memory-manager/SKILL.md
</execution_context>

<context>
</context>

<authority>
The CLI owns the record. `legion learn "<lesson>" --type <kind> --tags <a,b>
--summary "<one line>"` writes it and maintains the index; `--recall <topic>`
searches with a tag match scoring 3, a summary match 2, and a body match 1;
`--list` groups by kind.

What stays here is the conversation: classifying the lesson and confirming that
classification, deriving the tags and summary to record, and offering to
continue with another lesson.
</authority>

<process>
1. PARSE MODE
   Read $ARGUMENTS to determine operating mode:

   - If $ARGUMENTS contains `--recall <topic>`: set MODE=recall, extract topic text
   - If $ARGUMENTS contains `--list`: set MODE=list
   - If $ARGUMENTS contains `--prune`: display the removal note below and exit.
     The verb has no prune mode, so routing to one would leave the host with
     nothing to execute.
   - If $ARGUMENTS is non-empty (and no flags): set MODE=record, store full text as lesson
   - If $ARGUMENTS is empty or missing:
     Display:
     "Usage: `/legion:learn <lesson>`
      Record a pattern, pitfall, or preference to project memory.

      Examples:
        `/legion:learn Always run migrations in a transaction`
        `/legion:learn --recall migrations`
        `/legion:learn --list`

      Modes:
        `<lesson>`         — Record a new learning
        `--recall <topic>` — Search memory for relevant learnings
        `--list`           — Show all recorded learnings by type"
     Exit — do not proceed

2. LOAD PROJECT CONTEXT (optional)
   - Attempt to read legion status --json
   - If found: extract project name, current phase from STATE.md
   - If not found: proceed without project context
     - Learn works with or without an initialized project
   - Do not create or check any directory. The verb owns the lesson index and
     creates it on first record; recall and list over an absent index return an
     empty result rather than an error, which is the correct answer to "what
     have we learned" before anything has been.

3. ROUTE BY MODE
   - MODE=record → go to Step 4
   - MODE=recall → go to Step 8
   - MODE=list → go to Step 9

4. CLASSIFY LESSON
   Analyze the lesson text to determine its type:

   **Pattern**: A reusable approach that works well
   - Signals: "always", "use", "prefer", "works well", "best practice", positive framing
   - Example: "Always use atomic commits for design system changes"

   **Pitfall**: A mistake or problem to avoid
   - Signals: "don't", "never", "avoid", "causes", "breaks", "watch out", negative framing
   - Example: "Don't run database migrations without a backup"

   **Preference**: A team or project convention or choice
   - Signals: "we use", "prefer X over Y", "convention", "standard", "our approach"
   - Example: "We prefer Tailwind utility classes over CSS modules"

   Present classification via adapter.ask_user:
   "I classified this as a **{type}**. Correct?"
   Options:
   - "Correct" — "Save as {type}"
   - "It's a pattern" — "Reusable approach that works"
   - "It's a pitfall" — "Mistake or problem to avoid"
   - "It's a preference" — "Team/project convention"

   Use the user's confirmed type for the next steps.

5. ENRICH
   Add contextual metadata to the learning:
   a. **Tags**: Extract relevant keywords from the lesson text
      - Technical terms (e.g., "migrations", "auth", "API", "CSS")
      - Domain terms (e.g., "testing", "deployment", "design")
      - Generate 2-5 tags
   b. **Phase context**: Note current phase/milestone from STATE.md (if available)
   c. **Summary**: Generate a one-line summary (max 80 characters)
   d. **ID**: do not generate one. The verb uses the recording run's ID, which is
      unique without reading any existing file. Sequential per-type IDs were a
      v8 artifact of three separate markdown files and cannot be assigned
      without a read-then-write race.

6. RECORD

   One call. The verb writes the lesson artifact and appends to the index; do
   not write either yourself.

   ```
   legion learn "<lesson text>" --type <pattern|pitfall|preference>      --tags "<comma-separated>" --summary "<one line>" --json
   ```

   Pass the enrichment from step 5 through the flags. `--type` is optional; an
   unclassified lesson is still recorded and still counted.

   Display from the payload:
   "{kind} recorded: {runId} — {summary}
    Artifact: {lessonArtifactPath}
    Index: {indexArtifactPath} ({lessonCount} recorded)"

   `legion plan` reports outstanding retrospective actions, and `legion learn
   --recall` searches both lessons and retrospective findings, so a recorded
   lesson is reachable from the next planning pass.

7. OFFER CONTINUATION
   Present via adapter.ask_user:
   "Record another learning?"
   Options:
   - "Yes" — "Record another pattern, pitfall, or preference"
   - "Done" — "Exit learning mode"

   If "Yes": prompt for the next lesson text and return to Step 4
   If "Done": Display "Run `/legion:learn --recall <topic>` to search your learnings." → Exit

8. RECALL MODE

   `legion learn --recall "<topic>" --json` is the search. It owns the corpus and
   the scoring; render what it returns.

   - `corpus` names what was searched: `lessons` and `retrospectives`. Show it.
     A recall that answered from a narrower corpus than the caller assumed is
     indistinguishable from one that found nothing, which is why the verb
     reports it.
   - `matches` are pre-ranked. Each carries `source` (`lesson` or
     `retrospective`), `score`, `kind`, `summary` and `artifactPath`.
   - Scoring is the verb's: for a lesson, a tag match counts 3, a summary match
     2, a body match 1. A retrospective finding has no tags, so it scores on
     title (2) and body (1).

   Display:

   # Learnings: "{topic}"

   {count} entries found across {corpus}:

   **{id}** ({source}/{kind}) — {summary}
   > {artifactPath}

   If `matches` is empty:
   "No learnings found for '{topic}'.
    Try `/legion:learn --list` to see all entries, or `/legion:learn <lesson>` to record a new one."

   Do not search files yourself to supplement the result. A model's reading of
   the repository added to a scored search produces a ranking whose entries came
   from two different rules, and nothing downstream can tell which.

9. LIST MODE

   `legion learn --list --json` returns every recorded lesson grouped by kind —
   `pattern`, `pitfall`, `preference`, and the unclassified ones. Render its
   grouping; do not regroup.

   # Project Learnings

   ## {Kind} ({count})
   | ID | Summary | Tags | Date |
   |----|---------|------|------|
   | {id} | {summary} | {tags} | {date} |

   **Total**: {total} learnings recorded

   If every group is empty:
   "No learnings recorded yet.
    Start with `/legion:learn <lesson>` to record your first pattern, pitfall, or preference."

IMPORTANT:
- Learn works with or without an initialized Legion project; the verb creates the index on first record
- IDs are the recording run's ID, so they are unique and never reused
- Tags are taken from `--tags`, not invented; the verb stores what it was given
- Recall searches lessons and retrospective findings, and says so in `corpus`
- All user-facing questions use adapter.ask_user (AskUserQuestion tool)
- The command never modifies phase artifacts, the roadmap, or any change bundle
- Prune mode is a recorded deliberate removal, and is removed from the argument
  hint, the usage text, and mode routing along with its step. It archived
  `OUTCOMES.md` records older than `memory.prune_threshold` into a separate
  archive file. `memory.prune_threshold` does still exist in `settings.json` and
  `docs/settings.schema.json` — what does not exist is `OUTCOMES.md`, any
  archive path, or a verb that prunes anything. The lesson index is one
  committed JSON artifact, and no verb removes entries from it, so the mode had
  nothing to operate on. If pruning returns it is new work against `.legion`
  artifacts, not preservation of this.
</process>
