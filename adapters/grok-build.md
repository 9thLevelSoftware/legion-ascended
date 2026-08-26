---
cli: grok-build
cli_display_name: "Grok Build"
version: "1.0"
support_tier: "experimental"
capabilities:
  parallel_execution: false
  agent_spawning: false
  structured_messaging: false
  native_task_tracking: false
  read_only_agents: false
  supports_extended_thinking: false
detection:
  primary: "grok --version exits successfully; this is a bounded read-only executable probe"
  secondary: "$PROJECT/.grok/skills/legion/SKILL.md, $GROK_HOME/skills/legion/SKILL.md, or <home>/.grok/skills/legion/SKILL.md exists"
max_prompt_size: 100000
known_quirks:
  - "alpha-cli"
  - "headless-json-is-not-acp-ndjson"
  - "no-native-parallel-subagents"
  - "browser-auth-owned-by-grok"
---

# Grok Build Adapter

Grok Build is an xAI CLI with a native Agent Skills surface and a bounded headless
JSON mode. Legion installs one generated skill named `legion`, which Grok exposes
as `/legion` when the project or user skill is discovered. The Legion installer and
executor are first-class in 9.3.0, with install, detection, executor, and
packed-install smoke coverage. The verified local Grok CLI was `grok 1.0.10
(5992780042ca) [alpha]`; the upstream alpha status remains an explicit caveat and
this adapter therefore remains `experimental` in the adapter catalog.

The native skill surface is deliberately limited to:

- Project: `$PROJECT/.grok/skills/legion/SKILL.md`
- User: `$GROK_HOME/skills/legion/SKILL.md`, falling back to `<home>/.grok/skills/legion/SKILL.md`
- Canonical host invocation: `/legion`

Plugins, `.grok/commands`, and ACP are separate surfaces and are not written by
this installer.

## Tool Mappings

| Generic Concept | Implementation |
|---|---|
| `spawn_agent_personality` | Not available in the native Grok Build skill surface. Run the requested `legion <command> --json` workflow in the current Grok session, or use the headless executor explicitly. |
| `spawn_agent_autonomous` | Not available as a native subagent primitive. Legion's Grok executor invokes one bounded `grok` process with an argv array and a temporary `--prompt-file`. |
| `spawn_agent_readonly` | No separate native read-only agent is advertised by this adapter. Do not claim read-only isolation; use Legion's own review gates. |
| `coordinate_parallel` | Not available. Execute plans sequentially and preserve each plan's artifacts under `.legion/`. |
| `collect_results` | Read the JSON returned by `legion <command> --json` or the completed headless envelope; treat malformed, partial, or error envelopes as diagnostics rather than success. |
| `shutdown_agents` | No-op for the current native skill surface. A headless process is bounded by the executor timeout and terminated by the process runner. |
| `cleanup_coordination` | No Grok coordination infrastructure is created. Remove only Legion-managed artifacts through the installer manifest. |
| `ask_user` | Present numbered choices in the Grok session and wait for explicit user input. Never infer approval, acceptance, or an attestation. |
| `model_planning` | User-configured Grok Build model; no model override is assumed by the Legion skill. |
| `model_execution` | User-configured Grok Build model; the installer does not inspect credentials or model configuration. |
| `model_check` | User-configured Grok Build model; use the same configured model when no separate tier is available. |
| `global_config_dir` | `$GROK_HOME` when set, otherwise `<home>/.grok`; resolve the environment override before using the path. |
| `plugin_discovery_glob` | `$PROJECT/.grok/skills/legion/SKILL.md` and `$GROK_HOME/skills/legion/SKILL.md`; resolve `$GROK_HOME` or `<home>` to an absolute path before filesystem access. |
| `commit_signature` | No Grok-specific co-author line. Keep Legion's existing commit and human-approval policy. |

## Interaction Protocol

Grok's native skill is invoked as `/legion`; the skill routes to the terminal
workflow language (`legion start`, `legion plan`, `legion build`, `legion review`,
and related commands). For an interactive decision:

1. Print a numbered list with one decision per line and a concise description.
2. Ask the user to enter a number or the exact decision name.
3. Parse only an unambiguous number or exact option text.
4. On invalid input, explain the valid choices and ask again, up to two retries.
5. Keep the prompt blocking until the user makes an explicit choice; do not
   treat silence, a successful command, or an installed skill as approval.

The skill should run `legion <command> --json` from the repository root and act on
`status`, `diagnostics`, and `nextAction`. When `nextAction.type` is
`human_decision`, pause for the user instead of executing the named decision.

## Execution Protocol

### Wave Execution

**Dispatch mode:** sequential — run one bounded Legion plan at a time in the current Grok session; there is no native parallel-subagent mechanism, and sequential execution is the required fallback.

For each plan:

1. Read the plan's scoped task contract and the current Legion state.
2. Run the matching `legion <command> --json` command from the repository root.
3. Follow only the returned `nextAction`; do not invent a parallel dispatch path.
4. Record task evidence and results in the `.legion/` artifacts named by the CLI.
5. Before the next plan, verify the prior plan's status and diagnostics.
6. If Grok returns an authentication, timeout, malformed-output, or incomplete-result
   diagnostic, stop the wave and report the diagnostic rather than claiming success.

The headless execution adapter uses this documented argv shape, without a
shell string and without probing credentials:

```text
grok --prompt-file <TEMP_PROMPT_PATH> --cwd <REPOSITORY_ROOT> --output-format json --permission-mode bypassPermissions
```

`grok --prompt-file` preserves arbitrary prompt bytes without shell interpolation.
`grok --output-format json` is one completed JSON envelope. Do not parse
`streaming-json` as a Legion result: that surface is NDJSON session updates, while
`grok agent stdio` is the separate ACP JSON-RPC entry point.

### Cost Tiers

Grok Build's model selection is user-configured. `model_planning`,
`model_execution`, and `model_check` all map to the configured Grok Build model
unless the user configures separate model tiers in Grok. Legion does not transmit
or store provider credentials or `XAI_API_KEY`.

### Authentication and Safety

Install and discovery are credential-free. Use `grok --version` for bounded
availability detection and `grok inspect --json` for read-only skill discovery.
Grok owns browser authentication and any API-key configuration. Legion must never
run `grok login`, inspect credential files, read `XAI_API_KEY`, or send an API key
through an installer, skill, or executor.

## Dispatch Configuration

```yaml
available: true
capabilities:
  - code_implementation
  - testing
  - refactoring
  - bug_fixing
  - code_review
  - sequential_execution
invoke_command: "grok"
invoke_flags:
  - "--prompt-file"
  - "<promptAbsolutePath>"
  - "--cwd"
  - "<repositoryRoot>"
  - "--output-format"
  - "json"
  - "--permission-mode"
  - "bypassPermissions"
prompt_delivery: file
result_mode: json
result_path: ".legion/project/changes/{changeId}/runs/{runId}/executor-result.json"
result_instruction: "Return one completed JSON envelope; the executor owns normalization and diagnostics."
max_concurrent: 1
timeout_ms: 600000
detection_command: "grok --version"
prerequisites: []
```

## Known Quirks

| Quirk | Impact | Workaround |
|---|---|---|
| `alpha-cli` | The verified CLI is an alpha build, so undocumented behavior must not be treated as a stable contract. | Restrict the installer to the verified skill path and use bounded detection. |
| `headless-json-is-not-acp-ndjson` | `streaming-json` is not the same result contract as one completed JSON response. | Use `--output-format json` for the first executor and keep ACP separate. |
| `no-native-parallel-subagents` | Grok's native skill surface does not provide Legion's parallel delegation primitive. | Execute waves sequentially and use durable Legion artifacts. |
| `browser-auth-owned-by-grok` | Authentication state belongs to Grok Build. | Let Grok report authentication failures; never probe or store credentials in Legion. |
