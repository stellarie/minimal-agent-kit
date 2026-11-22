import type { NativeSubagentEvent, SubagentState } from "../../core/src/adapters/types.ts";

// What one `codex exec --json` run gave.
export interface CodexRun {
  threadId?: string;
  // The last agent_message text.
  reply?: string;
}

// Every run passes the bypass flag, so this warning comes each time and says nothing new.
const TRUST_WARNING = /^`--dangerously-bypass-hook-trust` is enabled/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

// Reads one stdout line into the run. Gives the activity lines it makes.
// An earlier agent_message becomes activity when a newer one replaces it as the reply.
export function readLine(run: CodexRun, line: string): string[] {
  let ev: Record<string, unknown> | undefined;
  try {
    ev = record(JSON.parse(line));
  } catch {
    return [];
  }
  if (ev?.type === "thread.started" && typeof ev.thread_id === "string") {
    run.threadId = ev.thread_id;
    return [];
  }
  const item = ev?.type === "item.completed" ? record(ev.item) : undefined;
  if (item?.type === "command_execution") {
    return [`$ ${String(item.command)} (exit ${String(item.exit_code)}, ${String(item.status)})`];
  }
  if (item?.type === "error" && typeof item.message === "string") {
    return TRUST_WARNING.test(item.message) ? [] : [`error: ${item.message}`];
  }
  if (item?.type === "agent_message" && typeof item.text === "string") {
    const before = run.reply;
    run.reply = item.text;
    return before === undefined ? [] : [before];
  }
  return [];
}

// Codex agent states: pending_init and running go on; the others end the agent.
function agentState(status: unknown): SubagentState {
  if (status === "pending_init" || status === "running") return "running";
  if (status === "completed" || status === "shutdown") return "done";
  return "failed";
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]!.trim();
}

// `codex exec --json` collab_tool_call items. Unverified: no recorded run had one.
// A spawn_agent item starts a subagent. agents_states of any collab item end it.
export function collabEvents(line: string): NativeSubagentEvent[] {
  let ev: Record<string, unknown> | undefined;
  try {
    ev = record(JSON.parse(line));
  } catch {
    return [];
  }
  if (ev?.type !== "item.started" && ev?.type !== "item.completed") return [];
  const item = record(ev.item);
  if (item?.type !== "collab_tool_call" || typeof item.id !== "string") return [];
  const states = record(item.agents_states) ?? {};
  if (item.tool === "spawn_agent") {
    const title = typeof item.prompt === "string" && item.prompt.trim() ? firstLine(item.prompt) : "subagent";
    const receivers = Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids.filter((x) => typeof x === "string") : [];
    const alias = receivers[0] as string | undefined;
    let state: SubagentState = "running";
    if (item.status === "failed") state = "failed";
    else if (alias !== undefined && record(states[alias])) state = agentState(record(states[alias])!.status);
    return [{ id: item.id, title, ...(alias !== undefined ? { alias } : {}), state }];
  }
  return Object.entries(states).map(([id, s]) => ({ id, state: agentState(record(s)?.status) }));
}

// A blocked command has no command_execution item: only stderr tells it.
export function stderrActivity(line: string): string[] {
  const at = line.indexOf("error=");
  return at >= 0 ? [line.slice(at + "error=".length).trim()] : [];
}
