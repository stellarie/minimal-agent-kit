import type { DatabaseSync } from "node:sqlite";
import type { Agent } from "../config.ts";
import { readSetting, writeSetting } from "../db/settings.ts";
import { LoungeError } from "../lounge/room.ts";
import type { Action } from "./permissions.ts";

// One switch in the permissions panel.
export interface GrantGroup {
  id: string;
  label: string;
  tools: readonly string[];
  actions: readonly Action[];
  // Runtime tools outside the lounge server.
  native?: readonly string[];
}

export const GRANT_GROUPS: readonly GrantGroup[] = [
  {
    id: "chat",
    label: "Read and post in channels",
    tools: ["lounge_read", "lounge_post", "lounge_who", "lounge_channels", "lounge_threads", "lounge_attachment_read"],
    actions: ["lounge_read", "lounge_post", "lounge_who", "lounge_channels"],
  },
  { id: "nick", label: "Change its display name", tools: ["lounge_nick"], actions: ["lounge_nick"] },
  {
    id: "events",
    label: "Schedule events",
    tools: ["lounge_events", "lounge_schedule", "lounge_unschedule"],
    actions: ["event_list", "event_create", "event_cancel"],
  },
  { id: "threads", label: "Start work threads", tools: ["lounge_thread_start"], actions: ["thread_start"] },
  {
    id: "files",
    label: "Browse and send your files",
    tools: ["lounge_browse", "lounge_attach"],
    actions: ["lounge_files"],
  },
  {
    id: "web",
    label: "Search and read the web",
    tools: [],
    actions: [],
    native: ["WebSearch", "WebFetch"],
  },
  {
    id: "pc",
    label: "Read and write files on this PC, and run commands",
    tools: [],
    actions: [],
    native: ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "Bash", "PowerShell"],
  },
  {
    id: "sessions",
    label: "See and drive sessions",
    tools: ["session_list", "session_open", "session_message", "session_status", "session_close"],
    actions: ["session_list", "session_open", "session_message", "session_status", "session_close"],
  },
];

export type GrantMap = Record<string, boolean>;

// The name of the lounge entry in the turn's MCP config.
const MCP_SERVER = "lounge";
const KEY_PREFIX = "grants.";
// In a saved row, false turns off
// each group the row does not list.
const REST = "*";

// Every group starts off for a new agent.
// Plugin groups added later start off too.
export function denyAll(db: DatabaseSync, agent: Agent, groupIds: readonly string[]): void {
  const row: Record<string, boolean> = { [REST]: false };
  for (const id of groupIds) row[id] = false;
  writeSetting(db, KEY_PREFIX + agent, JSON.stringify(row));
}

// A plugin's tools, as one switch.
export interface ExtraGroup {
  id: string;
  label: string;
  tools: readonly string[];
}

// Per-agent tool grants. A missing entry is on.
export class Grants {
  #db: DatabaseSync;
  #extra: () => readonly ExtraGroup[];

  constructor(db: DatabaseSync, extra: () => readonly ExtraGroup[] = () => []) {
    this.#db = db;
    this.#extra = extra;
  }

  groups(): { id: string; label: string }[] {
    return [...GRANT_GROUPS, ...this.#extra()].map(({ id, label }) => ({ id, label }));
  }

  get(agent: Agent): GrantMap {
    const raw = readSetting(this.#db, KEY_PREFIX + agent);
    const out: GrantMap = Object.fromEntries(this.groups().map((g) => [g.id, true]));
    if (raw === undefined) return out;
    try {
      const saved = JSON.parse(raw) as Record<string, unknown>;
      if (saved[REST] === false) for (const id of Object.keys(out)) out[id] = false;
      for (const id of Object.keys(out)) {
        if (typeof saved[id] === "boolean") out[id] = saved[id];
      }
    } catch {
      // A bad row falls back to the defaults.
    }
    return out;
  }

  all(agents: readonly Agent[]): Record<string, GrantMap> {
    return Object.fromEntries(agents.map((i) => [i, this.get(i)]));
  }

  set(agent: Agent, body: unknown): GrantMap {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new LoungeError("bad_grants", "body must be an object of group ids to true or false");
    }
    const next = this.get(agent);
    for (const [id, value] of Object.entries(body)) {
      if (!(id in next)) throw new LoungeError("bad_grants", `unknown group ${id}`);
      if (typeof value !== "boolean") throw new LoungeError("bad_grants", `${id} must be true or false`);
      next[id] = value;
    }
    const closed = this.#closedRest(agent);
    writeSetting(this.#db, KEY_PREFIX + agent, JSON.stringify(closed ? { [REST]: false, ...next } : next));
    return next;
  }

  #closedRest(agent: Agent): boolean {
    const raw = readSetting(this.#db, KEY_PREFIX + agent);
    if (raw === undefined) return false;
    try {
      return (JSON.parse(raw) as Record<string, unknown>)[REST] === false;
    } catch {
      return false;
    }
  }

  allows(agent: Agent, action: Action): boolean {
    const map = this.get(agent);
    const group = GRANT_GROUPS.find((g) => g.actions.includes(action));
    return group === undefined || map[group.id] === true;
  }

  // Tool names for the runtime's allow list.
  runtimeTools(agent: Agent): string[] {
    const map = this.get(agent);
    return GRANT_GROUPS.filter((g) => map[g.id]).flatMap((g) => [
      ...g.tools.map((t) => `mcp__${MCP_SERVER}__${t}`),
      ...(g.native ?? []),
    ]).concat(this.#extra().filter((g) => map[g.id]).flatMap((g) => g.tools.map((t) => `mcp__${MCP_SERVER}__${t}`)));
  }

  pcAccess(agent: Agent): boolean {
    return this.get(agent)["pc"] === true;
  }

  // Plugin tools are off when their group is off.
  allowsGroup(agent: Agent, id: string): boolean {
    return this.get(agent)[id] !== false;
  }
}
