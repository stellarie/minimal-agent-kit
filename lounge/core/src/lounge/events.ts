import type { DatabaseSync } from "node:sqlite";
import type { Caller } from "../config.ts";
import { realTimers, type TimerApi } from "../sessions/slots.ts";
import { LoungeError, type Room } from "./room.ts";

export const MAX_TITLE = 100;
export const MAX_CONTEXT = 2000;
export const MAX_PENDING = 100;
const MAX_AHEAD_MS = 366 * 86_400_000;
// setTimeout overflows past about 24.8 days.
const MAX_WAIT_MS = 86_400_000;

export const REPEATS = ["none", "daily", "weekdays", "weekly", "monthly"] as const;
export type Repeat = (typeof REPEATS)[number];

// The next time after `after`, in local time.
export function nextTime(at: Date, repeat: Repeat, after: Date): Date | undefined {
  if (repeat === "none") return undefined;
  const next = new Date(at.getTime());
  // Local setters keep the wall clock across DST.
  const step = (): void => {
    if (repeat === "daily") next.setDate(next.getDate() + 1);
    else if (repeat === "weekly") next.setDate(next.getDate() + 7);
    else if (repeat === "monthly") next.setMonth(next.getMonth() + 1);
    else {
      do next.setDate(next.getDate() + 1);
      while (next.getDay() === 0 || next.getDay() === 6);
    }
  };
  do step();
  while (next.getTime() <= after.getTime());
  return next;
}

export interface LoungeEvent {
  id: number;
  roomId: string;
  title: string;
  context: string;
  at: string;
  createdBy: Caller;
  createdAt: string;
  state: "pending" | "fired" | "cancelled";
  repeat: Repeat;
}

export interface EventInput {
  room?: unknown;
  title?: unknown;
  context?: unknown;
  at?: unknown;
  repeat?: unknown;
}

interface EventRow {
  id: number;
  room_id: string;
  title: string;
  context: string;
  at: string;
  created_by: string;
  created_at: string;
  state: string;
  repeat: string;
}

function toEvent(row: EventRow): LoungeEvent {
  return {
    id: Number(row.id),
    roomId: row.room_id,
    title: row.title,
    context: row.context,
    at: row.at,
    createdBy: row.created_by as Caller,
    createdAt: row.created_at,
    state: row.state as LoungeEvent["state"],
    repeat: (REPEATS as readonly string[]).includes(row.repeat) ? (row.repeat as Repeat) : "none",
  };
}

// The text everyone sees when the event starts.
export function eventText(e: Pick<LoungeEvent, "title" | "context">): string {
  return e.context ? `${e.title}: ${e.context}` : e.title;
}

export interface EventsOptions {
  db: DatabaseSync;
  room: Room;
  now?: () => Date;
  timers?: TimerApi;
}

// Scheduled events: post a line and ping everyone when due.
export class Events {
  readonly #db: DatabaseSync;
  readonly #room: Room;
  readonly #now: () => Date;
  readonly #timers: TimerApi;
  #timer: unknown;
  #offRemove: (() => void) | undefined;
  #started = false;
  #listeners = new Set<(e: LoungeEvent) => void>();
  #fireListeners = new Set<(e: LoungeEvent) => void>();

  constructor(opts: EventsOptions) {
    this.#db = opts.db;
    this.#room = opts.room;
    this.#now = opts.now ?? (() => new Date());
    this.#timers = opts.timers ?? realTimers;
  }

  start(): void {
    this.#started = true;
    // Deleted rooms take their events.
    this.#offRemove = this.#room.onRemove(() => this.#arm());
    this.#arm();
  }

  stop(): void {
    this.#started = false;
    this.#offRemove?.();
    this.#offRemove = undefined;
    if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  list(opts: { pending?: boolean } = {}): LoungeEvent[] {
    const sql = opts.pending
      ? "SELECT * FROM events WHERE state = 'pending' ORDER BY at, id"
      : "SELECT * FROM events ORDER BY at DESC, id DESC LIMIT 200";
    return (this.#db.prepare(sql).all() as unknown as EventRow[]).map(toEvent);
  }

  get(id: number): LoungeEvent | undefined {
    const row = this.#db.prepare("SELECT * FROM events WHERE id = ?").get(id);
    return row ? toEvent(row as unknown as EventRow) : undefined;
  }

  create(by: Caller, input: EventInput): LoungeEvent {
    const roomId = typeof input.room === "string" && input.room ? input.room : "lounge";
    if (!this.#room.channel(roomId)) throw new LoungeError("unknown_room", `unknown channel: ${roomId}`);
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title || title.length > MAX_TITLE || /[\r\n]/.test(title)) {
      throw new LoungeError("bad_event", `a title has 1 to ${MAX_TITLE} characters on one line`);
    }
    const context = typeof input.context === "string" ? input.context.trim() : "";
    if (context.length > MAX_CONTEXT) {
      throw new LoungeError("bad_event", `the context has at most ${MAX_CONTEXT} characters`);
    }
    const at = typeof input.at === "string" ? new Date(input.at) : new Date(NaN);
    const now = this.#now().getTime();
    if (Number.isNaN(at.getTime())) throw new LoungeError("bad_event", "at must be an ISO 8601 time");
    if (at.getTime() <= now) throw new LoungeError("bad_event", "at must be in the future");
    if (at.getTime() > now + MAX_AHEAD_MS) throw new LoungeError("bad_event", "at must be within one year");
    const repeat = input.repeat === undefined || input.repeat === null || input.repeat === "" ? "none" : input.repeat;
    if (!(REPEATS as readonly unknown[]).includes(repeat)) {
      throw new LoungeError("bad_event", `repeat must be one of ${REPEATS.join(", ")}`);
    }
    // Months differ in length: keep the day fixed.
    if (repeat === "monthly" && at.getDate() > 28) {
      throw new LoungeError("bad_event", "a monthly event needs a day from 1 to 28");
    }
    const pending = Number((this.#db.prepare("SELECT COUNT(*) AS n FROM events WHERE state = 'pending'").get() as { n: number }).n);
    if (pending >= MAX_PENDING) throw new LoungeError("bad_event", `at most ${MAX_PENDING} events can wait`);
    const createdAt = this.#now().toISOString();
    const result = this.#db
      .prepare(
        "INSERT INTO events (room_id, title, context, at, created_by, created_at, state, repeat) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
      )
      .run(roomId, title, context, at.toISOString(), by, createdAt, repeat as string);
    const event = this.get(Number(result.lastInsertRowid))!;
    const every = event.repeat === "none" ? "" : `, repeats ${event.repeat}`;
    this.#room.post(by, roomId, `scheduled an event for ${event.at}${every}: ${eventText(event)}`, "event");
    this.#emit(event);
    this.#arm();
    return event;
  }

  // The creator or the owner may cancel.
  cancel(by: Caller, id: number): LoungeEvent {
    const event = this.get(id);
    if (!event) throw new LoungeError("unknown_event", `unknown event: ${id}`);
    if (by !== "owner" && by !== event.createdBy) {
      throw new LoungeError("forbidden", "only the creator or the owner may cancel an event");
    }
    if (event.state !== "pending") throw new LoungeError("bad_event", `event ${id} is ${event.state}`);
    this.#db.prepare("UPDATE events SET state = 'cancelled' WHERE id = ?").run(id);
    const next = { ...event, state: "cancelled" as const };
    this.#room.post(by, event.roomId, `cancelled the event: ${event.title}`, "event");
    this.#emit(next);
    this.#arm();
    return next;
  }

  onChange(listener: (e: LoungeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onFire(listener: (e: LoungeEvent) => void): () => void {
    this.#fireListeners.add(listener);
    return () => this.#fireListeners.delete(listener);
  }

  #emit(event: LoungeEvent, extra?: Set<(e: LoungeEvent) => void>): void {
    for (const listener of [...this.#listeners, ...(extra ?? [])]) {
      try {
        listener(event);
      } catch (err) {
        console.error("event listener failed:", err);
      }
    }
  }

  // One timer for the next due event.
  #arm(): void {
    if (!this.#started) return;
    if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
    const next = this.list({ pending: true })[0];
    if (!next) return;
    const wait = Math.max(0, Math.min(MAX_WAIT_MS, new Date(next.at).getTime() - this.#now().getTime()));
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = undefined;
      this.#fireDue();
    }, wait);
  }

  // Events missed while the core was down fire late.
  #fireDue(): void {
    const now = this.#now().getTime();
    for (const event of this.list({ pending: true })) {
      if (new Date(event.at).getTime() > now) break;
      // A repeating event stays pending at its next time.
      const next = nextTime(new Date(event.at), event.repeat, new Date(now));
      if (next) {
        this.#db.prepare("UPDATE events SET at = ? WHERE id = ?").run(next.toISOString(), event.id);
      } else {
        this.#db.prepare("UPDATE events SET state = 'fired' WHERE id = ?").run(event.id);
      }
      try {
        this.#room.post(event.createdBy, event.roomId, `event starts now: ${eventText(event)}`, "event");
      } catch (err) {
        console.error("event post failed:", err);
      }
      for (const listener of this.#fireListeners) {
        try {
          listener({ ...event, state: "fired" });
        } catch (err) {
          console.error("event listener failed:", err);
        }
      }
      this.#emit(next ? { ...event, at: next.toISOString() } : { ...event, state: "fired" });
    }
    this.#arm();
  }
}
