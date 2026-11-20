import { fileURLToPath } from "node:url";

export const NO_SUBAGENTS_FILE = fileURLToPath(new URL("./no-subagents.js", import.meta.url));
// Codex names its subagent tools collaboration<verb>_agent.
export const NO_SUBAGENTS_MATCHER = "^collaboration";

export interface CodexHookEntry {
  matcher: string;
  // Seconds. Unset: the Codex default.
  hooks: { type: "command"; command: string; timeout?: number }[];
}

export function noSubagentsHook(file: string = NO_SUBAGENTS_FILE): CodexHookEntry {
  return { matcher: NO_SUBAGENTS_MATCHER, hooks: [{ type: "command", command: `node "${file.replace(/\\/g, "/")}"` }] };
}

// A TOML inline value. JSON string escapes are valid TOML basic strings.
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .map(([k, v]) => `${k} = ${toml(v)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(value);
}

// One -c override sets the whole PreToolUse list, so the guard entries come in too.
// No feature flag: multi_agent=false does not stop spawning.
export function codexSubagentArgs(guard: readonly CodexHookEntry[] = [], file?: string): string[] {
  return ["-c", `hooks.PreToolUse=${toml([...guard, noSubagentsHook(file)])}`];
}
