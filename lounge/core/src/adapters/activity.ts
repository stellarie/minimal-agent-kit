import type { NativeSubagentEvent } from "./types.ts";

// One short line per tool call for the thread.
const MAX_LINE = 160;
const KEYS = ["command", "description", "file_path", "path", "pattern", "url", "query", "prompt"];

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_LINE ? `${flat.slice(0, MAX_LINE - 1)}…` : flat;
}

// "Bash: npm test", or the bare name.
export function toolLine(name: string, input: unknown): string {
  let args = input;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return oneLine(args ? `${name}: ${args}` : name);
    }
  }
  if (typeof args === "object" && args !== null) {
    const record = args as Record<string, unknown>;
    for (const key of KEYS) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return oneLine(`${name}: ${value}`);
    }
  }
  return oneLine(name);
}

// Claude stream-json: tool_use blocks in assistant events.
export function claudeToolLines(event: unknown): string[] {
  if (typeof event !== "object" || event === null) return [];
  const ev = event as { type?: unknown; message?: { content?: unknown } };
  if (ev.type !== "assistant" || !Array.isArray(ev.message?.content)) return [];
  const out: string[] = [];
  for (const block of ev.message.content as unknown[]) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: unknown; name?: unknown; input?: unknown };
    if (b.type === "tool_use" && typeof b.name === "string") out.push(toolLine(b.name, b.input));
  }
  return out;
}

const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

function firstLine(text: string): string {
  return text.trim().split("\n")[0]!.trim();
}

// The short title of a Task or Agent call: its description, else its prompt.
function subagentTitle(input: unknown): string {
  const args = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  for (const key of ["description", "prompt", "subagent_type"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return firstLine(value);
  }
  return "subagent";
}

// Claude stream-json: a Task or Agent tool_use starts a subagent. Its tool_result ends it.
export function claudeSubagents(event: unknown): NativeSubagentEvent[] {
  if (typeof event !== "object" || event === null) return [];
  const ev = event as { type?: unknown; message?: { content?: unknown } };
  if ((ev.type !== "assistant" && ev.type !== "user") || !Array.isArray(ev.message?.content)) return [];
  const out: NativeSubagentEvent[] = [];
  for (const block of ev.message.content as unknown[]) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; is_error?: unknown };
    if (ev.type === "assistant" && b.type === "tool_use" && typeof b.id === "string" && SUBAGENT_TOOLS.has(String(b.name))) {
      out.push({ id: b.id, title: subagentTitle(b.input), state: "running" });
    }
    // Every tool_result comes; the store ignores an id that no subagent has.
    if (ev.type === "user" && b.type === "tool_result" && typeof b.tool_use_id === "string") {
      out.push({ id: b.tool_use_id, state: b.is_error === true ? "failed" : "done" });
    }
  }
  return out;
}

// Splits a stream into lines; calls back per full line.
export function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let rest = "";
  return (chunk) => {
    rest += chunk;
    let at: number;
    while ((at = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, at).trim();
      rest = rest.slice(at + 1);
      if (line) onLine(line);
    }
  };
}
