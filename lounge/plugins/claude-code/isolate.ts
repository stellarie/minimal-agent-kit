import { homedir } from "node:os";

// Must outlast the 540 s approval wait.
const HOOK_TIMEOUT_S = 600;
export const GUARD_MATCHER = "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|Read|Glob|Grep";
// These shell-like tools skip the hook, so a tool mode cannot judge them.
export const MODE_DISALLOWED = "Monitor,Tmux";
// Native subagents bypass the agent graph: lounge_spawn replaces them.
// Workflow too: the model reached it through ToolSearch.
export const SUBAGENT_DISALLOWED = "Task,Workflow";

// One value: a second --disallowedTools flag would replace the first.
export function disallowedTools(toolMode: string | undefined): string {
  const limited = toolMode !== undefined && toolMode !== "full";
  return `--disallowedTools=${limited ? `${SUBAGENT_DISALLOWED},${MODE_DISALLOWED}` : SUBAGENT_DISALLOWED}`;
}

// The lounge guard runs before each file or shell tool.
export function guardSettings(hookFile: string): { hooks: unknown } {
  const command = `node "${hookFile.replace(/\\/g, "/")}"`;
  return {
    hooks: {
      PreToolUse: [{ matcher: GUARD_MATCHER, hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] }],
    },
  };
}

// No CLAUDE.md of the user or of a project: the lounge inserts the files that the owner chose.
// The paths use forward slashes, which the globs read on every system.
export function claudeMdExcludes(profile: string = homedir()): string[] {
  const home = profile.replace(/\\/g, "/");
  return [
    `${home}/CLAUDE.md`,
    `${home}/CLAUDE.local.md`,
    `${home}/.claude/CLAUDE.md`,
    `${home}/.claude/rules/**`,
    "**/CLAUDE.md",
    "**/CLAUDE.local.md",
    "**/.claude/CLAUDE.md",
    "**/.claude/rules/**",
  ];
}

// The lounge settings file: the guard hook, and the CLAUDE.md excludes.
// It copies nothing from the user's own settings.
export function isolationSettings(hookFile: string): { hooks: unknown; claudeMdExcludes: string[] } {
  return { ...guardSettings(hookFile), claudeMdExcludes: claudeMdExcludes() };
}

export interface ClaudeIsolation {
  // The flags for print mode. They come before the other flags.
  args: string[];
  // Added to the environment of the child.
  env: Record<string, string>;
}

// Claude runs with the project and local settings only: no user settings, no user plugins,
// no user skills, no slash commands, and only the MCP server of the lounge.
// Never --bare: it skips hooks, so the guard would not run, and it skips OAuth.
export function claudeIsolationArgs(files: { mcpPath: string; settingsPath: string }): ClaudeIsolation {
  return {
    args: [
      "-p",
      "--setting-sources",
      "project,local",
      "--strict-mcp-config",
      "--mcp-config",
      files.mcpPath,
      "--settings",
      files.settingsPath,
      "--disable-slash-commands",
    ],
    env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" },
  };
}
