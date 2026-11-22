import type { Agent } from "../config.ts";
import type { GuardMode } from "../guard/guardMode.ts";
import type { Message } from "../lounge/room.ts";

export type AdapterName = string;

export interface TurnSelf {
  id: string;
  // The display name, else the capitalized id.
  name: string;
  // RuntimeKind.label.
  runtime: string;
  // The effective model.
  model: string;
  // "" means the runtime default.
  effort: string;
}

export interface TurnMember {
  id: string;
  name: string;
  runtime: string;
}

// A thread of the same channel.
export interface NearThread {
  id: string;
  title: string;
  lead: string;
  // Time of its last message.
  last: string;
}

export type SubagentState = "running" | "done" | "failed";

// A runtime's own subagent: a Claude Task or Agent call, or a Codex collab agent.
export interface NativeSubagentEvent {
  // The tool call id, or the agent id of the runtime.
  id: string;
  // Set on the start, and on an end with no start that must still show.
  title?: string;
  // A second id that later events of the same subagent use.
  alias?: string;
  state: SubagentState;
}

export interface ChatTurnInput {
  agent: Agent;
  brief: string;
  // Unset in session rooms. parent marks a thread.
  channel?: { id: string; topic: string; name?: string; parent?: string };
  // Set for a work turn: no hard timeout.
  work?: { cwd: string };
  // One line per tool call, as it happens.
  onActivity?(line: string): void;
  // Each start and end of a runtime subagent, as it happens.
  onSubagent?(event: NativeSubagentEvent): void;
  context: Message[];
  // Display names that callers chose.
  names?: Record<string, string>;
  // Local time with its UTC offset.
  now?: string;
  mcpToken: string;
  // Threads of the channel, newest activity first.
  threads?: NearThread[];
  // Lounge tools the owner granted, as runtime tool names.
  allowedTools?: string[];
  // Folders the runtime may read: attachments.
  readDirs?: string[];
  // The runtime facts of this agent.
  self?: TurnSelf;
  // Other enabled agents.
  members?: TurnMember[];
  // Context messages that the token budget dropped.
  omitted?: number;
  // The agent's instruction file and the project files, from buildContext.
  projectContext?: string;
  // The owner's rules.
  loungeRules?: string;
  // The lounge guard mode when the turn starts. Unset: the turn text has no guard line.
  guardMode?: GuardMode;
  // The lounge skills, listed by name and description.
  skillIndex?: { name: string; description: string }[];
  // The skills that the owner's last post named with $name, with their bodies.
  skillBodies?: { name: string; body: string }[];
  // One line each, for facts of the runtime. A runtime plugin sets them.
  notes?: string[];
  onSlow(): void;
}

// A file that the runtime made in a turn, such as an image of its image tool.
// The core saves it as an attachment of the reply.
export interface TurnFile {
  name: string;
  // The local file to read.
  path: string;
  mime: string;
}

// files: unset when the turn made none. A pass keeps them too.
export type ChatTurnResult = { kind: "post"; text: string; files?: TurnFile[] } | { kind: "pass"; files?: TurnFile[] };

// Finds a runtime by agent id.
export interface AdapterLookup {
  // Unset: the agent is retired or its runtime is unknown.
  get(id: Agent): Adapter | undefined;
}

export interface Adapter {
  name: AdapterName;
  available(): Promise<{ ok: boolean; reason?: string }>;
  chatTurn(input: ChatTurnInput, signal: AbortSignal): Promise<ChatTurnResult>;
}
