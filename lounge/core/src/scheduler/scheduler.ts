import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_ROOM, type Caller, type Agent, type LoungeConfig } from "../config.ts";
import { readSetting, writeSetting } from "../db/settings.ts";
import { isThread, SESSION_ROOM_PREFIX, type Message, type Room } from "../lounge/room.ts";
import type { Roster } from "../roster/roster.ts";
import type { TurnOutcome } from "../sessions/sessions.ts";
import { realTimers, type TimerApi } from "../sessions/slots.ts";

export type TurnKind = "lead" | "follow" | "idle" | "ping";

export interface SchedulerStatus {
  enabled: boolean;
  // The first of `active`, or null.
  running: Agent | null;
  active: Agent[];
  queued: Agent[];
  // The agent-only budget is spent.
  paused: boolean;
}

export interface SchedulerOptions {
  db: DatabaseSync;
  room: Room;
  turns: {
    roomTurn(agent: Agent, roomId: string, brief: string, signal?: AbortSignal, lead?: boolean): Promise<TurnOutcome>;
    busy(): ReadonlySet<Agent>;
  };
  config: LoungeConfig;
  roster: Roster;
  // Probe results; unset means do not filter.
  reachable?: () => ReadonlySet<Agent>;
  now?: () => Date;
  timers?: TimerApi;
  random?: () => number;
  log?: (line: string) => void;
}

interface Item {
  agent: Agent;
  roomId: string;
  kind: TurnKind;
  // Bumped by each message from the owner.
  epoch: number;
  mentioned?: boolean;
  // What a ping is about.
  note?: string;
}

const SETTING = "scheduler.enabled";
const HOUR_MS = 3_600_000;
const TIMEOUT_BACKOFF_MS = 10 * 60_000;
const FAIL_BACKOFF_MS = 30 * 60_000;
const QUEUE_TIMEOUT = "queue timeout";

const TAIL = "The messages of the channel follow, oldest first.";

function brief(item: Item): string {
  const where = `channel #${item.roomId}`;
  if (item.kind === "lead" && item.mentioned) return `The owner mentioned you in ${where}. Reply to the owner. ${TAIL}`;
  if (item.kind === "lead") return `The owner wrote in ${where}. Reply to the owner. ${TAIL}`;
  if (item.kind === "ping") {
    return `A scheduled event starts now in ${where}: ${item.note ?? ""}. Everyone is pinged. Say something about it, or reply \`[pass]\`. ${TAIL}`;
  }
  if (item.kind === "follow") {
    return `A new message is in ${where}. Post only if you have something to add. Otherwise reply \`[pass]\`. ${TAIL}`;
  }
  return `The lounge has been quiet for a while. Start a short conversation in ${where} if you like, or reply \`[pass]\`. ${TAIL}`;
}

// Longest id first: it wins over its prefix.
function mentionPattern(ids: readonly Agent[]): RegExp | undefined {
  if (ids.length === 0) return undefined;
  const sorted = [...ids].sort((a, b) => b.length - a.length);
  return new RegExp(`@(${sorted.join("|")})(?![a-z0-9_-])`, "gi");
}

// Ids hold only a-z, 0-9, and hyphen: safe here.
export function mentions(text: string, ids: readonly Agent[]): Agent[] {
  const pattern = mentionPattern(ids);
  const out: Agent[] = [];
  if (pattern === undefined) return out;
  for (const match of text.matchAll(pattern)) {
    const name = match[1]!.toLowerCase();
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Wakes agents in the lounge channels.
// Up to maxConcurrent turns run at once, one per agent.
export class Scheduler {
  readonly #opts: SchedulerOptions;
  readonly #timers: TimerApi;
  readonly #now: () => Date;
  readonly #random: () => number;
  #enabled: boolean;
  #queue: Item[] = [];
  #running = new Map<Agent, Item>();
  #aborts = new Map<Agent, AbortController>();
  // Last post time per "room|agent".
  #lastPost = new Map<string, number>();
  #slowTimer: unknown;
  #slowDue = 0;
  #offRemove: (() => void) | undefined;
  #epoch = 0;
  #started = false;
  #lastSpeaker = new Map<string, Caller>();
  // Channel of the owner's last message.
  #leadRoom: string = DEFAULT_ROOM;
  #agentOnly = 0;
  #turnTimes: number[] = [];
  #perDay = new Map<string, number>();
  #backoff = new Map<Agent, number>();
  #mentioned = new Set<Agent>();
  // Leads tried since the owner's last message.
  #tried = new Set<Agent>();
  #answered = true;
  #replyTimer: unknown;
  #idleTimer: unknown;
  #unsubscribe: (() => void) | undefined;
  #stopped = false;

  constructor(opts: SchedulerOptions) {
    this.#opts = opts;
    this.#timers = opts.timers ?? realTimers;
    this.#now = opts.now ?? (() => new Date());
    this.#random = opts.random ?? Math.random;
    const saved = readSetting(opts.db, SETTING);
    this.#enabled = saved === undefined ? opts.config.scheduler.enabled : saved === "true";
    const last = opts.room.read(DEFAULT_ROOM, { limit: 1 }).at(-1);
    if (last) this.#lastSpeaker.set(DEFAULT_ROOM, last.author);
  }

  start(): void {
    this.#started = true;
    this.#unsubscribe = this.#opts.room.onMessage((m) => this.#onMessage(m));
    this.#offRemove = this.#opts.room.onRemove((ids) => this.#onRemove(ids));
    this.#scheduleIdle();
  }

  stop(): void {
    this.#stopped = true;
    this.#unsubscribe?.();
    this.#offRemove?.();
    this.#clearTimers();
    this.#queue = [];
  }

  // Deleted rooms take their turns with them.
  #onRemove(ids: string[]): void {
    const gone = new Set(ids);
    this.#queue = this.#queue.filter((item) => !gone.has(item.roomId));
    for (const [agent, item] of this.#running) {
      if (gone.has(item.roomId)) this.#aborts.get(agent)?.abort(new Error("room deleted"));
    }
    for (const id of ids) this.#lastSpeaker.delete(id);
    for (const key of [...this.#lastPost.keys()]) {
      if (gone.has(key.slice(0, key.lastIndexOf("|")))) this.#lastPost.delete(key);
    }
    if (gone.has(this.#leadRoom)) this.#leadRoom = DEFAULT_ROOM;
  }

  status(): SchedulerStatus {
    return {
      enabled: this.#enabled,
      running: this.#running.keys().next().value ?? null,
      active: [...this.#running.keys()],
      queued: this.#queue.map((item) => item.agent),
      paused: this.#agentOnly >= this.#opts.config.scheduler.agentOnlyBeforePause,
    };
  }

  setEnabled(enabled: boolean): SchedulerStatus {
    this.#enabled = enabled;
    writeSetting(this.#opts.db, SETTING, String(enabled));
    if (enabled) {
      this.#scheduleIdle();
    } else {
      this.#clearTimers();
      this.#queue = [];
      this.#mentioned.clear();
    }
    return this.status();
  }

  // A scheduled event pings every agent.
  announce(roomId: string, note: string): void {
    if (!this.#enabled || this.#stopped) return;
    for (const agent of this.#shuffle(this.#ids())) {
      if (this.#queue.some((item) => item.agent === agent && item.kind === "ping")) continue;
      if (this.#candidate(agent, true, roomId)) {
        // The ping replaces its queued follow-up.
        this.#queue = this.#queue.filter((item) => item.agent !== agent || item.kind === "lead");
        this.#queue.push({ agent, roomId, kind: "ping", epoch: this.#epoch, note });
      }
    }
    this.#pump();
  }

  #clearTimers(): void {
    if (this.#replyTimer !== undefined) this.#timers.clearTimeout(this.#replyTimer);
    if (this.#idleTimer !== undefined) this.#timers.clearTimeout(this.#idleTimer);
    if (this.#slowTimer !== undefined) this.#timers.clearTimeout(this.#slowTimer);
    this.#replyTimer = undefined;
    this.#idleTimer = undefined;
    this.#slowTimer = undefined;
  }

  #onMessage(m: Message): void {
    // Threads run their own turns.
    if (m.roomId.startsWith(SESSION_ROOM_PREFIX) || isThread(m.roomId) || this.#stopped) return;
    // Agent chatter must not keep pushing the idle wake back.
    if (m.author === "owner") this.#scheduleIdle();
    // Events reach the next turn as context only.
    if (m.kind === "event") return;
    this.#lastSpeaker.set(m.roomId, m.author);
    if (m.author === "owner") {
      this.#agentOnly = 0;
      this.#epoch += 1;
      this.#leadRoom = m.roomId;
      this.#answered = false;
      this.#tried.clear();
      // Newer words replace older follow-ups.
      this.#queue = [];
      if (this.#enabled) for (const name of mentions(m.text, this.#ids())) this.#mentioned.add(name);
      this.#scheduleReply();
      return;
    }
    this.#agentOnly += 1;
    this.#lastPost.set(`${m.roomId}|${m.author}`, this.#now().getTime());
    // A reply to an older message is no answer.
    const mine = this.#running.get(m.author);
    const stale = mine !== undefined && mine.epoch !== this.#epoch;
    if (!stale && m.roomId === this.#leadRoom) this.#answered = true;
    if (!this.#enabled) return;
    const others = this.#ids().filter(
      (agent) => agent !== m.author && !this.#queue.some((item) => item.agent === agent),
    );
    for (const agent of this.#shuffle(others)) {
      if (this.#candidate(agent, false, m.roomId)) {
        this.#queue.push({ agent, roomId: m.roomId, kind: "follow", epoch: this.#epoch });
      }
    }
    this.#pump();
  }

  #scheduleReply(): void {
    if (!this.#enabled) return;
    if (this.#replyTimer !== undefined) this.#timers.clearTimeout(this.#replyTimer);
    this.#replyTimer = this.#timers.setTimeout(() => {
      this.#replyTimer = undefined;
      this.#queueLeads();
      this.#pump();
    }, this.#opts.config.scheduler.replyDelayMs);
  }

  #queueLeads(): void {
    const roomId = this.#leadRoom;
    const named = [...this.#mentioned].filter((agent) => this.#candidate(agent, true, roomId));
    this.#mentioned.clear();
    if (named.length > 0) {
      for (const agent of named) {
        this.#tried.add(agent);
        this.#queue.push({ agent, roomId, kind: "lead", epoch: this.#epoch, mentioned: true });
      }
      return;
    }
    this.#queueNextLead();
  }

  // At least one agent answers the owner.
  #queueNextLead(): void {
    if (!this.#enabled || this.#stopped) return;
    const roomId = this.#leadRoom;
    const pool = this.#ids().filter((agent) => !this.#tried.has(agent) && this.#candidate(agent, true, roomId));
    const pick = this.#pick(pool);
    if (pick === undefined) return;
    this.#tried.add(pick);
    this.#queue.push({ agent: pick, roomId, kind: "lead", epoch: this.#epoch });
  }

  #scheduleIdle(): void {
    if (!this.#enabled || this.#stopped || !this.#started) return;
    if (this.#idleTimer !== undefined) this.#timers.clearTimeout(this.#idleTimer);
    const { idleMs, jitterMs } = this.#opts.config.scheduler;
    const wait = idleMs + Math.floor(this.#random() * jitterMs);
    this.#idleTimer = this.#timers.setTimeout(() => {
      this.#idleTimer = undefined;
      this.#onIdle();
    }, wait);
  }

  #onIdle(): void {
    if (!this.#enabled || this.#stopped) return;
    // The next wake counts from this wake.
    this.#scheduleIdle();
    if (this.#running.size > 0 || this.#queue.length > 0) {
      console.log("idle wake skipped: busy");
      return;
    }
    // Idle wakes stay in the lounge.
    const pick = this.#pick(this.#ids().filter((agent) => this.#candidate(agent, false, DEFAULT_ROOM)));
    if (pick === undefined) {
      console.log("idle wake skipped: no candidate");
      return;
    }
    this.#queue.push({ agent: pick, roomId: DEFAULT_ROOM, kind: "idle", epoch: this.#epoch });
    this.#pump();
  }

  #ids(): Agent[] {
    return this.#opts.roster.active().map((entry) => entry.id);
  }

  #candidate(agent: Agent, allowLast: boolean, roomId: string): boolean {
    // A missing runtime fails every turn: skip it.
    if (!this.#opts.roster.ready(agent)) return false;
    if ((this.#backoff.get(agent) ?? 0) > this.#now().getTime()) return false;
    if (this.#opts.turns.busy().has(agent)) return false;
    if (this.#opts.reachable && !this.#opts.reachable().has(agent)) return false;
    return allowLast || this.#lastSpeaker.get(roomId) !== agent;
  }

  #withinBudget(item: Item): boolean {
    const budget = this.#opts.config.scheduler;
    const now = this.#now();
    this.#turnTimes = this.#turnTimes.filter((t) => t > now.getTime() - HOUR_MS);
    if (this.#turnTimes.length >= budget.turnsPerHour) return false;
    if ((this.#perDay.get(`${item.agent}:${dayKey(now)}`) ?? 0) >= budget.turnsPerAgentPerDay) return false;
    // An idle wake exists for when the owner is away, so the pause must not stop it.
    return item.kind !== "follow" || this.#agentOnly < budget.agentOnlyBeforePause;
  }

  #count(agent: Agent): void {
    const now = this.#now();
    this.#turnTimes.push(now.getTime());
    const key = `${agent}:${dayKey(now)}`;
    this.#perDay.set(key, (this.#perDay.get(key) ?? 0) + 1);
  }

  #pump(): void {
    if (!this.#enabled || this.#stopped) return;
    const limit = Math.max(1, this.#opts.config.scheduler.maxConcurrent);
    // Items of a running agent wait for its turn to end.
    const waiting: Item[] = [];
    let item: Item | undefined;
    while (this.#running.size < limit && (item = this.#queue.shift()) !== undefined) {
      if (this.#running.has(item.agent) || this.#held(item)) {
        waiting.push(item);
        continue;
      }
      const allowLast = item.kind === "lead" || item.kind === "ping";
      if (this.#candidate(item.agent, allowLast, item.roomId) && this.#withinBudget(item)) {
        void this.#run(item);
        continue;
      }
      // A dropped lead hands over to the next one.
      if (this.#needsLead(item)) this.#queueNextLead();
    }
    this.#queue.unshift(...waiting);
  }

  // Sequential: one turn at a time in the channel.
  // Slow mode: a cooldown per agent after its post.
  // A lead skips it: the owner gets an answer.
  #held(item: Item): boolean {
    const channel = this.#opts.room.channel(item.roomId);
    if (!channel) return false;
    if (channel.mode === "sequential" && [...this.#running.values()].some((r) => r.roomId === item.roomId)) return true;
    if (item.kind === "lead" || !channel.slowSec) return false;
    const due = (this.#lastPost.get(`${item.roomId}|${item.agent}`) ?? 0) + channel.slowSec * 1000;
    if (this.#now().getTime() >= due) return false;
    this.#armSlow(due);
    return true;
  }

  #armSlow(due: number): void {
    if (this.#slowTimer !== undefined && this.#slowDue <= due) return;
    if (this.#slowTimer !== undefined) this.#timers.clearTimeout(this.#slowTimer);
    this.#slowDue = due;
    this.#slowTimer = this.#timers.setTimeout(() => {
      this.#slowTimer = undefined;
      this.#pump();
    }, Math.max(0, due - this.#now().getTime()));
  }

  async #run(item: Item): Promise<void> {
    const { agent } = item;
    const abort = new AbortController();
    this.#running.set(agent, item);
    this.#aborts.set(agent, abort);
    this.#count(agent);
    let posted = false;
    try {
      const outcome = await this.#opts.turns.roomTurn(agent, item.roomId, brief(item), abort.signal, item.kind === "lead");
      posted = outcome.message !== undefined;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (this.#stopped || abort.signal.aborted) {
        // Shutdown or a room delete aborted the turn.
      } else if (reason === QUEUE_TIMEOUT) {
        // Full slots are not the agent's fault.
        this.#opts.log?.(`scheduler: ${agent} turn waited too long for a slot`);
      } else {
        const ms = /\btimed out\b|^timeout$/i.test(reason) ? TIMEOUT_BACKOFF_MS : FAIL_BACKOFF_MS;
        this.#backoff.set(agent, this.#now().getTime() + ms);
        this.#opts.log?.(`scheduler: ${agent} turn failed, backoff ${ms / 60_000} min: ${reason}`);
      }
    } finally {
      this.#running.delete(agent);
      this.#aborts.delete(agent);
    }
    if (!posted && this.#needsLead(item)) this.#queueNextLead();
    this.#pump();
  }

  #needsLead(item: Item): boolean {
    return item.kind === "lead" && item.epoch === this.#epoch && !this.#answered;
  }

  #pick(pool: Agent[]): Agent | undefined {
    if (pool.length === 0) return undefined;
    return pool[Math.min(pool.length - 1, Math.floor(this.#random() * pool.length))];
  }

  #shuffle(list: Agent[]): Agent[] {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.#random() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}
