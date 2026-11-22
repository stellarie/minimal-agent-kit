import type { Caller, Subagent } from "./api.ts";

// A known key changes in place, so a row keeps its spot.
export function upsertSubagent(list: readonly Subagent[], next: Subagent): Subagent[] {
  const at = list.findIndex((s) => s.key === next.key);
  if (at < 0) return [...list, next];
  return list.map((s, i) => (i === at ? next : s));
}

// Deleted rooms take the rows that start in them and the child rows of them.
export function dropRooms(list: readonly Subagent[], ids: readonly string[]): Subagent[] {
  const gone = new Set(ids);
  return list.filter((s) => !gone.has(s.roomId) && !(s.threadId !== undefined && gone.has(s.threadId)));
}

export interface AgentGroup {
  agent: Caller;
  items: Subagent[];
  running: number;
}

// One group per agent in first-seen order. Running rows first, then the newest.
export function byAgent(list: readonly Subagent[]): AgentGroup[] {
  const groups = new Map<Caller, Subagent[]>();
  for (const s of list) groups.set(s.agent, [...(groups.get(s.agent) ?? []), s]);
  return [...groups].map(([agent, items]) => ({
    agent,
    items: [...items].sort((a, b) => {
      const run = Number(b.state === "running") - Number(a.state === "running");
      return run !== 0 ? run : b.since.localeCompare(a.since);
    }),
    running: items.filter((s) => s.state === "running").length,
  }));
}
