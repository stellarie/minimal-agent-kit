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
