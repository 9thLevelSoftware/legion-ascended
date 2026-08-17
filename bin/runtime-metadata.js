'use strict';

const LEGION_COMMANDS = [
  'start',
  'plan',
  'build',
  'review',
  'status',
  'quick',
  'advise',
  'portfolio',
  'milestone',
  'agent',
  'map',
  'explore',
  'board',
  'retro',
  'ship',
  'learn',
  'polish',
  'update',
  'validate',
];

// The workflow surface of the shipped CLI, which is what a default install
// routes to. This is deliberately not LEGION_COMMANDS: that list names the v8
// prompt files, and three of its entries have no CLI verb behind them
// (`board` is `council`, `portfolio` lives under `dev board`, and `agent` was a
// prompt-only authoring flow). Four CLI verbs have no v8 prompt at all.
const LEGION_CLI_COMMANDS = [
  { name: 'start', invoke: 'start', description: 'Prepare and display an intake contract, then pause for a human decision' },
  { name: 'explore', invoke: 'explore', description: 'Create a design discovery artifact before start or planning' },
  { name: 'map', invoke: 'map', description: 'Generate, refresh, check, or query codebase context' },
  { name: 'plan', invoke: 'plan', description: 'Plan a phase or change into typed task contracts' },
  { name: 'build', invoke: 'build', description: 'Execute approved task contracts through a runtime driver' },
  { name: 'approve', invoke: 'approve', description: "Record a human decision about the change's delta specs" },
  { name: 'attest', invoke: 'attest', description: "Record a human assertion that pinned files are this change's evidence" },
  { name: 'review', invoke: 'review', description: 'Review task outputs with verification and independent gates' },
  { name: 'release', invoke: 'release', description: "Plan how this change's release is observed and taken back" },
  { name: 'ship', invoke: 'ship', description: 'Run release readiness, promotion, and observation gates' },
  { name: 'retro', invoke: 'retro', description: 'Record retrospective evidence for future planning' },
  { name: 'status', invoke: 'status', description: 'Show workflow state and the next recommended action' },
  { name: 'quick', invoke: 'quick', description: 'Run one ad-hoc task with a task record and risk classification' },
  { name: 'advise', invoke: 'advise', description: 'Run read-only advisory analysis' },
  { name: 'polish', invoke: 'polish', description: 'Run scoped cleanup as an ad-hoc workflow' },
  { name: 'learn', invoke: 'learn', description: 'Record project-specific operational learning' },
  { name: 'milestone', invoke: 'milestone', description: 'Manage milestone status, summaries, and archives' },
  { name: 'validate', invoke: 'validate', description: 'Validate committed Legion project state' },
  { name: 'doctor', invoke: 'doctor', description: 'Validate project state plus bundle-index path presence' },
  { name: 'board', invoke: 'council', description: 'Run governance deliberation (CLI verb: council)' },
  { name: 'portfolio', invoke: 'dev board portfolio', description: 'Tenant-scoped portfolio projection and cross-project rollups' },
  // The installer handles this one; it has no --json surface.
  { name: 'update', invoke: 'update', json: false, description: 'Check for Legion updates and install the latest version' },
];

const SUPPORT_TIERS = ['first-class', 'compatible', 'legacy', 'manual-only', 'unsupported'];
const VERIFIED_ON = '2026-06-23';
const MANAGED_INSTALL_LIFECYCLE = Object.freeze({
  install: 'managed',
  update: 'managed',
  uninstall: 'managed',
  verify: 'managed'
});

const RUNTIME_METADATA = {
  claude: {
    key: 'claude',
    flag: '--claude',
    aliases: [],
    label: 'Claude Code',
    adapterFile: 'claude-code.md',
    supportTier: 'first-class',
    disposition: 'native-skill-and-commands',
    installSurface: 'native Legion skill plus command aliases, agents, and supporting skills',
    canonicalEntrypoint: { local: '/legion', global: '/legion' },
    parityGaps: [],
    lastVerified: VERIFIED_ON,
    smokeTestStatus: 'covered',
    installLifecycle: MANAGED_INSTALL_LIFECYCLE,
    scopeSupport: { local: true, global: true },
    storageLayout: 'claude',
    allowedTools: null,
    supportsAtRefs: true,
    nativeSurfaces: [
      {
        key: 'claude-skill',
        type: 'claude-skill',
        pathKind: 'file',
        localPath: '$PROJECT/.claude/skills/legion/SKILL.md',
        globalPath: '$HOME/.claude/skills/legion/SKILL.md',
      },
    ],
    entrypoints: {
      local: '/legion',
      global: '/legion',
    },
    evidence: [
      {
        title: 'Skills',
        url: 'https://code.claude.com/docs/en/skills',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Commands',
        url: 'https://code.claude.com/docs/en/commands',
        verifiedOn: VERIFIED_ON,
      },
    ],
  },
  codex: {
    key: 'codex',
    flag: '--codex',
    aliases: [],
    label: 'OpenAI Codex CLI',
    adapterFile: 'codex-cli.md',
    supportTier: 'first-class',
    disposition: 'native-skill-and-prompt-wrapper',
    installSurface: 'native Legion skill plus one prompt wrapper; per-command prompts are compatibility aliases',
    canonicalEntrypoint: { local: '/project:legion', global: '/prompts:legion' },
    parityGaps: ['Codex custom prompts are deprecated; the installed Legion skill is the durable workflow surface.'],
    lastVerified: VERIFIED_ON,
    smokeTestStatus: 'covered',
    installLifecycle: MANAGED_INSTALL_LIFECYCLE,
    scopeSupport: { local: true, global: true },
    storageLayout: 'legion',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
    supportsAtRefs: false,
    nativeSurfaces: [
      {
        key: 'codex-prompts',
        type: 'codex-prompts',
        pathKind: 'dir',
        localPath: '$PROJECT/.codex/prompts',
        globalPath: '$HOME/.codex/prompts',
      },
      {
        key: 'codex-bridge',
        type: 'codex-bridge',
        pathKind: 'file',
        localPath: '$PROJECT/.agents/skills/legion/SKILL.md',
        globalPath: '$HOME/.agents/skills/legion/SKILL.md',
      },
    ],
    entrypoints: {
      local: '/project:legion',
      global: '/prompts:legion',
    },
    evidence: [
      {
        title: 'Custom prompts',
        url: 'https://developers.openai.com/codex/custom-prompts',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Skills',
        url: 'https://developers.openai.com/codex/skills',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Prompt loader source',
        url: 'https://github.com/openai/codex/blob/main/codex-rs/core/src/custom_prompts.rs',
        verifiedOn: VERIFIED_ON,
      },
    ],
  },
  cursor: {
    key: 'cursor',
    flag: '--cursor',
    aliases: [],
    label: 'Cursor',
    adapterFile: 'cursor.md',
    supportTier: 'compatible',
    disposition: 'rules-only',
    installSurface: 'workspace rules only',
    canonicalEntrypoint: { local: 'plain-language Legion request', global: null },
    parityGaps: ['Cursor rules do not provide a native Legion command or skill invocation surface.'],
    lastVerified: VERIFIED_ON,
    smokeTestStatus: 'metadata-only',
    installLifecycle: MANAGED_INSTALL_LIFECYCLE,
    scopeSupport: { local: true, global: false },
    storageLayout: 'legion',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent'],
    supportsAtRefs: false,
    nativeSurfaces: [
      {
        key: 'cursor-rule',
        type: 'cursor-rule',
        pathKind: 'file',
        localPath: '$PROJECT/.cursor/rules/legion.mdc',
      },
    ],
    entrypoints: {
      local: 'plain-language Legion requests',
      global: null,
    },
    evidence: [
      {
        title: 'Project rules',
        url: 'https://cursor.com/docs/rules',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Background agent',
        url: 'https://docs.cursor.com/background-agent/overview',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Custom modes beta',
        url: 'https://docs.cursor.com/chat/custom-modes',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Review mode',
        url: 'https://docs.cursor.com/chat/review-mode',
        verifiedOn: VERIFIED_ON,
      },
    ],
  },
  copilot: {
    key: 'copilot',
    flag: '--copilot',
    aliases: [],
    label: 'GitHub Copilot CLI',
    adapterFile: 'copilot-cli.md',
    supportTier: 'first-class',
    disposition: 'skills-and-custom-agent',
    installSurface: 'repository or user Legion skill plus a custom agent profile',
    canonicalEntrypoint: { local: '/legion', global: '/legion' },
    parityGaps: [],
    lastVerified: VERIFIED_ON,
    smokeTestStatus: 'covered',
    installLifecycle: MANAGED_INSTALL_LIFECYCLE,
    scopeSupport: { local: true, global: true },
    storageLayout: 'legion',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
    supportsAtRefs: false,
    nativeSurfaces: [
      {
        key: 'copilot-skills',
        type: 'copilot-skills',
        pathKind: 'dir',
        localPath: '$PROJECT/.github/skills',
        globalPath: '$HOME/.copilot/skills',
      },
      {
        key: 'copilot-agent',
        type: 'copilot-agent',
        pathKind: 'file',
        localPath: '$PROJECT/.github/agents/legion.agent.md',
        globalPath: '$HOME/.config/copilot/agents/legion.agent.md',
      },
    ],
    entrypoints: {
      local: '/legion',
      global: '/legion',
    },
    evidence: [
      {
        title: 'Custom agent profile paths',
        url: 'https://docs.github.com/en/copilot/customizing-copilot/creating-custom-copilot-chat-modes?tool=vscode',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Copilot CLI custom agents',
        url: 'https://docs.github.com/en/copilot/how-tos/agents/copilot-cli/using-custom-agents',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Create a custom agent profile',
        url: 'https://docs.github.com/en/copilot/customizing-copilot/creating-a-custom-agent-profile',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Create a repo skill',
        url: 'https://docs.github.com/en/copilot/customizing-copilot/adding-custom-instructions-for-github-copilot#creating-a-repository-custom-skill',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Coding agent subagents',
        url: 'https://docs.github.com/en/copilot/how-tos/agents/copilot-coding-agent/customizing-the-coding-agent-setup/customizing-or-disabling-agent-delegation',
        verifiedOn: VERIFIED_ON,
      },
    ],
  },
  gemini: {
    key: 'gemini',
    flag: '--gemini',
    aliases: [],
    label: 'Google Gemini CLI',
    adapterFile: 'gemini-cli.md',
    supportTier: 'legacy',
    disposition: 'native-commands',
    installSurface: 'legacy native custom commands for enterprise or pinned Gemini CLI users',
    canonicalEntrypoint: { local: '/legion', global: '/legion' },
    parityGaps: ['Consumer Gemini CLI traffic moved to Antigravity CLI on June 18, 2026.'],
    lastVerified: VERIFIED_ON,
    smokeTestStatus: 'legacy-metadata-only',
    installLifecycle: MANAGED_INSTALL_LIFECYCLE,
    scopeSupport: { local: true, global: true },
    storageLayout: 'legion',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
    supportsAtRefs: false,
    nativeSurfaces: [
      {
        key: 'gemini-commands',
        type: 'gemini-commands',
        pathKind: 'dir',
        localPath: '$PROJECT/.gemini/commands/legion',
        globalPath: '$HOME/.gemini/commands/legion',
      },
    ],
    entrypoints: {
      local: '/legion',
      global: '/legion',
    },
    evidence: [
      {
        title: 'Custom commands',
        url: 'https://google-gemini.github.io/gemini-cli/docs/cli/commands/',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Configuration and GEMINI.md',
        url: 'https://github.com/google-gemini/gemini-cli?tab=readme-ov-file#configuration',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Extensions',
        url: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/extension.md',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Gemini CLI to Antigravity transition',
        url: 'https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/',
        verifiedOn: VERIFIED_ON,
      },
    ],
  },
  antigravity: {
    key: 'antigravity',
    flag: '--antigravity',
    aliases: ['--agy'],
    label: 'Antigravity CLI',
    adapterFile: 'antigravity-cli.md',
    supportTier: 'first-class',
    disposition: 'native-plugins',
    installSurface: 'native plugins with manifest, skills, and agents',
    canonicalEntrypoint: { local: '/legion', global: '/legion' },
    parityGaps: [],
    lastVerified: VERIFIED_ON,
    smokeTestStatus: 'covered',
    installLifecycle: MANAGED_INSTALL_LIFECYCLE,
    scopeSupport: { local: true, global: true },
    storageLayout: 'legion',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
    supportsAtRefs: false,
    nativeSurfaces: [
      {
        key: 'antigravity-plugin',
        type: 'antigravity-plugin',
        pathKind: 'dir',
        localPath: '$PROJECT/.agents/plugins/legion',
        globalPath: '$HOME/.gemini/config/plugins/legion',
      },
    ],
    entrypoints: {
      local: '/legion',
      global: '/legion',
    },
    evidence: [
      {
        title: 'Plugins structure',
        url: 'https://antigravity.google/docs/cli-plugins',
        verifiedOn: VERIFIED_ON,
      },
    ],
  },
  kiro: {
    key: 'kiro',
    flag: '--kiro',
    aliases: ['--amazon-q'],
    label: 'Kiro CLI (formerly Amazon Q Developer CLI)',
    adapterFile: 'kiro-cli.md',
    supportTier: 'compatible',
    disposition: 'custom-agent-and-steering',
    installSurface: 'custom agent plus steering files',
    canonicalEntrypoint: { local: '@legion', global: '@legion' },
    parityGaps: ['Kiro exposes custom agents through @ mentions rather than a native legion command.'],
    lastVerified: VERIFIED_ON,
    smokeTestStatus: 'metadata-only',
    installLifecycle: MANAGED_INSTALL_LIFECYCLE,
    scopeSupport: { local: true, global: true },
    storageLayout: 'legion',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
    supportsAtRefs: false,
    nativeSurfaces: [
      {
        key: 'kiro-agent',
        type: 'kiro-agent',
        pathKind: 'file',
        localPath: '$PROJECT/.kiro/agents/legion.md',
        globalPath: '$HOME/.kiro/agents/legion.md',
      },
      {
        key: 'kiro-steering',
        type: 'kiro-steering',
        pathKind: 'file',
        localPath: '$PROJECT/.kiro/steering/legion.md',
        globalPath: '$HOME/.kiro/steering/AGENTS.md',
      },
    ],
    entrypoints: {
      local: '@legion',
      global: '@legion',
    },
    evidence: [
      {
        title: 'Amazon Q Developer CLI is now Kiro CLI',
        url: 'https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/command-line.html',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Custom agents',
        url: 'https://kiro.dev/docs/cli/custom-agents/',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Steering',
        url: 'https://kiro.dev/docs/cli/steering/',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Chat subagents',
        url: 'https://kiro.dev/docs/cli/chat/subagents/',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Hooks and permissions',
        url: 'https://kiro.dev/docs/cli/hooks/',
        verifiedOn: VERIFIED_ON,
      },
    ],
  },
  windsurf: {
    key: 'windsurf',
    flag: '--windsurf',
    aliases: [],
    label: 'Windsurf',
    adapterFile: 'windsurf.md',
    supportTier: 'compatible',
    disposition: 'rules-only',
    installSurface: 'workspace rules only',
    canonicalEntrypoint: { local: 'plain-language Legion request', global: null },
    parityGaps: ['Windsurf rules do not provide a native Legion command or skill invocation surface.'],
    lastVerified: VERIFIED_ON,
    smokeTestStatus: 'metadata-only',
    installLifecycle: MANAGED_INSTALL_LIFECYCLE,
    scopeSupport: { local: true, global: false },
    storageLayout: 'legion',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
    supportsAtRefs: false,
    nativeSurfaces: [
      {
        key: 'windsurf-rule',
        type: 'windsurf-rule',
        pathKind: 'file',
        localPath: '$PROJECT/.windsurf/rules/legion.md',
      },
    ],
    entrypoints: {
      local: 'plain-language Legion requests',
      global: null,
    },
    evidence: [
      {
        title: 'Rules and memories',
        url: 'https://docs.devin.ai/desktop/cascade/memories',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Planning mode',
        url: 'https://docs.windsurf.com/windsurf/cascade/planning-mode',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Ask mode',
        url: 'https://docs.windsurf.com/windsurf/getting-started#ask-mode',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Hooks',
        url: 'https://docs.devin.ai/desktop/cascade/mcp',
        verifiedOn: VERIFIED_ON,
      },
    ],
  },
  opencode: {
    key: 'opencode',
    flag: '--opencode',
    aliases: [],
    label: 'OpenCode',
    adapterFile: 'opencode.md',
    supportTier: 'first-class',
    disposition: 'commands-and-subagent',
    installSurface: 'single Legion command plus compatibility command aliases and a Legion subagent',
    canonicalEntrypoint: { local: '/legion', global: '/legion' },
    parityGaps: [],
    lastVerified: VERIFIED_ON,
    smokeTestStatus: 'covered',
    installLifecycle: MANAGED_INSTALL_LIFECYCLE,
    scopeSupport: { local: true, global: true },
    storageLayout: 'legion',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent'],
    supportsAtRefs: false,
    nativeSurfaces: [
      {
        key: 'opencode-commands',
        type: 'opencode-commands',
        pathKind: 'dir',
        localPath: '$PROJECT/.opencode/commands',
        globalPath: '$HOME/.config/opencode/commands',
      },
      {
        key: 'opencode-agent',
        type: 'opencode-agent',
        pathKind: 'file',
        localPath: '$PROJECT/.opencode/agent/legion.md',
        globalPath: '$HOME/.config/opencode/agent/legion.md',
      },
    ],
    entrypoints: {
      local: '/legion',
      global: '/legion',
    },
    evidence: [
      {
        title: 'Custom commands',
        url: 'https://opencode.ai/docs/commands/',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Custom agents',
        url: 'https://opencode.ai/docs/agents/',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Task tool and subagents',
        url: 'https://opencode.ai/docs/agents/task',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Configuration directories',
        url: 'https://opencode.ai/docs/config',
        verifiedOn: VERIFIED_ON,
      },
    ],
  },
  hermes: {
    key: 'hermes',
    flag: '--hermes',
    aliases: ['--hermes-agent'],
    label: 'Hermes Agent',
    adapterFile: 'hermes-agent.md',
    supportTier: 'first-class',
    disposition: 'native-skill-with-delegation',
    installSurface: 'native Legion skill with parallel delegation, kanban task tracking, and gateway delivery',
    canonicalEntrypoint: { local: '/legion', global: '/legion' },
    parityGaps: [],
    lastVerified: VERIFIED_ON,
    smokeTestStatus: 'covered',
    installLifecycle: MANAGED_INSTALL_LIFECYCLE,
    scopeSupport: { local: true, global: true },
    storageLayout: 'hermes',
    allowedTools: null,
    supportsAtRefs: false,
    nativeSurfaces: [
      {
        key: 'hermes-skill',
        type: 'hermes-skill',
        pathKind: 'file',
        localPath: '$PROJECT/.hermes/skills/workflow/legion/SKILL.md',
        globalPath: '$HOME/.hermes/skills/workflow/legion/SKILL.md',
      },
    ],
    entrypoints: {
      local: '/legion',
      global: '/legion',
    },
    evidence: [
      {
        title: 'Skills System',
        url: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/skills',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Delegation',
        url: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Kanban',
        url: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'CLI Reference',
        url: 'https://hermes-agent.nousresearch.com/docs/reference/cli-commands',
        verifiedOn: VERIFIED_ON,
      },
    ],
  },
  kilo: {
    key: 'kilo',
    flag: '--kilo',
    aliases: [],
    label: 'Kilo CLI',
    adapterFile: 'kilo-cli.md',
    supportTier: 'compatible',
    disposition: 'commands-and-subagent',
    installSurface: 'single Legion command plus compatibility command aliases and a Legion subagent',
    canonicalEntrypoint: { local: '/legion', global: '/legion' },
    parityGaps: ['The Kilo Code plugin is the recommended first-class Kilo path; Kilo CLI remains a CLI-backed compatibility surface.'],
    lastVerified: VERIFIED_ON,
    smokeTestStatus: 'metadata-only',
    installLifecycle: MANAGED_INSTALL_LIFECYCLE,
    scopeSupport: { local: true, global: true },
    storageLayout: 'legion',
    allowedTools: null,
    supportsAtRefs: false,
    nativeSurfaces: [
      {
        key: 'kilo-commands',
        type: 'kilo-commands',
        pathKind: 'dir',
        localPath: '$PROJECT/.kilo/commands',
        globalPath: '$HOME/.config/kilo/commands',
      },
      {
        key: 'kilo-agent',
        type: 'kilo-agent',
        pathKind: 'file',
        localPath: '$PROJECT/.kilo/agents/legion.md',
        globalPath: '$HOME/.config/kilo/agents/legion.md',
      },
      {
        key: 'kilo-skills',
        type: 'kilo-skills',
        pathKind: 'dir',
        localPath: '$PROJECT/.kilo/skills',
        globalPath: '$HOME/.kilo/skills',
      },
    ],
    entrypoints: {
      local: '/legion',
      global: '/legion',
    },
    evidence: [
      {
        title: 'Kilo Code workflows (slash commands)',
        url: 'https://kilo.ai/docs/customize/workflows',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Kilo Code skills (Agent Skills format)',
        url: 'https://kilo.ai/docs/customize/skills',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Kilo Code custom modes (agents)',
        url: 'https://kilo.ai/docs/customize/custom-modes',
        verifiedOn: VERIFIED_ON,
      },
    ],
  },
  kilocode: {
    key: 'kilocode',
    flag: '--kilo-code',
    aliases: ['--kilocode'],
    label: 'Kilo Code Plugin',
    adapterFile: 'kilo-code.md',
    supportTier: 'first-class',
    disposition: 'plugin-mode-workflows-and-skills',
    installSurface: 'Kilo Code Legion mode plus a single Legion workflow, compatibility workflows, and Agent Skills',
    canonicalEntrypoint: { local: 'Legion mode or /legion', global: 'Legion mode or /legion' },
    parityGaps: [],
    lastVerified: VERIFIED_ON,
    smokeTestStatus: 'covered',
    installLifecycle: MANAGED_INSTALL_LIFECYCLE,
    scopeSupport: { local: true, global: true },
    storageLayout: 'legion',
    allowedTools: null,
    supportsAtRefs: false,
    nativeSurfaces: [
      {
        key: 'kilocode-workflows',
        type: 'kilo-commands',
        pathKind: 'dir',
        localPath: '$PROJECT/.kilocode/workflows',
        globalPath: '$HOME/.kilocode/workflows',
      },
      {
        key: 'kilocode-skills',
        type: 'kilo-skills',
        pathKind: 'dir',
        localPath: '$PROJECT/.kilocode/skills',
        globalPath: '$HOME/.kilocode/skills',
      },
      {
        key: 'kilocode-cli-workflows',
        type: 'kilo-commands',
        pathKind: 'dir',
        localPath: '$PROJECT/.kilo/commands',
        globalPath: '$HOME/.config/kilo/commands',
      },
      {
        key: 'kilocode-cli-skills',
        type: 'kilo-skills',
        pathKind: 'dir',
        localPath: '$PROJECT/.kilo/skills',
        globalPath: '$HOME/.kilo/skills',
      },
      {
        key: 'kilocode-modes',
        type: 'kilocode-modes',
        pathKind: 'file',
        localPath: '$PROJECT/.kilocodemodes',
        globalPath: '$HOME/.kilocode/globalStorage/kilo code.kilo-code/settings/custom_modes.yaml',
      },
    ],
    entrypoints: {
      local: 'select the Legion mode or run /legion',
      global: 'select the Legion mode or run /legion',
    },
    evidence: [
      {
        title: 'Kilo Code workflows',
        url: 'https://kilo.ai/docs/customize/workflows',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Kilo Code legacy workflow migration path',
        url: 'https://kilo.ai/docs/customize/workflows',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Kilo Code custom modes',
        url: 'https://kilo.ai/docs/customize/custom-modes',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Kilo Code skills',
        url: 'https://kilo.ai/docs/customize/skills',
        verifiedOn: VERIFIED_ON,
      },
    ],
  },
  aider: {
    key: 'aider',
    flag: '--aider',
    aliases: [],
    label: 'Aider',
    adapterFile: 'aider.md',
    supportTier: 'manual-only',
    disposition: 'manual-only',
    installSurface: 'manual instructions only',
    canonicalEntrypoint: { local: null, global: null },
    parityGaps: ['Aider does not expose a native installable Legion command or skill surface.'],
    lastVerified: VERIFIED_ON,
    smokeTestStatus: 'manual-only',
    installLifecycle: {
      install: 'not-installed',
      update: 'not-installed',
      uninstall: 'not-installed',
      verify: 'manual'
    },
    scopeSupport: { local: false, global: false },
    storageLayout: 'legion',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
    supportsAtRefs: false,
    nativeSurfaces: [],
    entrypoints: {
      local: null,
      global: null,
    },
    evidence: [
      {
        title: 'Configuration',
        url: 'https://aider.chat/docs/config/aider_conf.html',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Conventions via AGENTS.md and CONVENTIONS.md',
        url: 'https://aider.chat/docs/usage/conventions.html',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Chat modes',
        url: 'https://aider.chat/docs/usage/modes.html',
        verifiedOn: VERIFIED_ON,
      },
      {
        title: 'Architect mode',
        url: 'https://aider.chat/docs/usage/modes.html#architect-mode',
        verifiedOn: VERIFIED_ON,
      },
    ],
  },
};

const RUNTIME_ORDER = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'gemini',
  'antigravity',
  'kiro',
  'windsurf',
  'opencode',
  'hermes',
  'kilo',
  'kilocode',
  'aider',
];

function resolveRuntimeKey(arg) {
  for (const runtimeKey of RUNTIME_ORDER) {
    const runtime = RUNTIME_METADATA[runtimeKey];
    if (arg === runtime.flag || runtime.aliases.includes(arg)) {
      return runtimeKey;
    }
  }
  return null;
}

function installableRuntimeKeys() {
  return RUNTIME_ORDER.filter((runtimeKey) => {
    const runtime = RUNTIME_METADATA[runtimeKey];
    return runtime.scopeSupport.local || runtime.scopeSupport.global;
  });
}

function recommendedRuntimeKeys() {
  return installableRuntimeKeys().filter((runtimeKey) => RUNTIME_METADATA[runtimeKey].supportTier === 'first-class');
}

module.exports = {
  LEGION_COMMANDS,
  LEGION_CLI_COMMANDS,
  SUPPORT_TIERS,
  RUNTIME_METADATA,
  RUNTIME_ORDER,
  installableRuntimeKeys,
  recommendedRuntimeKeys,
  resolveRuntimeKey,
};
