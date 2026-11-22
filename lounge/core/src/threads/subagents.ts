import type { NativeSubagentEvent, SubagentState } from "../adapters/types.ts";
import type { Agent, Caller } from "../config.ts";

// The list lives in memory: subagents do not outlive the core.
export const MAX_SUBAGENTS = 200;
const TITLE_MAX = 80;

export interface Subagent {
  // Unique in the list: kind, room, agent, and id.
  key: string;
  // The thread where the agent that started it works.
  roomId: string;
  agent: Caller;
  // child: a lounge_spawn thread. native: a subagent of the runtime.
  kind: "child" | "native";
  id: string;
  title: string;
  state: SubagentState;
  // The child thread, for a child.
  threadId?: string;
  since: string;
}

export interface SubagentsOptions {
  now?: () => Date;
  max?: number;
}

function cut(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
}

// Both kinds of subagent per agent, with live state, for the side panel.
export class Subagents {
  readonly #now: () => Date;
  readonly #max: number;
  // Insert order is age order.
  #entries = new Map<string, Subagent>();
  // A second id of a native subagent, to its key.
  #aliases = new Map<string, string>();
  #listeners = new Set<(e: Subagent) => void>();

  constructor(opts: SubagentsOptions = {}) {
    this.#now = opts.now ?? (() => new Date());
    this.#max = opts.max ?? MAX_SUBAGENTS;
  }

  list(): Subagent[] {
    return [...this.#entries.values()].map((e) => ({ ...e }));
  }

  onChange(listener: (e: Subagent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  native(roomId: string, agent: Agent, ev: NativeSubagentEvent): void {
    const base = `native|${roomId}|${agent}|`;
    const key = this.#aliases.get(base + ev.id) ?? base + ev.id;
    const entry = this.#entries.get(key);
    if (ev.alias) this.#aliases.set(base + ev.alias, key);
    if (!entry) {
      // An end with no start and no title has nothing to show.
      if (ev.title === undefined) return;
      this.#add({ key, roomId, agent, kind: "native", id: ev.id, title: cut(ev.title), state: ev.state, since: this.#stamp() });
      return;
    }
    this.#set(entry, ev.state);
  }

  // A turn ended: its native subagents that still run end with it.
  settle(roomId: string, agent: Agent, failed: boolean): void {
    for (const entry of [...this.#entries.values()]) {
      if (entry.kind !== "native" || entry.roomId !== roomId || entry.agent !== agent) continue;
      if (entry.state === "running") this.#set(entry, failed ? "failed" : "done");
    }
  }

  child(roomId: string, by: Caller, threadId: string, title: string): void {
    const key = `child|${threadId}`;
    if (this.#entries.has(key)) return;
    this.#add({ key, roomId, agent: by, kind: "child", id: threadId, title: cut(title), state: "running", threadId, since: this.#stamp() });
  }

  // The first end wins: a stop after a report keeps done.
  childEnded(threadId: string, state: Exclude<SubagentState, "running">): void {
    const entry = this.#entries.get(`child|${threadId}`);
    if (entry && entry.state === "running") this.#set(entry, state);
  }

  // Deleted rooms take their rows; the UI drops them on its own removed event.
  removeRooms(ids: readonly string[]): void {
    const gone = new Set(ids);
    for (const [key, entry] of this.#entries) {
      if (gone.has(entry.roomId) || (entry.threadId !== undefined && gone.has(entry.threadId))) this.#drop(key);
    }
  }

  #add(entry: Subagent): void {
    this.#entries.set(entry.key, entry);
    while (this.#entries.size > this.#max) this.#drop(this.#entries.keys().next().value!);
    this.#emit(entry);
  }

  #drop(key: string): void {
    this.#entries.delete(key);
    for (const [alias, to] of this.#aliases) if (to === key) this.#aliases.delete(alias);
  }

  #set(entry: Subagent, state: SubagentState): void {
    if (entry.state === state) return;
    entry.state = state;
    this.#emit(entry);
  }

  #stamp(): string {
    return this.#now().toISOString();
  }

  #emit(entry: Subagent): void {
    const copy = { ...entry };
    for (const listener of [...this.#listeners]) {
      try {
        listener(copy);
      } catch (err) {
        console.error("subagent listener failed:", err);
      }
    }
  }
}
