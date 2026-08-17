---
cli: hermes-agent
cli_display_name: "Hermes Agent"
version: "1.0"
support_tier: "beta"
capabilities:
  parallel_execution: true
  agent_spawning: true
  structured_messaging: true
  native_task_tracking: true
  read_only_agents: true
  supports_extended_thinking: true
detection:
  primary: "skill_view(name='legion') returns content, or ~/.hermes/skills/workflow/legion/SKILL.md exists"
  secondary: "hermes skills list | grep legion, or .hermes/skills/workflow/legion/SKILL.md exists in CWD"
max_prompt_size: 200000
known_quirks:
  - "delegate-task-limits"
  - "tool-schema-overhead"
  - "profile-isolation"
---

# Hermes Agent Adapter

Hermes Agent is a self-improving autonomous AI agent with persistent memory, 60+ tools, parallel subagent delegation, kanban task coordination, cron scheduling, and a multi-platform gateway (Telegram, Discord, Slack, 20+ platforms). It is the first Legion target to support genuine parallel plan execution via `delegate_task`.

## Tool Mappings

| Generic Concept | Implementation |
|---|---|
| `spawn_agent_personality` | Use `delegate_task(goal=<task>, context=<personality + context>)` — each child gets its own isolated conversation with full tool access. Personality is injected via the `context` parameter. |
| `spawn_agent_autonomous` | Use `delegate_task(goal=<task>)` — no personality, just the task. Children inherit the parent's toolset. |
| `spawn_agent_readonly` | Use `delegate_task(goal=<task>, role='leaf')` with explicit "read-only" instruction in the goal. Hermes does not enforce read-only at the platform level, but the leaf role prevents further delegation. |
| `coordinate_parallel` | Use `delegate_task(tasks=[{goal: task1}, {goal: task2}, {goal: task3}])` — up to 3 concurrent children (configurable via `delegation.max_concurrent_children`). Each child runs in an isolated session with its own terminal. Results return asynchronously. |
| `collect_results` | `delegate_task` returns child summaries inline. For durable tracking, children write results to `.legion/project/` artifacts AND update kanban cards via `kanban_complete()`. The coordinator reads kanban state via `kanban_list()`. |
| `shutdown_agents` | Use `delegate_task(action='stop', subagent_id=<id>)` to terminate a running child. Partial results are still returned. |
| `cleanup_coordination` | Kanban cards auto-archivable. No persistent agent sessions to clean up — `delegate_task` children are ephemeral. |
| `ask_user` | Use `clarify(question=<prompt>, choices=[...])` for structured multiple-choice. On messaging platforms (Telegram, Discord), this renders as interactive buttons. In CLI, it renders as a numbered picker. |
| `model_planning` | User-configured model (e.g., `mimo-v2.5-pro`, `anthropic/claude-opus-4-6`). Hermes routes via any configured provider. |
| `model_execution` | User-configured model (e.g., `deepseek-v4-flash`, `gpt-5.3-codex`). Can be pinned per delegation preset. |
| `model_check` | User-configured lightweight model. Use delegation presets to route verification tasks to cheaper models. |
| `global_config_dir` | `~/.hermes/` |
| `plugin_discovery_glob` | `~/.hermes/skills/workflow/legion/SKILL.md` — resolve `$HOME` first via `os.homedir()` or `echo $HOME`. |
| `commit_signature` | `Co-Authored-By: Hermes Agent ` |

## Interaction Protocol

Hermes provides `clarify()` for structured user interaction:

- **Multiple choice:** `clarify(question="...", choices=["Option A", "Option B", "Option C"])` — renders as interactive buttons on Telegram/Discord, numbered list in CLI
- **Multi-select:** `clarify(question="...", choices=[...], multi_select=true)` — checkboxes on messaging, comma-separated in CLI
- **Open-ended:** `clarify(question="...")` — free-text input

For Legion's interview flow (`legion start`), use `clarify()` for each question. Parse the response from `user_response`. On invalid input, re-prompt (max 2 retries, then default to first option).

When running on the gateway (Telegram, Discord, etc.), `clarify()` delivers to the user's active chat and waits for their reply — this means the Legion interview can happen across any of the 20+ supported platforms without any adapter changes.

## Execution Protocol

### Phase Initialization

Hermes has native kanban support. Create a kanban board for the change:

```
kanban_create(title="Phase {NN}: {phase_name}", assignee="default")
```

Each plan becomes a child task:

```
kanban_create(title="{NN}-{PP}: {plan_name}", parents=[phase_task_id], assignee="default")
```

For simpler workflows, use `todo()` for in-session tracking:

```
todo(todos=[
  {"id": "{NN}-01", "content": "Plan 1 description", "status": "pending"},
  {"id": "{NN}-02", "content": "Plan 2 description", "status": "pending"},
])
```

### Wave Execution

**Dispatch mode:** parallel — `delegate_task(tasks=[...])` spawns up to 3 concurrent subagents, each in its own isolated conversation with full tool access. When the wave has more than 3 plans, remaining plans queue and start as children complete.

Hermes is the first Legion target with true parallel execution. Other targets (Codex, OpenCode, Claude Code) all execute sequentially within waves.

For each wave:

1. Collect the wave's plans (those with no unmet dependencies)
2. Build a batch: `delegate_task(tasks=[{goal: plan1_task, context: plan1_context}, {goal: plan2_task, context: plan2_context}, ...])`
3. Children execute in parallel — each writes its result to `.legion/project/changes/{changeId}/runs/{runId}/executor-result.json`
4. Children also update their kanban cards: `kanban_complete(summary="...", metadata={...})`
5. The parent receives all results when the batch completes
6. If any child fails, mark that plan failed and continue with the next wave

**Sequential fallback:** If `delegation.max_concurrent_children` is 1, plans execute one at a time via individual `delegate_task()` calls.

**Timeout handling:** Each child respects the task's `max_runtime_seconds`. If exceeded, the child is terminated and partial results are returned. Set generous timeouts (600s+) for complex implementation plans.

### Read-Only Agents

Use `delegate_task(role='leaf')` with an explicit read-only instruction:

```
delegate_task(
  goal="Review the following code changes. Do NOT modify any files. Report findings only.",
  context="..."
)
```

For `legion:advise` and plan critique, this is the recommended dispatch mode.

### Gateway Integration

When Hermes runs as a gateway service (background daemon on Telegram, Discord, etc.), the entire Legion interview and workflow can happen through messaging:

- `legion start` questions arrive as Telegram/Discord messages with interactive buttons
- `legion plan` results are delivered as formatted messages
- `legion review` notifications arrive in the user's configured chat
- `legion ship` gate status is messaged with satisfaction/unsatisfaction per gate

This is unique to Hermes — no other Legion target can deliver the workflow to a phone via Telegram.

### Model Routing

Hermes supports any provider (OpenRouter, Anthropic, OpenAI, DeepSeek, local models, 15+ others). Model routing is configured globally in `~/.hermes/config.yaml` and can be overridden per delegation:

| Tier | Purpose | Configuration |
|---|---|---|
| `model_planning` | Phase decomposition, architecture | Pin via delegation preset with `provider` + `model` |
| `model_execution` | Plan implementation | Default delegation model, or preset |
| `model_check` | Verification, lightweight analysis | Cheap model preset (e.g., `deepseek-v4-flash`) |

Delegation presets allow routing different tiers to different providers:

```yaml
# In ~/.hermes/config.yaml
delegation:
  presets:
    planner:
      provider: custom
      model: mimo-v2.5-pro
    implementer:
      provider: openrouter
      model: deepseek/deepseek-v4-flash
    reviewer:
      provider: anthropic
      model: claude-haiku-4-5
```

### Cron Integration

Hermes's cron system can automate post-workflow actions:

- **Auto re-check ship gates:** Schedule a cron job to re-run `legion ship` after a time delay
- **Review reminders:** Schedule reminders if a review is pending
- **Status digests:** Daily summary of all active Legion changes

```
cronjob(action='create', schedule='0 9 * * *',
  prompt='Check all active .legion/project changes and report status')
```

### Profile Isolation

For multiple concurrent changes, each can be isolated in its own Hermes profile:

```bash
hermes profile create legion-change-42 --clone
hermes -p legion-change-42  # Run Legion workflow in isolation
```

This prevents cross-contamination of memory, skills, and session state between changes.

## Dispatch Configuration

When Legion dispatches Hermes Agent as an executor, it uses `hermes chat -q` with explicit working directory and quiet mode. For parallel execution, it uses `delegate_task`.

```yaml
available: true
capabilities:
  - code_implementation
  - testing
  - refactoring
  - bug_fixing
  - code_review
  - parallel_execution
  - persistent_memory
invoke_command: "hermes"
invoke_flags:
  - "chat"
  - "-q"
  - "--source"
  - "legion"
prompt_delivery: stdin
result_mode: file
result_path: ".legion/project/changes/{changeId}/runs/{runId}/executor-result.json"
result_instruction: "Write the requested JSON result to the result path."
max_concurrent: 3
timeout_ms: 600000
detection_command: "hermes --version"
prerequisites: []
```

## Known Quirks

| Quirk | Impact | Workaround |
|---|---|---|
| `delegate-task-limits` | Max 3 concurrent children by default. Larger waves queue. | Adjust `delegation.max_concurrent_children` in config.yaml |
| `tool-schema-overhead` | Hermes's tool schema is ~19K tokens, reducing effective context for subagents | Use `enabled_toolsets` on delegation presets to limit tool injection |
| `profile-isolation` | Local installs are profile-scoped — a skill in `.hermes/skills/` only loads for that profile | Use global install for cross-project availability |
