---
name: legion:start
description: Initialize a new project through the CLI-owned intake interview
argument-hint: "[--from-exploration <runId>]"
allowed-tools: [Bash, Read, AskUserQuestion]
---

<objective>
Render the intake interview that `legion start` drives. The CLI owns the question graph, the validation, and the decision that the interview is finished. Your job is to display each question, collect the answer, and hand it back.
</objective>

<authority>
You are not the interviewer. You are the screen the interview is displayed on.

Do not decide what to ask, in what order, or when enough has been asked. Do not merge several questions into one. Do not answer on the user's behalf, infer an answer from earlier context, or fill a field because it seems obvious. If you think a question is redundant, ask it anyway and say so afterwards.

This is deliberate rather than fussy. An interview owned by a conversation ends when the conversation loses interest, and the project that results looks identical to one that was interviewed properly — nothing records what was never asked. Owning the graph in the CLI is what makes "did we ask?" a checkable fact instead of a recollection.
</authority>

<process>
1. START OR RESUME

   ```
   legion start --next --json
   ```

   The payload is either `{"status":"question", ...}` or `{"status":"complete"}`. If it lists `availableExplorations` and the user wants to build on one, restart with `legion start --from-exploration <runId>` before answering anything — seeding only applies when the session is created.

2. RENDER THE QUESTION

   Read `question` from the payload:

   - `prompt` is the question. Show it verbatim.
   - `help`, when present, belongs with it.
   - `options`, when present, is the complete set of choices. Use AskUserQuestion with exactly those options. Never invent one, never drop one.
   - `kind` is `single`, `multi`, `free-text`, or `confirm`.
   - `proposal`, when present, came from an exploration. Show it labelled as a proposal, with its `confidence` and `rationale`. It is a suggestion, not an answer.
   - `injected: true` means the question exists because exploration left something unresolved. Say so — it tells the user why they are being asked something the base graph did not contain.
   - `required: false` means it may be declined.

   Use `session.answered` and `session.total` for progress.

3. RECORD THE ANSWER

   ```
   legion start --answer "<nodeId>=<value>"
   ```

   One answer per invocation. The command validates it, writes it to disk, and returns the next question in the same shape, so the loop is: read, render, record, repeat.

   Variants:
   - `legion start --accept-proposal` takes the exploration's value, recorded as `proposed-accepted` so the provenance survives into the requirement set.
   - `legion start --skip` declines an optional question.
   - `legion start --back` undoes the most recent answer.

   If the CLI returns `{"status":"rejected"}`, show its diagnostics and put the same question again. Do not reshape the answer yourself to make it pass.

4. FINALIZE

   When the payload reports `{"status":"complete"}`:

   ```
   legion start --finalize
   ```

   This writes `.legion/project/requirements/`, seeds the constitution with the recorded constraints and non-goals, initializes `project.json`, and renders `ROADMAP.md` as a view of the requirement set.

   Finalize refuses when the answers do not make a contract: a `must` requirement with no acceptance criteria, a `manual` proof with no stated reason, a budget that cannot be satisfied. Show the diagnostics and reopen the questions they name. Do not work around a refusal.

5. REPORT

   Show the requirement count, the `requirementSetHash`, and the next action the CLI returned. If it warned that `ROADMAP.md` was left alone, say so plainly — a roadmap this command did not write is never replaced without `--force-roadmap`.
</process>

<batch_mode>
`legion start --intake <file>` applies a JSON object of `nodeId → answer` through the same state machine and the same validators as the interactive path. It stops at the first missing or invalid answer and names it, keeping everything before the gap so a corrected file resumes rather than restarts.

`legion start --name <name>` initializes a project without an interview. It produces no requirements and warns that it did. Use it only when a bare project is genuinely what is wanted.
</batch_mode>

<inspection>
- `legion start --session-status` reports progress and every recorded answer with its source, changing nothing.
- `legion start --abort` closes a session without finalizing.
- State lives in `.legion/project/intake/<sessionId>/session.json`. If you have lost the thread, read it — or just run `--next` again, which is derived from that same file.
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
