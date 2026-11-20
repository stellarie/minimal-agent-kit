import { existsSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Caller, Agent } from "../config.ts";
import type { Roster } from "../roster/roster.ts";
import { mentions } from "../scheduler/scheduler.ts";
import type { NearThread } from "../adapters/types.ts";
import type { TurnOutcome, WorkTurnInput } from "../sessions/sessions.ts";
import { isThread, LoungeError, type Channel, type Message, type Room } from "./room.ts";

export interface ThreadInfo extends Channel {
  parent: string;
  lead: Agent;
  cwd: string;
  createdBy: Caller;
  createdAt: string;
  // Set by the latest gate of the thread.
  phase?: string;
}

// What one agent works on now.
export interface WorkState {
  agent: Agent;
  roomId: string;
  since: string;
  // Its latest tool call.
  tool?: string;
}

export interface WorkEvent {
  agent: Agent;
  roomId: string;
  active: boolean;
  tool?: string;
}

export interface ThreadDraft {
  channel?: unknown;
  title?: unknown;
  brief?: unknown;
  lead?: unknown;
  cwd?: unknown;
}

export interface ThreadsOptions {
  db: DatabaseSync;
  room: Room;
  home: string;
  roster: Roster;
  turns: { workTurn(input: WorkTurnInput, signal?: AbortSignal): Promise<TurnOutcome> };
  now?: () => Date;
  log?: (line: string) => void;
  // False: the turn does not start. With no `from`, only a check.
  gate?: (roomId: string, from?: Caller | "self") => boolean;
  // A turn ended without a stop.
  onTurnEnd?: (roomId: string, agent: Agent, end: TurnEnd) => void;
}

export interface TurnEnd {
  reply?: Message;
  failed?: string;
}

// Set only by a child spawn, never from a request body.
export interface ThreadLink {
  parentId: string;
}

interface Run {
  controller: AbortController;
  state: WorkState;
  // A message came during the turn.
  again: boolean;
}

const TAIL = "The thread messages follow, oldest first.";
const NEAR_MAX = 8;
const SIMILAR_DAYS = 3;
const OPEN_DAYS = 7;
const SIMILAR_MIN = 0.6;

function words(title: string): Set<string> {
  return new Set(title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));
}

// Shared words over all words.
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both += 1;
  return both / (a.size + b.size - both);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Work threads: agents work together under a channel.
export class Threads {
  readonly #opts: ThreadsOptions;
  readonly #now: () => Date;
  #runs = new Map<string, Run>();
  #listeners = new Set<(e: WorkEvent) => void>();
  #unsubscribe: (() => void) | undefined;
  #offRemove: (() => void) | undefined;
  // create() posts the brief and starts turns itself.
  #quiet = false;
  #stopped = false;

  constructor(opts: ThreadsOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? (() => new Date());
  }

  start(): void {
    this.#unsubscribe = this.#opts.room.onMessage((m) => this.#onMessage(m));
    this.#offRemove = this.#opts.room.onRemove((ids) => this.#onRemove(ids));
  }

  stop(): void {
    this.#stopped = true;
    this.#unsubscribe?.();
    this.#offRemove?.();
    for (const run of this.#runs.values()) run.controller.abort(new Error("shutdown"));
  }

  info(roomId: string): ThreadInfo | undefined {
    const channel = this.#opts.room.channel(roomId);
    if (!channel?.parent) return undefined;
    const row = this.#opts.db.prepare("SELECT * FROM threads WHERE room_id = ?").get(roomId);
    if (!row) return undefined;
    return {
      ...channel,
      parent: channel.parent,
      lead: String(row.lead) as Agent,
      cwd: String(row.cwd),
      createdBy: String(row.created_by) as Caller,
      createdAt: String(row.created_at),
      ...(row.phase ? { phase: String(row.phase) } : {}),
    };
  }

  list(): ThreadInfo[] {
    const rows = this.#opts.db.prepare("SELECT room_id FROM threads ORDER BY created_at, room_id").all();
    return rows.flatMap((r) => this.info(String(r.room_id)) ?? []);
  }

  // Threads of the same channel, newest activity first.
  near(roomId: string): NearThread[] {
    const channel = this.#opts.room.channel(roomId);
    if (!channel) return [];
    return this.#under(channel.parent ?? channel.id, roomId);
  }

  // No closed state; recent activity counts as open.
  open(channel: unknown): NearThread[] {
    const since = this.#now().getTime() - OPEN_DAYS * 86_400_000;
    return this.#under(this.resolveChannel(channel)).filter((t) => Date.parse(t.last) >= since);
  }

  #under(parent: string, except = ""): NearThread[] {
    const rows = this.#opts.db
      .prepare(
        "SELECT r.id, r.name, t.lead, COALESCE((SELECT MAX(created_at) FROM messages m WHERE m.room_id = r.id), t.created_at) AS last " +
          "FROM rooms r JOIN threads t ON t.room_id = r.id WHERE r.parent = ? AND r.id != ? ORDER BY last DESC LIMIT ?",
      )
      .all(parent, except, NEAR_MAX);
    return rows.map((r) => ({ id: String(r.id), title: String(r.name), lead: String(r.lead), last: String(r.last) }));
  }

  // A channel id, a thread id (its channel), or a channel name.
  resolveChannel(input: unknown): string {
    const raw = typeof input === "string" ? input : "";
    const { room } = this.#opts;
    const exact = room.channel(raw);
    if (exact) return exact.parent ?? exact.id;
    const top = room.channels().filter((c) => c.parent === undefined);
    const want = raw.trim().replace(/^#/, "").toLowerCase();
    const named = want ? top.filter((c) => c.name.toLowerCase() === want || c.id.toLowerCase() === want) : [];
    if (named.length === 1) return named[0]!.id;
    const ids = top.map((c) => c.id).join(", ");
    throw new LoungeError("bad_thread", `unknown channel: ${raw}. Valid channels: ${ids}`);
  }

  // A recent thread of the channel with a like title.
  similar(channel: unknown, title: unknown): NearThread | undefined {
    if (typeof channel !== "string" || typeof title !== "string") return undefined;
    const want = words(title);
    const since = this.#now().getTime() - SIMILAR_DAYS * 86_400_000;
    let best: { thread: NearThread; score: number } | undefined;
    for (const thread of this.near(channel)) {
      if (Date.parse(thread.last) < since) continue;
      const score = overlap(want, words(thread.title));
      if (score >= SIMILAR_MIN && (!best || score > best.score)) best = { thread, score };
    }
    return best?.thread;
  }

  // Runs in deleted rooms stop with no event line.
  #onRemove(ids: string[]): void {
    const gone = new Set(ids);
    for (const run of this.#runs.values()) {
      if (!gone.has(run.state.roomId)) continue;
      run.again = false;
      run.controller.abort(new Error("room deleted"));
    }
  }

  work(): WorkState[] {
    return [...this.#runs.values()].map((run) => ({ ...run.state }));
  }

  onWork(listener: (e: WorkEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // The thread starts at once with the lead's turn.
  create(by: Caller, draft: ThreadDraft, link?: ThreadLink): ThreadInfo {
    if (this.#stopped) throw new LoungeError("unsupported", "the core is shutting down");
    const brief = typeof draft.brief === "string" ? draft.brief.trim() : "";
    if (!brief) throw new LoungeError("bad_thread", "a thread needs a brief");
    const lead = this.#lead(by, draft.lead);
    const channel = this.resolveChannel(draft.channel);
    const { room, db } = this.#opts;
    const explicit = this.#cwd(draft.cwd);
    db.exec("BEGIN");
    let thread: Channel;
    try {
      thread = room.createThread(channel, draft.title, by);
      const cwd = explicit ?? join(this.#opts.home, "work", thread.id);
      db.prepare(
        "INSERT INTO threads (room_id, lead, cwd, created_by, created_at, parent_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(thread.id, lead, cwd, by, this.#now().toISOString(), link?.parentId ?? null);
      this.#quiet = true;
      try {
        room.post(by, thread.id, brief);
      } finally {
        this.#quiet = false;
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    const info = this.info(thread.id)!;
    mkdirSync(info.cwd, { recursive: true });
    if (by !== lead) this.#handOff(by, thread.id, [lead]);
    this.#trigger(info, lead, by === lead ? "self" : by);
    for (const name of mentions(brief, this.#ids())) {
      if (name !== lead && name !== by) this.#trigger(info, name, by);
    }
    return info;
  }

  // The owner stops every turn in the thread.
  halt(by: Caller, roomId: string): number {
    if (!this.info(roomId)) throw new LoungeError("unknown_room", `unknown thread: ${roomId}`);
    let count = 0;
    for (const run of this.#runs.values()) {
      if (run.state.roomId !== roomId) continue;
      run.again = false;
      run.controller.abort(new Error("stopped"));
      count += 1;
    }
    if (count > 0) this.#opts.room.post(by, roomId, "stopped the work", "event");
    return count;
  }

  // Posts with no mention wake-up, then wakes one agent.
  deliver(author: Agent, roomId: string, text: string, to: Agent): void {
    const info = this.info(roomId);
    if (!info || this.#stopped) return;
    this.#quiet = true;
    try {
      this.#opts.room.post(author, roomId, text);
    } finally {
      this.#quiet = false;
    }
    this.#trigger(info, to, author);
  }

  #ids(): Agent[] {
    return this.#opts.roster.active().map((entry) => entry.id);
  }

  #lead(by: Caller, raw: unknown): Agent {
    const name = raw === undefined || raw === "" ? by : raw;
    if (typeof name !== "string" || !this.#opts.roster.has(name)) {
      throw new LoungeError("bad_thread", "the lead must be an active agent");
    }
    if (!this.#opts.roster.enabled(name)) throw new LoungeError("forbidden", `${name} is disabled`);
    return name;
  }

  #cwd(raw: unknown): string | undefined {
    if (raw === undefined || raw === "") return undefined;
    if (typeof raw !== "string" || !isAbsolute(raw)) {
      throw new LoungeError("bad_thread", "cwd must be an absolute folder path");
    }
    const full = resolve(raw);
    if (!existsSync(full) || !statSync(full).isDirectory()) {
      throw new LoungeError("bad_thread", `no such folder: ${full}`);
    }
    return full;
  }

  #onMessage(m: Message): void {
    if (this.#quiet || this.#stopped || !isThread(m.roomId) || m.kind !== undefined) return;
    const info = this.info(m.roomId);
    if (!info) return;
    const named = mentions(m.text, this.#ids()).filter(
      (name) => name !== m.author && this.#opts.roster.ready(name),
    );
    if (m.author === "owner") {
      for (const name of named.length > 0 ? named : [info.lead]) this.#trigger(info, name, "owner");
      return;
    }
    if (named.length === 0) return;
    this.#handOff(m.author, m.roomId, named);
    for (const name of named) this.#trigger(info, name, m.author);
  }

  // Shows who delegates to whom.
  #handOff(from: Caller, roomId: string, to: Agent[]): void {
    this.#opts.room.post(from, roomId, `handed work to ${to.join(", ")}`, "event");
  }

  #trigger(info: ThreadInfo, agent: Agent, from: Caller | "self"): void {
    if (!this.#opts.roster.ready(agent)) {
      this.#opts.log?.(`threads: ${agent} is disabled or has no runtime; ${info.id} skips it`);
      return;
    }
    if (this.#opts.gate && !this.#opts.gate(info.id, from)) return;
    const key = `${info.id}|${agent}`;
    const running = this.#runs.get(key);
    if (running) {
      running.again = true;
      return;
    }
    void this.#run(info, agent, from, key);
  }

  async #run(info: ThreadInfo, agent: Agent, from: Caller | "self", key: string): Promise<void> {
    const run: Run = {
      controller: new AbortController(),
      state: { agent, roomId: info.id, since: this.#now().toISOString() },
      again: false,
    };
    this.#runs.set(key, run);
    this.#emit({ agent, roomId: info.id, active: true });
    let brief = this.#brief(info, agent, from);
    let end: TurnEnd | undefined;
    try {
      for (;;) {
        try {
          const outcome = await this.#opts.turns.workTurn(
            {
              agent,
              roomId: info.id,
              cwd: info.cwd,
              brief,
              lead: from === "owner" && agent === info.lead,
              onActivity: (line) => {
                if (run.controller.signal.aborted) return;
                run.state.tool = line;
                this.#opts.room.post(agent, info.id, line, "tool");
                this.#emit({ agent, roomId: info.id, active: true, tool: line });
              },
            },
            run.controller.signal,
          );
          end = { reply: outcome.message };
        } catch (err) {
          if (run.controller.signal.aborted || this.#stopped) {
            end = undefined;
            return;
          }
          const reason = errorText(err).slice(0, 300);
          this.#opts.log?.(`threads: ${agent} turn in ${info.id} failed: ${reason}`);
          this.#opts.room.post(agent, info.id, `could not finish: ${reason}`, "event");
          end = { failed: reason };
          return;
        }
        if (run.controller.signal.aborted || this.#stopped) {
          end = undefined;
          return;
        }
        if (!run.again || (this.#opts.gate && !this.#opts.gate(info.id))) return;
        run.again = false;
        brief = `New messages came while you worked in thread "${info.name}". Continue if they need you. Otherwise reply \`[pass]\`. ${TAIL}`;
      }
    } finally {
      this.#runs.delete(key);
      this.#emit({ agent, roomId: info.id, active: false });
      if (end) this.#opts.onTurnEnd?.(info.id, agent, end);
    }
  }

  #brief(info: ThreadInfo, agent: Agent, from: Caller | "self"): string {
    const where = `work thread "${info.name}" under #${info.parent}`;
    if (from === "self") return `You started the ${where}. Do the work in the brief. ${TAIL}`;
    if (from === "owner" && agent === info.lead) {
      return `You lead the ${where}. The owner wrote. Do the work the owner asks for. ${TAIL}`;
    }
    if (from === "owner") return `The owner asked you to help in the ${where}. ${TAIL}`;
    return `${from} handed you work in the ${where}. Do your part, then report. ${TAIL}`;
  }

  #emit(event: WorkEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error("work listener failed:", err);
      }
    }
  }
}
