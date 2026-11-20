import type { Agent } from "../config.ts";
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

export interface ChatTurnInput {
  agent: Agent;
  brief: string;
  // Unset in session rooms. parent marks a thread.
  channel?: { id: string; topic: string; name?: string; parent?: string };
  // Set for a work turn: no hard timeout.
  work?: { cwd: string };
  // One line per tool call, as it happens.
  onActivity?(line: string): void;
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
  // The lounge skills, listed by name and description.
  skillIndex?: { name: string; description: string }[];
  // The skills that the owner's last post named with $name, with their bodies.
  skillBodies?: { name: string; body: string }[];
  onSlow(): void;
}

export type ChatTurnResult = { kind: "post"; text: string } | { kind: "pass" };

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
