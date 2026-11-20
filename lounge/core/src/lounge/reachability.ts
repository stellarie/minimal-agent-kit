import type { Agent } from "../config.ts";
import type { AdapterLookup } from "../adapters/types.ts";
import type { Roster } from "../roster/roster.ts";
import { realTimers, type TimerApi } from "../sessions/slots.ts";

export interface ReachabilityOptions {
  adapters: AdapterLookup;
  roster: Roster;
  intervalMs: number;
  timers?: TimerApi;
  log?: (line: string) => void;
}

// Probes each enabled runtime on a fixed interval.
export class Reachability {
  readonly #opts: ReachabilityOptions;
  readonly #timers: TimerApi;
  readonly #ok = new Set<Agent>();
  readonly #reasons = new Map<Agent, string>();
  #timer: unknown;
  #stopped = false;

  constructor(opts: ReachabilityOptions) {
    this.#opts = opts;
    this.#timers = opts.timers ?? realTimers;
  }

  reachable(): ReadonlySet<Agent> {
    return this.#ok;
  }

  start(): void {
    void this.#loop();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async probe(): Promise<void> {
    const active = this.#opts.roster.active().map((entry) => entry.id);
    // A retired agent leaves the set.
    for (const id of [...this.#ok]) if (!active.includes(id)) this.#ok.delete(id);
    await Promise.all(active.map((agent) => this.#probeOne(agent)));
  }

  async #loop(): Promise<void> {
    await this.probe();
    if (this.#stopped) return;
    this.#timer = this.#timers.setTimeout(() => void this.#loop(), this.#opts.intervalMs);
  }

  async #probeOne(agent: Agent): Promise<void> {
    if (!this.#opts.roster.enabled(agent)) {
      this.#ok.delete(agent);
      return;
    }
    let result: { ok: boolean; reason?: string };
    try {
      const adapter = this.#opts.adapters.get(agent);
      const missing = this.#opts.roster.runtimeReason(agent);
      result = adapter
        ? await adapter.available()
        : { ok: false, reason: missing ?? "no runtime" };
    } catch (err) {
      result = { ok: false, reason: (err as Error).message };
    }
    if (result.ok) {
      this.#ok.add(agent);
      this.#reasons.delete(agent);
      return;
    }
    this.#ok.delete(agent);
    const reason = result.reason ?? "probe failed";
    // Log a reason once, not every interval.
    if (this.#reasons.get(agent) !== reason) this.#opts.log?.(`${agent} unreachable: ${reason}`);
    this.#reasons.set(agent, reason);
  }
}
