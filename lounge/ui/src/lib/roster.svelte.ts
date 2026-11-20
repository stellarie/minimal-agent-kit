import type { AgentEntry, AgentView, RuntimeInfo } from "./api.ts";
import { OWNER_TAPE, tapeVar } from "./roster.ts";

// Active agents and runtimes. Reactive.
export const roster: { agents: AgentView[]; runtimes: RuntimeInfo[]; retired: AgentEntry[] } = $state({
  agents: [],
  runtimes: [],
  retired: [],
});

export function setRoster(agents: AgentView[], runtimes: RuntimeInfo[], retired: AgentEntry[] = []): void {
  roster.agents = agents;
  roster.retired = retired;
  roster.runtimes = runtimes;
}

// The label color of a caller, for --who.
export function whoColor(caller: string): string {
  if (caller === "owner") return OWNER_TAPE;
  const entry = roster.agents.find((e) => e.id === caller) ?? roster.retired.find((e) => e.id === caller);
  return tapeVar(entry ?? { tape: 1 });
}

// The default pick in a form.
export function firstAgent(): string {
  return roster.agents.find((e) => e.enabled)?.id ?? roster.agents[0]?.id ?? "";
}
