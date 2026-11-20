import type { Agent, Caller } from "../config.ts";
import type { Roster } from "../roster/roster.ts";
import type { Room } from "./room.ts";

export type AdapterState = "enabled" | "unavailable" | "slow";

export interface Presence {
  caller: Caller;
  lastSeen: string | null;
  nickname?: string;
  // The runtime answers or an MCP session is open.
  reachable: boolean;
  adapter?: AdapterState;
}

export interface PresenceState {
  slow?: ReadonlySet<Agent>;
  reachable?: ReadonlySet<Caller>;
}

function adapterState(agent: Agent, roster: Roster, slow: ReadonlySet<Agent>): AdapterState {
  if (!roster.enabled(agent) || roster.runtimeReason(agent) !== undefined) return "unavailable";
  return slow.has(agent) ? "slow" : "enabled";
}

export function presence(room: Room, roster: Roster, state: PresenceState = {}): Presence[] {
  const slow = state.slow ?? new Set<Agent>();
  const reachable = state.reachable ?? new Set<Caller>();
  return room.who().map((entry) => {
    const base = { ...entry, reachable: reachable.has(entry.caller) };
    return roster.has(entry.caller) ? { ...base, adapter: adapterState(entry.caller, roster, slow) } : base;
  });
}
