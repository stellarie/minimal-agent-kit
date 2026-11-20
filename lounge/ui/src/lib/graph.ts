import type { Agent, ThreadTree, WorkState } from "./api.ts";

export interface GraphRow {
  id: string;
  name: string;
  lead: Agent;
  depth: number;
  state: "working" | "idle" | "stopped";
  agents: Agent[];
}

// Tree order. Live work, when known, replaces the working lists of the fetch.
export function graphRows(tree: ThreadTree, work: WorkState[] | undefined): GraphRow[] {
  const rows: GraphRow[] = [];
  const walk = (node: ThreadTree, depth: number) => {
    const agents = node.stopped ? [] : work ? work.filter((w) => w.roomId === node.id).map((w) => w.agent) : node.working;
    const state = node.stopped ? "stopped" : agents.length > 0 ? "working" : "idle";
    rows.push({ id: node.id, name: node.name, lead: node.lead, depth, state, agents });
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(tree, 0);
  return rows;
}
