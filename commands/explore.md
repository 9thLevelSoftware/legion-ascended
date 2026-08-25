---
name: legion:explore
description: Research and clarify a product idea, then produce a design document before project initialization
mode: inline-persona
inline_persona: polymath
argument-hint: "<topic> [--entry raw-idea|pasted-spec|existing-codebase|link] [--executor claude|codex|manual|fake]"
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion]
---

<objective>
Guide the user through a single design-discovery workflow inspired by Superpowers brainstorming: inspect available context, research the initial ask, ask focused clarifying questions, compare plausible approaches, and save a detailed design document. Do not automatically run `/legion:start`.
</objective>

<execution_context>
skills/workflow-common-core/SKILL.md
skills/questioning-flow/SKILL.md
skills/polymath-engine/SKILL.md
</execution_context>

<context>
Project state comes from the CLI, not from files read directly.

    legion status --json
    legion map --json

If `legion` is not found, use `npx legion-ascended` instead.

Recorded explorations are listed by `legion status --json` under
`guidance.latestRuns`.
</context>

<authority>
The CLI owns the recorded artifact. `legion explore "<topic>" --json` writes the
design document and the typed exploration, marks it exploratory so nothing
downstream treats it as a requirement, and returns their paths.

What stays here is the conversation: the entry-path choice, the bounded research
pass, the clarifying interview, and the approach comparison. That is the whole
value of this command — the verb runs one pass against fixed sections and shares
that implementation with `legion council`, so rendering its payload would
replace a design discussion with a single artifact. Exploration is the one step
where wide latitude is correct, because nothing it produces is authoritative.
</authority>

<process>
1. PRE-FLIGHT CONTEXT INSPECTION
   - Read existing Legion state if present.
   - If `legion map --json` reports a map that is not `absent`, query it with `legion map --query <term> --json` to understand the current project before asking questions.
   - Look for recent explorations in `legion status --json` under `guidance.latestRuns` and offer to resume the latest one or start a new exploration via AskUserQuestion.
   - Do not treat an existing project as a reason to cancel. Existing project context informs the design discussion.

2. CAPTURE THE INITIAL ASK
   - Use AskUserQuestion for the entry path:
     - "Start from a fresh idea" — opens one scoped free-text capture for the raw idea.
     - "Start from an existing exploration" — resume the latest or selected recorded exploration.
     - "Start from project context" — derive exploration candidates from PROJECT/ROADMAP/CODEBASE and ask the user to choose one.
   - The raw idea capture is the only default open-ended input. After that, use focused, bounded choices unless the user explicitly selects an option that opens a scoped free-text correction.

3. RESEARCH PASS
   - Research before clarifying:
     - Local context: `legion status --json`, `legion map --query <term> --json`, README/docs, relevant source paths.
     - Web/domain context: use available web research tools or documented web-research skills when the idea depends on current libraries, APIs, market conventions, regulations, or external products.
   - Keep research bounded. If research cannot be completed quickly, document the gap and ask the user whether to proceed with assumptions, narrow scope, or park.
   - Record research as facts, inferences, and assumptions separately.

4. CLARIFY ONE DECISION AT A TIME
   - Ask a sequence of high-signal clarifying questions via AskUserQuestion.
   - Each question must resolve one material design decision:
     - target users/audience
     - primary outcome
     - MVP scope
     - non-goals
     - platform/channel
     - data or integration dependencies
     - technical constraints
     - timeline/risk tolerance
   - Ask as many questions as needed for a decision-complete design, but avoid checklist dumping. Combine only tightly related decisions.
   - After each answer, update knowns, unknowns, and design constraints.

5. PROPOSE APPROACHES
   - Present 2-3 viable approaches with tradeoffs:
     - Conservative/minimal approach.
     - Balanced recommended approach.
     - Ambitious or extensible approach when useful.
   - Recommend one approach with rationale grounded in the research and user answers.
   - Ask the user to choose, refine, or keep comparing via AskUserQuestion.

6. WRITE THE DESIGN DOCUMENT
   - Record the design through `legion explore "<topic>" --json`. The CLI writes the design
     document and the typed exploration, and returns their paths; do not write them yourself.
   - Document structure:
     ```markdown
     # Design Exploration — {title}

     ## Initial Ask
     {raw idea or source context}

     ## Research Summary
     - Facts:
     - Inferences:
     - Assumptions:

     ## Product Definition
     - Target users:
     - Primary outcome:
     - Value proposition:
     - Non-goals:

     ## Recommended Approach
     {chosen approach and rationale}

     ## Alternatives Considered
     | Approach | Strengths | Tradeoffs | Decision |
     |----------|-----------|-----------|----------|

     ## Feature Scope
     ### MVP
     - [ ] ...
     ### Later
     - [ ] ...

     ## Experience / Workflow
     {main user flow or operational workflow}

     ## Technical Direction
     {platform, architecture, integrations, data, constraints}

     ## Open Questions
     - {question} — {resolution path or why deferred}

     ## Start Input
     {concise summary that `/legion:start <this-file>` can use to prefill project initialization}
     ```

7. FINAL DECISION
   - Use AskUserQuestion:
     - "Start with this design" — route to `/legion:start <design-doc-path>`.
     - "Keep discussing" — continue clarification and update the same design doc.
     - "Park it" — leave the design saved and exit.
   - If the user selects start, explicitly hand off to `/legion:start <design-doc-path>`. Do not silently run start before this choice.
   - If the user parks the design, print the saved path and a concise next action.
</process>

<anti_patterns>
- Do not show a "crystallize/onboard/compare/debate" mode menu.
- Do not frame every session as starting a brand-new project.
- Do not automatically invoke `/legion:start`.
- Do not skip local context inspection before questions.
- Do not ask broad open-ended questions after the initial scoped idea capture.
- Do not write exploration artifacts directly; `legion explore` owns them.
</anti_patterns>

<completion_gate>
- `legion explore` reports the design document and typed exploration it wrote.
- The document includes research, decisions, alternatives, MVP scope, technical direction, and open questions.
- The final user decision is explicit: start, keep discussing, or park.
- If start is chosen, the handoff command is `/legion:start <design-doc-path>`.
</completion_gate>

**Related Commands**:
- `/legion:start <design-doc-path>` — initialize a project from a saved exploration design.
- `/legion:map` — generate or refresh codebase context used during exploration.
- `/legion:status` — inspect existing project state before or after exploration.
