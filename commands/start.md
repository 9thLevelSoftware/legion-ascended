---
name: legion:start
description: Prepare, review, and accept an intake contract before the remaining interview
argument-hint: "[--goal <text>|--without-exploration|--stage-draft <file>|--accept-draft|--discard-draft]"
allowed-tools: [Bash, Read, AskUserQuestion]
---

<objective>
Run the CLI-owned preflight, prepare a repository-grounded intake draft, then render the interview that `legion start` drives. The CLI owns project mode, map state, the question graph, validation, persistence, and every transition. The host owns semantic repository review and draft composition.
</objective>

<authority>
You are not the interviewer. You are the screen the interview is displayed on.

Do not decide what to ask, in what order, or when enough has been asked. Do not merge several questions into one. Do not answer on the user's behalf, infer an answer from earlier context, or fill a field because it seems obvious. If you think a question is redundant, ask it anyway and say so afterwards.

This is deliberate rather than fussy. An interview owned by a conversation ends when the conversation loses interest, and the project that results looks identical to one that was interviewed properly — nothing records what was never asked. Owning the graph in the CLI is what makes "did we ask?" a checkable fact instead of a recollection.
</authority>

<process>
1. PREPARE AN INITIATIVE

   Run `legion start --json`. Supply an explicit user statement or edit with `--goal <text>`. Otherwise use the automatically selected exploration initiative. Ask the one free-text initiative question only when the CLI returns `initiative_required`.

   Precedence is explicit user statements and edits, then selected exploration proposals, then repository inference. Never replace an explicit goal with an inference.

2. FOLLOW THE MAP ACTION

   If the CLI returns `map_refresh_required`, run exactly:

   ```
   legion map --refresh --scope . --json
   ```

   Mapping is brownfield-only and full-project. Greenfield and documentation-only projects skip mapping. If refresh fails, run `legion start --map-failed "<diagnostic>" --json`, preserve its prominent DEGRADED COVERAGE warning, and continue only with the bounded direct review it specifies.

3. REVIEW AND STAGE THE DRAFT

   Scope synthesis to the initiative. Perform full architecture analysis and review high-signal README/product documentation, manifests and scripts, entry points, configuration, tests, and CI commands. Treat unrelated product behavior as architecture context only.

   Cite evidence hashes when proposing compatibility obligations, acceptance criteria, executable proof commands, protected tests, constraints, verification defaults, and risk indicators. Conflicts and unsupported assumptions stay unresolved questions. An absent non-goal or constraint is unresolved, never `none`.

   Compose a protocol-valid `IntakeDraft` at `.legion/var/intake-drafts/intake-draft.json`, including exploration/map/direct-file evidence and any degraded warning. This recognized runtime-input location is ignored by authored-source mapping, so composing the draft does not stale the fresh map it cites. Then run:

   ```
   legion start --stage-draft .legion/var/intake-drafts/intake-draft.json --json
   ```

   Do not write preflight/session state or bypass staging.

4. REVIEW AND DECIDE

   The stage command returns `draft_review`; staging does not accept the draft. Display its complete grouped requirements, criteria/proofs, constraints, non-goals, defaults, deduplicated evidence paths/kinds/hashes/anchors, diagnostics, and unresolved items. Its `nextAction.type` is `human_decision`, so pause and ask rather than executing it.

   - Accept: only after the user explicitly accepts the displayed active draft, run `legion start --accept-draft --json`.
   - Revise: compose a corrected draft under a new ID, stage it through the CLI, and repeat this review step.
   - Discard: run `legion start --discard-draft --json`. The CLI durably closes it without creating a session.

   Both active and supplied-ID decisions are bound to the exact displayed digest. Replacement staging clears the prior review binding; the replacement must be displayed before a decision. Supplied IDs remain compatibility forms, not a way to select stale or undisplayed bytes.

   Preparation edits (`--goal`, `--from-exploration`, `--without-exploration`, and `--map-failed`) belong only to bare preparation or `--stage-draft`. Persist the preparation choice first, then enter the interview with a later `--next`. Accept and discard are terminal decisions: do not combine them with preparation selectors, `--next`, `--session`, or another action.

   Never infer acceptance from silence, earlier approval, or the act of staging.

5. START OR RESUME

   ```
   legion start --json
   ```

   The payload is either `{"status":"question", ...}` or `{"status":"complete"}`. If it lists `availableExplorations` and the user wants to build on one, restart with `legion start --from-exploration <runId>` before answering anything — seeding only applies when the session is created.

6. RENDER THE QUESTION

   Read `question` from the payload:

   - `prompt` is the question. Show it verbatim.
   - `help`, when present, belongs with it.
   - `options`, when present, is the complete set of choices. Use AskUserQuestion with exactly those options. Never invent one, never drop one.
   - `kind` is `single`, `multi`, `free-text`, or `confirm`.
   - `proposal`, when present, came from an exploration. Show it labelled as a proposal, with its `confidence` and `rationale`. It is a suggestion, not an answer.
   - `injected: true` means the question exists because exploration left something unresolved. Say so — it tells the user why they are being asked something the base graph did not contain.
   - `required: false` means it may be declined.

   Use `session.answered` and `session.total` for progress.

7. RECORD THE ANSWER

   ```
   legion start --answer "<nodeId>=<value>"
   ```

   One answer per invocation. The command validates it, writes it to disk, and returns the next question in the same shape, so the loop is: read, render, record, repeat.

   Variants:
   - `legion start --accept-proposal` takes the exploration's value, recorded as `proposed-accepted` so the provenance survives into the requirement set.
   - `legion start --skip` declines an optional question.
   - `legion start --back` undoes the most recent answer.

   If the CLI returns `{"status":"rejected"}`, show its diagnostics and put the same question again. Do not reshape the answer yourself to make it pass.

8. FINALIZE

   When the payload reports `{"status":"complete"}`:

   ```
   legion start --finalize
   ```

   This writes `.legion/project/requirements/`, seeds the constitution with the recorded constraints and non-goals, initializes `project.json`, and renders `ROADMAP.md` as a view of the requirement set.

   Finalize refuses when the answers do not make a contract: a `must` requirement with no acceptance criteria, a `manual` proof with no stated reason, a budget that cannot be satisfied. Show the diagnostics and reopen the questions they name. Do not work around a refusal.

9. REPORT

   Show the requirement count, the `requirementSetHash`, and the next action the CLI returned. If it warned that `ROADMAP.md` was left alone, say so plainly — a roadmap this command did not write is never replaced without `--force-roadmap`.
</process>

<batch_mode>
`legion start --intake <file>` applies a JSON object of `nodeId → answer` through the same state machine and the same validators as the interactive path. It stops at the first missing or invalid answer and names it, keeping everything before the gap so a corrected file resumes rather than restarts.

`legion start --name <name>` initializes a project without an interview. It produces no requirements and warns that it did. Use it only when a bare project is genuinely what is wanted.
</batch_mode>

<inspection>
- `legion start --session-status` reports progress and every recorded answer with its source, changing nothing.
- `legion start --abort` closes a session without finalizing.
- State lives in `.legion/project/intake/<sessionId>/session.json`. If you have lost the thread, run bare `legion start --json`; `--next` remains a compatibility form for explicitly requesting the current interview question, not an alias for the preparation entrance.
</inspection>

<decision_matrix>
| Situation | Action |
|-----------|--------|
| A recent exploration exists and the user wants it | Restart with `--from-exploration <runId>` before answering anything |
| The user wants to explore first | Exit and suggest `/legion:explore`; start does not launch it |
| An answer is rejected | Show the diagnostics, ask the same question again |
| Finalize reports `invalid` | Reopen the questions the diagnostics name; do not route around them |
| `ROADMAP.md` was left alone | Report it; `--force-roadmap` is the user's call, not yours |
| A session is already active | It resumes automatically; use `--abort` only if the user asks to discard it |
</decision_matrix>
