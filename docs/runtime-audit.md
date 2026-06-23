# Runtime Audit

Verified against official vendor documentation on June 23, 2026.

Claude Code remains the control runtime. Every other runtime below was re-audited against official docs before changing installer behavior, support tiers, and adapter claims. The default installer prompt shows only first-class targets; use `legion install --list-targets --all-targets` to see compatibility, legacy, and manual-only targets.

| Runtime | Tier | Disposition | Local | Global | Native Legion Surface | Native Entry |
|---------|------|-------------|-------|--------|------------------------|--------------|
| Claude Code | First-class | Native skill and commands | Yes | Yes | `.claude/skills/legion/SKILL.md` plus command aliases, agents, and supporting skills | `/legion` |
| OpenAI Codex CLI | First-class | Native skill and prompt wrapper | Yes | Yes | `.agents/skills/legion/SKILL.md` plus `.codex/prompts/legion.md`; per-command prompts are aliases | `/project:legion` or `/prompts:legion` |
| GitHub Copilot CLI | First-class | Skills and custom agent | Yes | Yes | `.github/skills/legion/`, `.github/agents/legion.agent.md`, `~/.copilot/skills/legion/`, `~/.config/copilot/agents/legion.agent.md` | `/legion` |
| Antigravity CLI | First-class | Native plugins | Yes | Yes | `.agents/plugins/legion/` plus `~/.gemini/config/plugins/legion/` | `/legion` |
| OpenCode | First-class | Commands and subagent | Yes | Yes | `.opencode/commands/`, `.opencode/agent/`, `~/.config/opencode/commands/`, `~/.config/opencode/agent/` | `/legion` |
| Kilo Code Plugin | First-class | Mode, workflows, and Agent Skills | Yes | Yes | `.kilocode/workflows/`, `.kilocode/skills/<name>/`, `.kilo/commands/`, `.kilo/skills/<name>/`, `.kilocodemodes`, `~/.kilocode/workflows/`, `~/.kilocode/skills/<name>/`, `~/.config/kilo/commands/`, `~/.kilo/skills/<name>/`, `~/.kilocode/globalStorage/kilo code.kilo-code/settings/custom_modes.yaml` | Select `Legion` mode or run `/legion` |
| Cursor | Compatible | Rules-only | Yes | No | `.cursor/rules/legion.mdc` | Plain-language Legion requests |
| Kiro CLI (formerly Amazon Q Developer CLI) | Compatible | Custom agent and steering | Yes | Yes | `.kiro/agents/legion.md`, `.kiro/steering/legion.md`, `~/.kiro/agents/legion.md`, `~/.kiro/steering/AGENTS.md` | `@legion` |
| Windsurf | Compatible | Rules-only | Yes | No | `.windsurf/rules/legion.md` | Plain-language Legion requests |
| Kilo CLI | Compatible | Workflows, subagent, and Agent Skills | Yes | Yes | `.kilo/commands/`, `.kilo/agents/legion.md`, `.kilo/skills/<name>/`, `~/.config/kilo/commands/`, `~/.config/kilo/agents/legion.md`, `~/.kilo/skills/<name>/` | `/legion` |
| Google Gemini CLI | Legacy | Native commands | Yes | Yes | `.gemini/commands/legion/*.toml` or `~/.gemini/commands/legion/*.toml` | `/legion` |
| Aider | Manual-only | Manual-only | No | No | None | None |
| Claude Desktop | Manual-only | MCP/desktop extension only | No | No | None | None |

## Evidence

### Claude Code

- [Skills](https://code.claude.com/docs/en/skills)
- [Commands](https://code.claude.com/docs/en/commands)

### Codex

- [Custom prompts](https://developers.openai.com/codex/custom-prompts)
- [Skills](https://developers.openai.com/codex/skills)
- [Prompt loader source](https://github.com/openai/codex/blob/main/codex-rs/core/src/custom_prompts.rs)

### Cursor

- [Project rules](https://docs.cursor.com/context/rules)
- [Background Agent overview](https://docs.cursor.com/background-agent/overview)
- [Custom modes beta](https://docs.cursor.com/chat/custom-modes)
- [Review mode](https://docs.cursor.com/chat/review-mode)

### GitHub Copilot CLI

- [Custom chat modes and agent profile paths](https://docs.github.com/en/copilot/customizing-copilot/creating-custom-copilot-chat-modes?tool=vscode)
- [Using custom agents in Copilot CLI](https://docs.github.com/en/copilot/how-tos/agents/copilot-cli/using-custom-agents)
- [Creating a custom agent profile](https://docs.github.com/en/copilot/customizing-copilot/creating-a-custom-agent-profile)
- [Creating a repository custom skill](https://docs.github.com/en/copilot/customizing-copilot/adding-custom-instructions-for-github-copilot#creating-a-repository-custom-skill)
- [Coding agent delegation and subsidiary agents](https://docs.github.com/en/copilot/how-tos/agents/copilot-coding-agent/customizing-the-coding-agent-setup/customizing-or-disabling-agent-delegation)

### Google Gemini CLI

- [Custom commands](https://google-gemini.github.io/gemini-cli/docs/cli/commands/)
- [Configuration and GEMINI.md](https://github.com/google-gemini/gemini-cli?tab=readme-ov-file#configuration)
- [Extensions](https://github.com/google-gemini/gemini-cli/blob/main/docs/extension.md)
- [Gemini CLI to Antigravity transition](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)

### Antigravity CLI

- [Plugins](https://antigravity.google/docs/cli-plugins)

### Kiro CLI

- [Amazon Q Developer CLI is now Kiro CLI](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line.html)
- [Custom agents](https://kiro.dev/docs/cli/custom-agents/)
- [Steering](https://kiro.dev/docs/cli/steering/)
- [Subagents](https://kiro.dev/docs/cli/chat/subagents/)
- [Hooks](https://kiro.dev/docs/cli/hooks/)

### Windsurf

- [Memories and rules](https://docs.windsurf.com/windsurf/cascade/memories)
- [Planning mode](https://docs.windsurf.com/windsurf/cascade/planning-mode)
- [Ask mode](https://docs.windsurf.com/windsurf/getting-started#ask-mode)
- [MCP and hooks](https://docs.windsurf.com/windsurf/mcp)

### OpenCode

- [Custom commands](https://opencode.ai/docs/commands/)
- [Custom agents](https://opencode.ai/docs/agents/)
- [Task tool and subagents](https://opencode.ai/docs/agents/task)
- [Configuration](https://opencode.ai/docs/config)

### Kilo CLI

- [Kilo Code workflows (slash commands)](https://kilocode.ai/docs/customize/workflows)
- [Kilo Code skills (Agent Skills format)](https://landing.kilocode.ai/docs/customize/skills)
- [Kilo Code custom modes (agents)](https://kilo.ai/docs/customize/custom-modes)

### Kilo Code Plugin

- [Kilo Code workflows](https://kilo.ai/docs/customize/workflows)
- [Kilo Code custom modes](https://kilo.ai/docs/customize/custom-modes)
- [Kilo Code skills](https://kilo.ai/docs/customize/skills)

### Aider

- [Configuration](https://aider.chat/docs/config/aider_conf.html)
- [Conventions](https://aider.chat/docs/usage/conventions.html)
- [Chat modes](https://aider.chat/docs/usage/modes.html)
- [Architect mode](https://aider.chat/docs/usage/modes.html#architect-mode)

## Resulting Policy

- Native command surfaces are only installed where the vendor documents a real discovery path.
- Rules-only runtimes get rules and an explicit plain-language entry path instead of fake `/legion:*` claims.
- Manual-only runtimes stay documented but do not receive a misleading automated install path.
- First-class targets must expose a single primary `legion` entry point; old per-command names are compatibility aliases.
