# Runtime Certification Checklists

Use these checklists for manual verification when CI cannot prove runtime-native discovery behavior.

## Claude Code

- Confirm `.claude/skills/legion/SKILL.md` exists in the expected scope.
- Confirm `.claude/commands/legion/` exists in the expected scope.
- Verify `/legion` appears as the primary skill entry point.
- Run `/legion start` and confirm Claude loads the installed Legion workflow directly.
- Verify `/legion:start` style command aliases still route to the same workflow files when present.
- Verify `.claude/legion/manifest.json` reflects the installed runtime and scope.

## OpenAI Codex CLI

- Confirm `.codex/prompts/legion.md` exists in the expected scope.
- Confirm `.codex/prompts/legion-start.md` exists in the expected scope.
- Restart Codex and verify `/project:legion` or `/prompts:legion` appears.
- Trigger the prompt and confirm it reads the installed `.legion/commands/legion/start.md`.
- Verify `.agents/skills/legion/SKILL.md` exists and maps legacy `/legion:*` aliases correctly.

## Cursor

- Confirm `.cursor/rules/legion.mdc` exists after local install.
- Restart or reload Cursor and verify the rule is visible in project rules.
- Ask Cursor in plain language to use Legion start and confirm it reads `.legion/commands/legion/start.md`.
- Verify Background Agent and Review mode still behave correctly with the installed rule.

## GitHub Copilot CLI

- Confirm `.github/skills/legion/SKILL.md` or `~/.copilot/skills/legion/SKILL.md` exists.
- Confirm `.github/skills/legion-start/SKILL.md` or `~/.copilot/skills/legion-start/SKILL.md` exists.
- Confirm `.github/agents/legion.agent.md` or `~/.config/copilot/agents/legion.agent.md` exists.
- Restart Copilot CLI and verify `/legion` is discoverable via `/skills`.
- Verify `/agent legion` is selectable and can route to `.legion/commands/legion/start.md`.
- Verify `/legion-start` remains a compatibility alias when installed.

## Google Gemini CLI

- Confirm `.gemini/commands/legion/legion.toml` or `~/.gemini/commands/legion/legion.toml` exists.
- Confirm `.gemini/commands/legion/start.toml` or `~/.gemini/commands/legion/start.toml` exists.
- Restart Gemini CLI and run `/legion`.
- Verify Gemini reads the authoritative `.legion/commands/legion/start.md` file.
- Confirm nested namespace commands still resolve as compatibility aliases.
- Record whether this is an enterprise/pinned Gemini CLI environment; consumer Gemini CLI users should move to Antigravity.

## Antigravity CLI

- Confirm `.agents/plugins/legion/plugin.json` or `~/.gemini/config/plugins/legion/plugin.json` exists and is valid JSON.
- Verify skills, agents, and commands directories exist inside the plugin folder.
- Restart Antigravity CLI and run `agy inspect` to verify the `legion` plugin is active.
- Verify Antigravity CLI can run `/legion` and execute the installed plugin commands.
- Verify `/legion:start` remains a compatibility alias when installed.

## Kiro CLI (formerly Amazon Q Developer CLI)

- Confirm `.kiro/agents/legion.md` or `~/.kiro/agents/legion.md` exists.
- Confirm `.kiro/steering/legion.md` or `~/.kiro/steering/AGENTS.md` exists.
- Restart Kiro CLI and verify `@legion` is available.
- Confirm plain-language Legion requests or legacy `/legion:*` aliases route to the installed `.legion/commands/legion/*.md` files.

## Windsurf

- Confirm `.windsurf/rules/legion.md` exists after local install.
- Restart or reload Windsurf and verify the rule is active.
- Ask Cascade in plain language to use Legion and confirm it reads `.legion/commands/legion/start.md`.
- Verify Ask mode remains read-only with the Legion rule installed.

## OpenCode

- Confirm `.opencode/commands/legion.md` or `~/.config/opencode/commands/legion.md` exists.
- Confirm `.opencode/commands/legion-start.md` or `~/.config/opencode/commands/legion-start.md` exists.
- Confirm `.opencode/agent/legion.md` or `~/.config/opencode/agent/legion.md` exists.
- Restart OpenCode and verify `/legion` is available.
- Confirm the installed `legion` agent can execute the authoritative workflow file in `.legion/commands/legion/start.md`.
- Verify `/legion-start` remains a compatibility alias when installed.

## Hermes Agent

- Confirm `.hermes/skills/workflow/legion/SKILL.md` or `~/.hermes/skills/workflow/legion/SKILL.md` exists.
- Confirm `.hermes/skills/workflow/legion/manifest.json` exists and contains the correct runtime key.
- Run `hermes skills list` and verify `legion` appears in the output.
- Restart Hermes and verify the `legion` skill loads (test with `/skill legion` or `hermes -s legion`).
- Verify `delegate_task` can be used for parallel plan execution.

## Grok Build

Grok Build is a first-class **Legion** target in 9.3.1 because the managed
installer, bounded detection, headless executor, and packed-install smoke are
covered. This does not upgrade the upstream CLI's support tier: the verified
upstream CLI is `grok 1.0.10 (5992780042ca) [alpha]`, and the alpha caveat must
remain in the certification record.

### Install and detection

- [ ] Run `grok --version` as the bounded, read-only availability probe and
  record a successful exit plus the reported version.
- [ ] For a local install, preview and apply the managed skill at
  `$PROJECT/.grok/skills/legion/SKILL.md`.
- [ ] For a global install, preview and apply the managed skill at
  `$GROK_HOME/skills/legion/SKILL.md`; when `GROK_HOME` is unset, verify the
  fallback path `<home>/.grok/skills/legion/SKILL.md`.
- [ ] Confirm the generated skill is named `legion` and appears to Grok as the
  `/legion` user-invocable entry point.
- [ ] Optionally run `grok inspect --json` to verify the discovered project or
  user skill path without starting a prompt, TUI, or login flow.
- [ ] Verify update, uninstall, and manifest rollback remove only Legion-managed
  Grok skill files and leave unrelated `.grok` content untouched.

### Executor and authentication boundaries

- [ ] Run `legion build --executor grok` or `legion review --executor grok`
  against the fixture repository and verify the executor passes this argv array,
  not a shell string:

  ```text
  grok --prompt-file <path> --cwd <repo> --output-format json --permission-mode bypassPermissions
  ```

- [ ] Confirm `--prompt-file` points to the temporary prompt, `--cwd` is the
  repository root, and the executor accepts one completed `json` result envelope.
- [ ] Confirm `streaming-json` (newline-delimited session updates) is not parsed
  as the completed executor result, and that `grok agent stdio` remains the
  separate ACP JSON-RPC surface.
- [ ] Confirm Grok owns browser authentication and API-key configuration. Legion
  must never run `grok login`, inspect credential files, read `XAI_API_KEY`, or
  transmit an API key through installation, detection, or execution.
- [ ] Record an authentication failure as a Grok diagnostic rather than as an
  installer success or a Legion credential-handling failure.

### Dispatch and packed-install smoke

- [ ] Confirm Grok has no native parallel-subagent primitive and that Legion
  executes build and review waves sequentially with a maximum concurrency of one.
- [ ] From a packed production install, run the credential-free fake-Grok smoke
  and record PASS for detection, local/global install lifecycle, executor result
  normalization, command help, package contents, and packed production-install
  execution.
- [ ] Include failure-path coverage for malformed, partial, error, non-zero, and
  timeout responses; none may be certified as a successful executor result.
- [ ] Keep the upstream `1.0.10` alpha caveat attached to the certification
  record even when every Legion-managed smoke item passes.

## Kilo CLI

- Confirm `.kilo/commands/legion.md` or `~/.config/kilo/commands/legion.md` exists.
- Confirm `.kilo/commands/legion-start.md` or `~/.config/kilo/commands/legion-start.md` exists.
- Confirm `.kilo/agents/legion.md` or `~/.config/kilo/agents/legion.md` exists.
- Confirm `.kilo/skills/code-polish/SKILL.md` (or `~/.kilo/skills/code-polish/SKILL.md`) exists and its frontmatter `name:` field reads exactly `code-polish` (the spec-invalid `legion:code-polish` source name must be normalized at install time).
- Confirm at least three other skill folders exist under `.kilo/skills/` (e.g., `workflow-common`, `phase-decomposer`, `review-loop`).
- Restart Kilo CLI and verify `/legion` is available in the slash-command picker.
- Confirm the installed `legion` agent can execute the authoritative workflow file in `.legion/commands/legion/start.md`.
- Verify `/legion-start` remains a compatibility alias when installed.

## Kilo Code Plugin

- Confirm `.kilocode/workflows/legion.md`, `.kilo/commands/legion.md`, `~/.kilocode/workflows/legion.md`, or `~/.config/kilo/commands/legion.md` exists for the primary workflow surface.
- Confirm `.kilocode/workflows/legion-start.md`, `.kilocode/workflows/legion-board.md`, `~/.kilocode/workflows/legion-start.md`, or `~/.kilocode/workflows/legion-board.md` exists for the plugin workflow surface.
- Confirm `.kilo/commands/legion-start.md`, `.kilo/commands/legion-board.md`, `~/.config/kilo/commands/legion-start.md`, or `~/.config/kilo/commands/legion-board.md` exists for the CLI-backed workflow surface.
- Confirm `.kilocode/skills/board-of-directors/SKILL.md` or `~/.kilocode/skills/board-of-directors/SKILL.md` exists, and representative skill frontmatter names match their directory names.
- Confirm `.kilo/skills/board-of-directors/SKILL.md` or `~/.kilo/skills/board-of-directors/SKILL.md` exists, and representative skill frontmatter names match their directory names.
- Confirm `.kilocode/skills/legion/SKILL.md` or `~/.kilocode/skills/legion/SKILL.md` exists as the bridge/index skill.
- Confirm `.kilocodemodes` or `~/.kilocode/globalStorage/kilo code.kilo-code/settings/custom_modes.yaml` contains `slug: legion`.
- Restart Kilo Code or reload the IDE window and verify the `Legion` custom mode, `/legion` workflow, and Legion skills are available.
- Run `/legion` and confirm the workflow routes through the single `Legion` mode and reads the authoritative command file in `.legion/commands/legion/`.
- Verify `/legion-start.md`, `/legion-start`, `/legion-board.md`, and `/legion-board` remain compatibility aliases when installed.

## Aider

- Confirm Legion does not offer an automated native install for Aider.
- If you choose the manual path, verify `AGENTS.md`, `CONVENTIONS.md`, or `.aider.conf.yml` contains the intended Legion guidance.
- Use `/ask` for read-only Legion advisory sessions.
- Use `/architect` and `/code` manually after loading the relevant Legion workflow file by hand.

## Scope and Operator

This checklist is for human operators only. Each item uses verbs like "verify", "confirm", and "trigger" without a machine-checkable pass predicate. Programmatic validation of Legion adapter installations lives in a separate harness (see `/legion:validate` and adapter conformance tests). Do not dispatch an agent to "run the checklist" — use `/legion:validate` instead.

## Completion Gate (for human operators)

The certification run is complete when ALL of the following hold for the CLI under test:
1. The primary Legion entry point for that runtime appears in the host's skill, command, prompt, agent, or mode listing.
2. Invoking a representative command through the primary entry point (for example, `/legion start`, `/project:legion start`, `/prompts:legion start`, `@legion start`, or Legion mode with `start`) loads the installed file documented for that runtime in `adapters/{cli}.md`.
3. A plain-language prompt containing the phrase "use Legion start" causes the host to load the same installed file as the primary entry path.
4. No command prints an error or "not found" message for any Legion command on the canonical list
5. The operator has recorded PASS/FAIL per item for the CLI under test; partial runs are marked `incomplete` and are NOT certifications

If ANY condition is unmet, the CLI is NOT certified — file the failing item(s) as an issue and re-run after fix.
