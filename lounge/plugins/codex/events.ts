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

// A blocked command has no command_execution item: only stderr tells it.
export function stderrActivity(line: string): string[] {
  const at = line.indexOf("error=");
  return at >= 0 ? [line.slice(at + "error=".length).trim()] : [];
}
