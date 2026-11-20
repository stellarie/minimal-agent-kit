// The core's modes: lounge/core/src/guard/modes.ts.
export type ToolMode = "read-only" | "ask" | "auto" | "full";

export const TOOL_MODES: readonly ToolMode[] = ["read-only", "ask", "auto", "full"];

export const MODE_LABELS: Record<ToolMode, string> = {
  "read-only": "Read only",
  ask: "Ask",
  auto: "Auto",
  full: "Full",
};

export const MODE_HELP: Record<ToolMode, string> = {
  "read-only": "Reads only. Commands that only read run. The lounge denies other changes and commands. Lounge tools still work.",
  ask: "You approve every change and every command that is not a plain read.",
  auto: "The agent's own model checks each change. Risky ones come to you. A runtime that cannot check asks, as in Ask mode.",
  full: "The guard rules alone decide.",
};

export const NO_MODES_NOTE = "This runtime ignores tool modes.";

// A runtime without mode support takes full only.
export function modeChoices(kindSupportsModes: boolean): ToolMode[] {
  return kindSupportsModes ? [...TOOL_MODES] : ["full"];
}

// The core's default for a new agent.
export function defaultMode(kindSupportsModes: boolean): ToolMode {
  return kindSupportsModes ? "ask" : "full";
}
