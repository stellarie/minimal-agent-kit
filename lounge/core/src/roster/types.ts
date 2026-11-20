import type { Adapter, ChatTurnInput } from "../adapters/types.ts";
import type { Guard } from "../guard/guard.ts";
import type { ToolMode } from "../guard/modes.ts";

export type { ToolMode };

// 2 to 24 characters: a-z, 0-9, hyphen.
export const ID_PATTERN = /^[a-z][a-z0-9-]{1,23}$/;
// The last two guard lookups in plain objects.
export const RESERVED_IDS: readonly string[] = ["owner", "constructor", "prototype", "__proto__"];

export function validId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id) && !RESERVED_IDS.includes(id);
}

export const TAPE_SLOTS = [1, 2, 3, 4] as const;
export type Tape = (typeof TAPE_SLOTS)[number];

export interface RuntimeOptions {
  command?: string;
  commandArgs?: string[];
  softMs?: number;
  hardMs?: number;
  // Stub runtime only.
  reply?: string;
  // Later stages add keys.
  [key: string]: unknown;
}

export interface AgentEntry {
  id: string;
  runtime: string;
  model: string;
  effort: string;
  enabled: boolean;
  tape: Tape;
  options: RuntimeOptions;
  position: number;
  retired: boolean;
  // How the lounge treats its tool calls. "full" on a runtime without mode support.
  toolMode: ToolMode;
}

export type NewAgent = Pick<AgentEntry, "id" | "runtime"> &
  Partial<Pick<AgentEntry, "model" | "effort" | "enabled" | "tape" | "options" | "toolMode">>;

export type AgentPatch = Partial<
  Pick<AgentEntry, "runtime" | "model" | "effort" | "enabled" | "tape" | "options" | "position" | "toolMode">
>;

export interface RuntimeContext {
  home: string;
  // Absolute path of the kit hook core/guard/guard.js, from the core's own place.
  hookFile: string;
  mcpUrl(): string;
  guard: Guard;
  // Every token value, for redaction.
  secrets(): string[];
  prompt: {
    systemText(input: ChatTurnInput): string;
    turnText(input: ChatTurnInput): string;
    chatPrompt(input: ChatTurnInput): string;
    isPass(text: string): boolean;
  };
  activity: {
    claudeToolLines(event: unknown): string[];
    lineSplitter(onLine: (line: string) => void): (chunk: string) => void;
    toolLine(name: string, input: unknown): string;
  };
  log(text: string): void;
}

export interface RuntimeKind {
  id: string;
  label: string;
  // An empty list means the runtime takes no effort.
  efforts(entry: AgentEntry): string[];
  // Hints only. Free text is allowed.
  models(entry: AgentEntry): string[];
  create(entry: AgentEntry, ctx: RuntimeContext): Adapter;
  // True when its tool calls reach Guard.check, so a tool mode works.
  toolModes?: boolean;
  // The error text, or unset when valid.
  validate?(options: RuntimeOptions): string | undefined;
}
