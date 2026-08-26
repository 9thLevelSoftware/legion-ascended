# Legion Install Matrix

Legion now optimizes for a unified workflow language instead of maximum platform count. The normal user-facing flow is always:

```powershell
legion start
legion plan 1
legion build
legion review
legion ship
```

Agent hosts should expose one clear `legion` entry point when they can. Host-specific aliases such as `/legion-start`, `/prompts:legion-start`, or rules-only prompts are compatibility details, not the main onboarding path.

## Support Tiers

| Tier | Meaning |
| --- | --- |
| `first-class` | One clear Legion entry point, full workflow coverage, managed install/update/uninstall/verify, documented local/global behavior, and smoke coverage. |
| `compatible` | Legion can guide the host, but the host cannot provide a fully unified native command or skill experience. |
| `legacy` | Kept for existing users or enterprise/pinned installs, but hidden from the recommended path. |
| `manual-only` | Documented but not installed automatically. |
| `unsupported` | Not offered by the installer. |

## Recommended Targets

Install first-class targets with:

```powershell
legion install --target codex --local
legion install --target grok --local
```

Use `--global` for a user-wide install and `--dry-run` to preview writes.

The install surfaces below are the runtime's own entry points. They dispatch to the `legion` CLI,
which holds the workflow engine. The v8 prompt bundle — agent personas, command markdown, skills,
and dispatch adapters — is not installed unless you pass `--legacy-prompts`, which also repoints
these entry points at those files.

| Target | Runtime | Canonical Entry | Local | Global | Install Surface |
| --- | --- | --- | --- | --- | --- |
| `claude` | Claude Code | `/legion` | Yes | Yes | Native Legion skill |
| `codex` | OpenAI Codex CLI | `/project:legion` or `/prompts:legion` | Yes | Yes | Native Legion skill plus one prompt wrapper; per-command prompts are aliases |
| `copilot` | GitHub Copilot CLI | `/legion` | Yes | Yes | Legion skill plus custom agent profile |
| `antigravity` | Antigravity CLI | `/legion` | Yes | Yes | Native plugin with command aliases |
| `opencode` | OpenCode | `/legion` | Yes | Yes | Single Legion command plus compatibility command aliases and a subagent |
| `hermes` | Hermes Agent | `/legion` | Yes | Yes | Native Legion skill with parallel delegation, kanban tracking, and gateway delivery |
| `grok` | Grok Build | `/legion` | Yes | Yes | Native Agent Skill plus bounded headless JSON executor; sequential only |
| `kilocode` | Kilo Code Plugin | Legion mode or `/legion` | Yes | Yes | Legion mode, workflow, compatibility workflows, and the Legion skill |

### Grok Build

Grok Build is a first-class Legion target in 9.3.1. Verify the installed upstream
CLI, then preview or apply the managed native skill install:

```powershell
grok --version
legion install --target grok --local --dry-run
legion install --target grok --local
```

The verified native skill paths are `$PROJECT/.grok/skills/legion/SKILL.md`
for local scope and `$GROK_HOME/skills/legion/SKILL.md` for global scope. When
`GROK_HOME` is unset, global scope falls back to `<home>/.grok`. Legion owns
only these managed skill files and its manifest; Grok owns browser login and
API-key authentication. Legion never reads or transmits `XAI_API_KEY`.

For headless build or review execution, Legion invokes Grok with argv values,
not a shell string:

```text
grok --prompt-file <promptAbsolutePath> --cwd <repositoryRoot> --output-format json --permission-mode bypassPermissions
```

Use `legion build --executor grok` or `legion review --executor grok` to select
it explicitly. Grok's upstream CLI is alpha and does not provide a native
parallel-subagent primitive, so Legion runs this executor sequentially. The
release's fake-Grok smoke covers success, error, malformed, non-zero, timeout,
install lifecycle, and packed production-install paths without credentials.

Official references: [Grok Build overview and installation](https://docs.x.ai/build/overview),
[CLI reference](https://docs.x.ai/build/cli/reference),
[headless scripting and ACP](https://docs.x.ai/build/cli/headless-scripting), and
[skills, plugins, and marketplaces](https://docs.x.ai/build/features/skills-plugins-marketplaces).

## Compatibility And Legacy Targets

These targets are available with `--all-targets` or explicit flags, but they are not part of the default happy path.

| Target | Runtime | Tier | Entry | Reason |
| --- | --- | --- | --- | --- |
| `cursor` | Cursor | `compatible` | Plain-language request | Project rules do not provide a native Legion command or skill surface. |
| `kiro` | Kiro CLI (formerly Amazon Q Developer CLI) | `compatible` | `@legion` | Kiro custom agents use mentions rather than a native `legion` command. |
| `windsurf` | Windsurf / Cascade | `compatible` | Plain-language request | Rules and MCP do not provide a native Legion command wrapper. |
| `kilo` | Kilo CLI | `compatible` | `/legion` | The Kilo Code plugin is the preferred first-class Kilo path. |
| `gemini` | Google Gemini CLI | `legacy` | `/legion` | Consumer Gemini CLI moved to Antigravity on June 18, 2026; keep only for enterprise or pinned users. |
| `aider` | Aider | `manual-only` | None | Aider does not expose an installable Legion command or skill surface. |
| `claude-desktop` | Claude Desktop | `manual-only` | MCP/desktop extension only | Claude Desktop is not Claude Code; it needs MCP or desktop extension packaging before native Legion install support. |

## Installer Commands

```powershell
legion install --list-targets
legion install --list-targets --all-targets
legion install --detect
legion install --target codex --explain
legion install --target codex --local --dry-run
legion install --target codex --local
legion uninstall --target codex --local
legion update --target codex --local
```

Existing shortcut flags remain supported:

```powershell
npx legion-ascended --claude
npx legion-ascended --codex --local
npx legion-ascended --kilo-code --global
```

## Policy

- Default prompts and default docs show only first-class targets.
- Compatibility, legacy, and manual-only targets are never hidden, but they require `--all-targets` or an explicit target.
- Installer tests use temporary homes and projects only.
- Official documentation links and verification dates live in `bin/runtime-metadata.js`; this matrix is the user-facing rendering of that registry.
