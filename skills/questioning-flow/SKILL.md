---
name: questioning-flow
description: How to render Legion's CLI-owned intake interview, and how to run the conversations Legion does not own
triggers: [start, initialize, project, question, discovery, setup]
token_cost: low
summary: "Rendering guide for `legion start`. The CLI owns the intake question graph; this describes how to display it well. Also covers the adaptive pattern for conversations with no graph behind them, such as explore and agent creation."
---

# Questioning Flow

This skill used to be the interview. It is now the rendering guide for one, plus the conversational pattern for the places Legion has no graph.

The change matters more than it looks. When the questions lived here, "how many did we ask?" was a property of a conversation — unrecorded, unbounded, and shortened by any model that decided it had heard enough. The questions now live in `packages/cli/src/workflow/intake/graph.ts`, are versioned as `graphVersion`, and every answer is written to `.legion/project/intake/<sessionId>/session.json` as it is given. A skipped question is now a thing you can point at.

---

## Section 1: Which mode you are in

| Situation | Who owns the questions | What this skill gives you |
|-----------|------------------------|---------------------------|
| `/legion:start` — project intake | The CLI, via `legion start --next --json` | Section 2: how to render it |
| `/legion:explore` — freeform brainstorm | Nobody; divergence is the point | Section 3: the adaptive pattern |
| `/legion:agent` — agent creation | Nobody | Section 3 |

If a CLI command will emit the question, you render it. If no CLI command will, Section 3 applies.

---

## Section 2: Rendering the intake interview

The full command surface is in `commands/start.md`. This section is about doing it *well*, not about the protocol.

### The loop

`legion start --next --json` returns a question; `legion start --answer "<nodeId>=<value>"` records one and returns the next. Each invocation is a separate process reading the same file, so there is nothing to hold in memory between them.

### Rendering rules

1. **Show `prompt` verbatim.** Rephrasing a question changes what was asked while the record still says otherwise.

2. **Use `options` exactly.** When the payload carries `options`, that array is the complete choice set. Pass them to AskUserQuestion unchanged — same values, same order, none added, none dropped. The host may add its own "Other"; you may not add one to the option list.

3. **Show `help` with the question, not after the answer.** It is usually the sentence that makes the question answerable.

4. **Label a `proposal` as a proposal.** When an exploration seeded the session, some questions arrive with a suggested value, its `confidence` (`researched`, `inferred`, or `assumed`), and a `rationale`. Show all three. `assumed` means the brainstorm guessed — say so. Accepting one uses `legion start --accept-proposal`, which records `source: proposed-accepted` and the exploration it came from, so a later reader can tell a decision from an unchallenged suggestion.

5. **Explain an `injected` question.** `injected: true` means the question exists because exploration flagged something unresolved. Users notice questions that were not in the original set; tell them where it came from.

6. **Report progress from `session.answered` / `session.total`.** `total` grows as loops expand — that is correct, not a bug, and worth saying once if a user notices the denominator moving.

7. **Relay a rejection, do not repair it.** On `{"status":"rejected"}`, show the diagnostics and put the same question again. Rewriting the user's answer so it passes is the failure this whole design exists to prevent.

### The two questions worth slowing down on

**Acceptance criteria.** Each criterion asks how it is proven: a command, or a stated reason no command can decide it. This is the point where a project either gets checkable acceptance or does not. If the user reaches for `manual`, it is worth asking once whether a command exists — and then recording `manual` without argument if they say no. A `manual` criterion with an honest reason is a known gap; a fabricated command is a false pass.

**Blast-radius budgets.** Users tend to enter a number large enough that nothing will ever hit it, which produces a limit that never fires. The budget blocks rather than warns, so a smaller number forces decomposition — which is the intent. Say that once, then take whatever they choose.

---

## Section 3: The adaptive pattern, for conversations with no graph

Use this in `/legion:explore` and `/legion:agent`, where wide latitude is correct because nothing produced is authoritative. Exploration output enters intake as proposals that must still be confirmed, so a wrong guess there costs a question, not a contract.

1. **Vision first, technology second.** Understand what the user wants to exist before asking how to build it.
2. **Adaptive depth.** Follow the user's energy. Deep answer, go deeper; terse answer, move on.
3. **Infer where possible, confirm where uncertain.** State the inference and let them correct it, rather than asking about something they already told you.
4. **Prefer bounded choices.** Offer a finite option set with an explicit escape hatch when the space is genuinely open. A bounded question is faster to answer and produces a cleaner record. This is a strong default of this skill, not a rule imported from elsewhere — earlier versions cited a "CLAUDE.md mandate" and a `adapter.prompt_free_text` primitive, neither of which exists in this repository.
5. **Free text is just the user typing.** There is no free-text adapter call. When an option needs elaboration, ask and let them answer normally.
6. **Summarize between stages and close with a bounded confirmation.** `Looks correct` / `Correct a specific field` / `Add missing detail` / `Cancel` beats "anything to add?".
7. **Aim for a handful of exchanges, not twenty.** In exploration, effort is the constraint. In intake it is not — that interview is as long as the contract requires, and shortening it is not yours to do.

---

## Section 4: Templates

`templates/project-template.md`, `templates/roadmap-template.md`, and `templates/state-template.md` belong to the legacy `.planning/` line and are read by the migration importer.

`legion start --finalize` does not use them. It writes typed requirements to `.legion/project/requirements/` and renders `ROADMAP.md` from that set, because a rendered view can be regenerated and prose that a model rewrites in place cannot be trusted to still say what was agreed.
