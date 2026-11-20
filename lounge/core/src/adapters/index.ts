import type { Agent } from "../config.ts";
import type { Roster } from "../roster/roster.ts";
import type { RuntimeContext, RuntimeKind } from "../roster/types.ts";
import type { Adapter, AdapterLookup } from "./types.ts";

interface Cached {
  adapter: Adapter;
  // A reload makes a new kind object: the adapter is stale.
  kind: RuntimeKind;
}

// One adapter per agent, built on first use.
export class AdapterPool implements AdapterLookup {
  readonly #roster: Roster;
  readonly #kinds: () => RuntimeKind[];
  readonly #ctx: RuntimeContext;
  readonly #cache = new Map<Agent, Cached>();
  readonly #off: () => void;

  constructor(roster: Roster, kinds: () => RuntimeKind[], ctx: RuntimeContext) {
    this.#roster = roster;
    this.#kinds = kinds;
    this.#ctx = ctx;
    // A running turn keeps the adapter it started with.
    this.#off = roster.onChange((id) => {
      this.#cache.delete(id);
    });
  }

  get(id: Agent): Adapter | undefined {
    const cached = this.#cache.get(id);
    if (cached && this.#kinds().includes(cached.kind)) return cached.adapter;
    this.#cache.delete(id);
    const entry = this.#roster.get(id);
    if (entry === undefined || entry.retired) return undefined;
    const kind = this.#kinds().find((k) => k.id === entry.runtime);
    if (kind === undefined) return undefined;
    const adapter = kind.create(entry, this.#ctx);
    this.#cache.set(id, { adapter, kind });
    return adapter;
  }

  close(): void {
    this.#off();
    this.#cache.clear();
  }
}
