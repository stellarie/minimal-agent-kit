import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Attachment } from "./attachments.ts";
import { DEFAULT_ROOM, SEED_AGENTS, type Caller } from "../config.ts";

export const MAX_TEXT = 8000;
// Posts stay short: channels, then agent threads.
export const MAX_CHANNEL_POST = 2000;
export const MAX_THREAD_POST = 1000;
export const DEFAULT_READ_LIMIT = 50;
export const MAX_READ_LIMIT = 200;
export const SESSION_ROOM_PREFIX = "session-";
export const THREAD_ROOM_PREFIX = "thread-";
export const MAX_THREAD_TITLE = 100;
// Lowercase words joined by hyphens, as in Discord.
const CHANNEL_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const MAX_TOPIC = 1024;
export const MAX_NICKNAME = 32;

export interface Channel {
  id: string;
  name: string;
  topic: string;
  // Set for a work thread: its channel.
  parent?: string;
  // Unset: the no-category group.
  category?: string;
  // Unset: concurrent turns.
  mode?: "sequential";
  // Seconds between agent turns. Unset: off.
  slowSec?: number;
}

export type TurnMode = "concurrent" | "sequential";
export const MAX_SLOW_SEC = 3600;

export interface ChannelSettings {
  mode?: unknown;
  slowSec?: unknown;
}

export interface Category {
  id: string;
  name: string;
}

export interface Layout {
  categories: Category[];
  channels: Channel[];
}

export const MAX_CHANNEL_NAME = 32;
export const MAX_CATEGORIES = 50;
const CATEGORY_PREFIX = "cat-";

export type MessageKind = "text" | "event" | "tool";

export interface Nickname {
  caller: Caller;
  // Empty when the caller uses its own name.
  name: string;
}

export interface Typing {
  roomId: string;
  caller: Caller;
  active: boolean;
}

export interface Message {
  id: number;
  roomId: string;
  author: Caller;
  text: string;
  createdAt: string;
  // "event": a channel change. "tool": work activity.
  kind?: "event" | "tool";
  attachments?: Attachment[];
  // The message this one answers, in the same room.
  replyTo?: number;
}

export type LoungeErrorCode =
  | "bad_text"
  | "bad_reply"
  | "unknown_room"
  | "unknown_plugin"
  | "forbidden"
  | "unsupported"
  | "unknown_session"
  | "session_closed"
  | "session_busy"
  | "bad_channel"
  | "channel_exists"
  | "bad_topic"
  | "bad_nickname"
  | "bad_event"
  | "unknown_event"
  | "bad_thread"
  | "bad_path"
  | "bad_attachment"
  | "unknown_attachment"
  | "bad_grants"
  | "bad_category"
  | "bad_layout"
  | "bad_agent"
  | "unknown_agent"
  | "unknown_category"
  | "bad_rules"
  | "conflict";

export class LoungeError extends Error {
  code: LoungeErrorCode;

  constructor(code: LoungeErrorCode, message: string) {
    super(message);
    this.name = "LoungeError";
    this.code = code;
  }
}

type Listener = (m: Message) => void;

// "Movie Night!" becomes "movie-night".
export function channelId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

interface MessageRow {
  id: number;
  room_id: string;
  author: string;
  text: string;
  created_at: string;
  kind: string;
  attachments: string | null;
  reply_to?: number | null;
}

function toMessage(row: MessageRow): Message {
  const message: Message = {
    id: Number(row.id),
    roomId: row.room_id,
    author: row.author as Caller,
    text: row.text,
    createdAt: row.created_at,
  };
  if (row.kind === "event" || row.kind === "tool") message.kind = row.kind;
  if (row.attachments) message.attachments = JSON.parse(row.attachments) as Attachment[];
  if (row.reply_to !== null && row.reply_to !== undefined) message.replyTo = Number(row.reply_to);
  return message;
}

function toChannel(row: Record<string, unknown>): Channel {
  const channel: Channel = { id: String(row.id), name: String(row.name), topic: String(row.topic) };
  if (row.parent !== null && row.parent !== undefined) channel.parent = String(row.parent);
  else if (row.category !== null && row.category !== undefined) channel.category = String(row.category);
  if (row.turn_mode === "sequential") channel.mode = "sequential";
  if (typeof row.slow_sec === "number" && row.slow_sec > 0) channel.slowSec = row.slow_sec;
  return channel;
}

// One line, 1 to 32 characters, no control codes.
function cleanName(name: unknown, code: "bad_channel" | "bad_category", what: string): string {
  const clean = typeof name === "string" ? name.trim() : "";
  if (!clean || clean.length > MAX_CHANNEL_NAME || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new LoungeError(code, `a ${what} name has 1 to ${MAX_CHANNEL_NAME} characters on one line`);
  }
  return clean;
}

const CHANNEL_COLUMNS = "id, name, topic, parent, category, turn_mode, slow_sec";

export function isThread(roomId: string): boolean {
  return roomId.startsWith(THREAD_ROOM_PREFIX);
}

// Session rooms keep the full limit.
export function postLimit(author: Caller, roomId: string): number {
  if (roomId.startsWith(SESSION_ROOM_PREFIX)) return MAX_TEXT;
  if (isThread(roomId) && author !== "owner") return MAX_THREAD_POST;
  return MAX_CHANNEL_POST;
}

export function tooLongText(length: number, limit: number): string {
  return `text has ${length} characters; a post here has at most ${limit}. Write it shorter and post again.`;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_READ_LIMIT;
  return Math.min(MAX_READ_LIMIT, Math.max(1, Math.floor(limit)));
}

// No control characters: a name sits in one line.
export function cleanNickname(name: unknown): string {
  const clean = typeof name === "string" ? name.trim() : undefined;
  if (clean === undefined || clean.length > MAX_NICKNAME || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new LoungeError("bad_nickname", `a name has at most ${MAX_NICKNAME} characters on one line`);
  }
  return clean;
}

export class Room {
  #db: DatabaseSync;
  #now: () => Date;
  #listeners = new Set<Listener>();
  #channelListeners = new Set<(c: Channel) => void>();
  #layoutListeners = new Set<(l: Layout) => void>();
  #removeListeners = new Set<(ids: string[]) => void>();
  #typingListeners = new Set<(t: Typing) => void>();
  #nicknameListeners = new Set<(n: Nickname) => void>();
  // Count per room and caller: turns can overlap.
  #typing = new Map<string, number>();

  // The callers of who(): the roster, then the owner.
  #callers: () => readonly Caller[];

  constructor(
    db: DatabaseSync,
    now: () => Date = () => new Date(),
    callers: () => readonly Caller[] = () => [...SEED_AGENTS, "owner"],
  ) {
    this.#db = db;
    this.#now = now;
    this.#callers = callers;
  }

  #requireRoom(roomId: string): void {
    const row = this.#db.prepare("SELECT 1 AS found FROM rooms WHERE id = ?").get(roomId);
    if (!row) throw new LoungeError("unknown_room", `unknown room: ${roomId}`);
  }

  // Another room's id would leak its text.
  #requireReplyTarget(roomId: string, replyTo: number): void {
    const row = Number.isSafeInteger(replyTo)
      ? this.#db.prepare("SELECT room_id, kind FROM messages WHERE id = ?").get(replyTo)
      : undefined;
    if (!row || row.room_id !== roomId || row.kind !== "text") {
      throw new LoungeError("bad_reply", `replyTo ${replyTo} is not a text message in ${roomId}`);
    }
  }

  // Text may be empty when files come with it.
  post(
    author: Caller,
    roomId: string,
    text: string,
    kind: MessageKind = "text",
    attachments: Attachment[] = [],
    replyTo?: number,
  ): Message {
    if (typeof text !== "string" || (text.trim().length === 0 && attachments.length === 0)) {
      throw new LoungeError("bad_text", "text is empty");
    }
    const limit = kind === "text" ? postLimit(author, roomId) : MAX_TEXT;
    if (text.length > limit) {
      throw new LoungeError("bad_text", tooLongText(text.length, limit));
    }
    this.#requireRoom(roomId);
    if (replyTo !== undefined) this.#requireReplyTarget(roomId, replyTo);
    const createdAt = this.#now().toISOString();
    const result = this.#db
      .prepare(
        "INSERT INTO messages (room_id, author, text, created_at, kind, attachments, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        roomId,
        author,
        text,
        createdAt,
        kind,
        attachments.length > 0 ? JSON.stringify(attachments) : null,
        replyTo ?? null,
      );
    const message: Message = {
      id: Number(result.lastInsertRowid),
      roomId,
      author,
      text,
      createdAt,
    };
    if (kind !== "text") message.kind = kind;
    if (attachments.length > 0) message.attachments = attachments;
    if (replyTo !== undefined) message.replyTo = replyTo;
    for (const listener of [...this.#listeners]) {
      try {
        listener(message);
      } catch (err) {
        console.error("lounge listener failed:", err);
      }
    }
    return message;
  }

  // Inserts a new room. A duplicate id throws.
  createRoom(id: string, name: string): void {
    this.#db.prepare("INSERT INTO rooms (id, name) VALUES (?, ?)").run(id, name);
  }

  // Channels and threads, oldest first. No session rooms.
  channels(): Channel[] {
    const rows = this.#db.prepare(`SELECT ${CHANNEL_COLUMNS} FROM rooms ORDER BY position, rowid`).all();
    return rows.map(toChannel).filter((c) => !c.id.startsWith(SESSION_ROOM_PREFIX));
  }

  channel(roomId: string): Channel | undefined {
    if (roomId.startsWith(SESSION_ROOM_PREFIX)) return undefined;
    const row = this.#db.prepare(`SELECT ${CHANNEL_COLUMNS} FROM rooms WHERE id = ?`).get(roomId);
    return row ? toChannel(row) : undefined;
  }

  // A work thread under a channel.
  createThread(parent: unknown, title: unknown, by: Caller): Channel {
    const parentId = typeof parent === "string" ? parent : "";
    const host = this.channel(parentId);
    if (!host || host.parent !== undefined) throw new LoungeError("unknown_room", `unknown channel: ${parentId}`);
    const clean = typeof title === "string" ? title.trim() : "";
    if (!clean || clean.length > MAX_THREAD_TITLE || /[\u0000-\u001f\u007f]/.test(clean)) {
      throw new LoungeError("bad_thread", `a thread title has 1 to ${MAX_THREAD_TITLE} characters on one line`);
    }
    const id = `${THREAD_ROOM_PREFIX}${randomBytes(4).toString("hex")}`;
    this.#db.prepare("INSERT INTO rooms (id, name, topic, parent) VALUES (?, ?, '', ?)").run(id, clean, host.id);
    const thread: Channel = { id, name: clean, topic: "", parent: host.id };
    this.#emitChannel(thread);
    this.post(by, host.id, `started a thread: ${clean}`, "event");
    this.post(by, id, "started this thread", "event");
    return thread;
  }

  // The change shows as an event line in the channel.
  setTopic(roomId: string, topic: unknown, by: Caller): Channel {
    const channel = this.channel(roomId);
    if (!channel) throw new LoungeError("unknown_room", `unknown channel: ${roomId}`);
    const clean = typeof topic === "string" ? topic.trim() : undefined;
    if (clean === undefined || clean.length > MAX_TOPIC) {
      throw new LoungeError("bad_topic", `a topic has at most ${MAX_TOPIC} characters`);
    }
    if (clean === channel.topic) return channel;
    this.#db.prepare("UPDATE rooms SET topic = ? WHERE id = ?").run(clean, roomId);
    const next = { ...channel, topic: clean };
    this.#emitChannel(next);
    this.post(by, roomId, clean ? `changed the channel topic: ${clean}` : "cleared the channel topic", "event");
    return next;
  }

  #emitChannel(channel: Channel): void {
    for (const listener of [...this.#channelListeners]) {
      try {
        listener(channel);
      } catch (err) {
        console.error("channel listener failed:", err);
      }
    }
  }

  createChannel(name: unknown, by: Caller, topic: unknown = ""): Channel {
    const id = typeof name === "string" ? channelId(name) : "";
    if (!CHANNEL_ID.test(id) || id.startsWith(SESSION_ROOM_PREFIX) || isThread(id)) {
      throw new LoungeError("bad_channel", "a channel name needs 1 to 32 letters, digits, or hyphens");
    }
    const found = this.#db.prepare("SELECT 1 AS found FROM rooms WHERE id = ?").get(id);
    if (found) throw new LoungeError("channel_exists", `channel ${id} exists`);
    const clean = typeof topic === "string" ? topic.trim() : "";
    if (clean.length > MAX_TOPIC) throw new LoungeError("bad_topic", `a topic has at most ${MAX_TOPIC} characters`);
    this.#db
      .prepare("INSERT INTO rooms (id, name, topic, position) VALUES (?, ?, ?, ?)")
      .run(id, id, clean, this.#nextPosition("rooms"));
    const channel = { id, name: id, topic: clean };
    this.#emitChannel(channel);
    this.post(by, id, clean ? `created this channel. Topic: ${clean}` : "created this channel", "event");
    return channel;
  }

  // The id stays: mentions and threads use it.
  renameChannel(roomId: string, name: unknown, by: Caller): Channel {
    const channel = this.channel(roomId);
    if (!channel || channel.parent !== undefined) throw new LoungeError("unknown_room", `unknown channel: ${roomId}`);
    const clean = cleanName(name, "bad_channel", "channel");
    if (clean === channel.name) return channel;
    this.#db.prepare("UPDATE rooms SET name = ? WHERE id = ?").run(clean, roomId);
    const next = { ...channel, name: clean };
    this.#emitChannel(next);
    this.post(by, roomId, `renamed the channel from ${channel.name} to ${clean}`, "event");
    return next;
  }

  // Turn mode and slow mode of a top-level channel.
  setChannelSettings(roomId: string, input: ChannelSettings, by: Caller): Channel {
    const channel = this.channel(roomId);
    if (!channel || channel.parent !== undefined) throw new LoungeError("unknown_room", `unknown channel: ${roomId}`);
    const { mode, slowSec } = input;
    if (mode !== undefined && mode !== "concurrent" && mode !== "sequential") {
      throw new LoungeError("bad_channel", "mode must be concurrent or sequential");
    }
    if (slowSec !== undefined && (!Number.isInteger(slowSec) || (slowSec as number) < 0 || (slowSec as number) > MAX_SLOW_SEC)) {
      throw new LoungeError("bad_channel", `slowSec must be a whole number from 0 to ${MAX_SLOW_SEC}`);
    }
    const next: Channel = { ...channel };
    const lines: string[] = [];
    if (mode !== undefined && (mode === "sequential") !== (channel.mode === "sequential")) {
      if (mode === "sequential") next.mode = "sequential";
      else delete next.mode;
      lines.push(mode === "sequential" ? "set the channel to one reply at a time" : "set the channel to replies at the same time");
    }
    if (slowSec !== undefined && slowSec !== (channel.slowSec ?? 0)) {
      if (slowSec === 0) delete next.slowSec;
      else next.slowSec = slowSec as number;
      lines.push(slowSec === 0 ? "turned slow mode off" : `set slow mode to ${String(slowSec)} s`);
    }
    if (lines.length === 0) return channel;
    this.#db
      .prepare("UPDATE rooms SET turn_mode = ?, slow_sec = ? WHERE id = ?")
      .run(next.mode ?? null, next.slowSec ?? null, roomId);
    this.#emitChannel(next);
    for (const line of lines) this.post(by, roomId, line, "event");
    return next;
  }

  // A channel goes with its threads. All or nothing.
  deleteRoom(roomId: string): string[] {
    if (roomId === DEFAULT_ROOM) throw new LoungeError("forbidden", `#${DEFAULT_ROOM} cannot be deleted`);
    const channel = this.channel(roomId);
    if (!channel) throw new LoungeError("unknown_room", `unknown channel: ${roomId}`);
    const rows = this.#db.prepare("SELECT id FROM rooms WHERE parent = ?").all(roomId);
    const ids = [roomId, ...rows.map((r) => String(r.id))];
    const marks = ids.map(() => "?").join(", ");
    this.#transaction(() => {
      for (const table of ["messages", "events", "threads"]) {
        this.#db.prepare(`DELETE FROM ${table} WHERE room_id IN (${marks})`).run(...ids);
      }
      this.#db.prepare(`DELETE FROM rooms WHERE id IN (${marks})`).run(...ids);
    });
    for (const listener of [...this.#removeListeners]) {
      try {
        listener(ids);
      } catch (err) {
        console.error("remove listener failed:", err);
      }
    }
    return ids;
  }

  onRemove(listener: (ids: string[]) => void): () => void {
    this.#removeListeners.add(listener);
    return () => {
      this.#removeListeners.delete(listener);
    };
  }

  categories(): Category[] {
    const rows = this.#db.prepare("SELECT id, name FROM categories ORDER BY position, rowid").all();
    return rows.map((r) => ({ id: String(r.id), name: String(r.name) }));
  }

  layout(): Layout {
    return { categories: this.categories(), channels: this.channels() };
  }

  createCategory(name: unknown): Category {
    const clean = cleanName(name, "bad_category", "category");
    const count = Number((this.#db.prepare("SELECT COUNT(*) AS n FROM categories").get() as { n: number }).n);
    if (count >= MAX_CATEGORIES) throw new LoungeError("bad_category", `at most ${MAX_CATEGORIES} categories`);
    const id = `${CATEGORY_PREFIX}${randomBytes(4).toString("hex")}`;
    this.#db
      .prepare("INSERT INTO categories (id, name, position) VALUES (?, ?, ?)")
      .run(id, clean, this.#nextPosition("categories"));
    this.#emitLayout();
    return { id, name: clean };
  }

  renameCategory(id: string, name: unknown): Category {
    const clean = cleanName(name, "bad_category", "category");
    const result = this.#db.prepare("UPDATE categories SET name = ? WHERE id = ?").run(clean, id);
    if (Number(result.changes) === 0) throw new LoungeError("unknown_category", `unknown category: ${id}`);
    this.#emitLayout();
    return { id, name: clean };
  }

  // Its channels go to the end of the no-category group.
  deleteCategory(id: string): void {
    const found = this.#db.prepare("SELECT 1 AS found FROM categories WHERE id = ?").get(id);
    if (!found) throw new LoungeError("unknown_category", `unknown category: ${id}`);
    this.#transaction(() => {
      let next = this.#nextPosition("rooms");
      const rows = this.#db.prepare("SELECT id FROM rooms WHERE category = ? ORDER BY position, rowid").all(id);
      const move = this.#db.prepare("UPDATE rooms SET category = NULL, position = ? WHERE id = ?");
      for (const row of rows) move.run(next++, String(row.id));
      this.#db.prepare("DELETE FROM categories WHERE id = ?").run(id);
    });
    this.#emitLayout();
  }

  // The full order, top to bottom. All or nothing.
  setLayout(input: unknown): Layout {
    const body = (input ?? {}) as { categories?: unknown; channels?: unknown };
    const bad = (why: string): never => {
      throw new LoungeError("bad_layout", why);
    };
    if (!Array.isArray(body.categories) || !Array.isArray(body.channels)) {
      bad("body must be {categories: string[], channels: {id, category}[]}");
    }
    const known = new Set(this.categories().map((c) => c.id));
    const order = body.categories as unknown[];
    if (order.length !== known.size || new Set(order).size !== order.length || !order.every((id) => known.has(id as string))) {
      bad("categories must list every category once");
    }
    const tops = new Set(this.channels().filter((c) => c.parent === undefined).map((c) => c.id));
    const items = body.channels as { id?: unknown; category?: unknown }[];
    const seen = new Set<string>();
    for (const item of items) {
      const id = typeof item?.id === "string" ? item.id : "";
      if (!tops.has(id) || seen.has(id)) bad(`unknown or repeated channel: ${id || "none"}`);
      const cat = item.category ?? null;
      if (cat !== null && !known.has(cat as string)) bad(`unknown category: ${String(cat)}`);
      seen.add(id);
    }
    if (seen.size !== tops.size) bad("channels must list every channel once");
    this.#transaction(() => {
      const cat = this.#db.prepare("UPDATE categories SET position = ? WHERE id = ?");
      order.forEach((id, i) => cat.run(i, id as string));
      const room = this.#db.prepare("UPDATE rooms SET category = ?, position = ? WHERE id = ?");
      items.forEach((item, i) => room.run((item.category as string | null) ?? null, i, item.id as string));
    });
    return this.#emitLayout();
  }

  onLayout(listener: (l: Layout) => void): () => void {
    this.#layoutListeners.add(listener);
    return () => {
      this.#layoutListeners.delete(listener);
    };
  }

  #emitLayout(): Layout {
    const layout = this.layout();
    for (const listener of [...this.#layoutListeners]) {
      try {
        listener(layout);
      } catch (err) {
        console.error("layout listener failed:", err);
      }
    }
    return layout;
  }

  #nextPosition(table: "rooms" | "categories"): number {
    const row = this.#db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM ${table}`).get() as { n: number };
    return Number(row.n);
  }

  #transaction(body: () => void): void {
    this.#db.exec("BEGIN");
    try {
      body();
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  onChannel(listener: (c: Channel) => void): () => void {
    this.#channelListeners.add(listener);
    return () => {
      this.#channelListeners.delete(listener);
    };
  }

  setTyping(caller: Caller, roomId: string, active: boolean): void {
    const key = `${roomId}|${caller}`;
    // A turn that starts is activity too.
    if (active) this.touch(caller);
    const before = this.#typing.get(key) ?? 0;
    const after = Math.max(0, before + (active ? 1 : -1));
    if (after === 0) this.#typing.delete(key);
    else this.#typing.set(key, after);
    if ((before > 0) === (after > 0)) return;
    const event: Typing = { roomId, caller, active: after > 0 };
    for (const listener of [...this.#typingListeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error("typing listener failed:", err);
      }
    }
  }

  typing(): Typing[] {
    return [...this.#typing.keys()].map((key) => {
      const [roomId, caller] = key.split("|") as [string, Caller];
      return { roomId, caller, active: true };
    });
  }

  onTyping(listener: (t: Typing) => void): () => void {
    this.#typingListeners.add(listener);
    return () => {
      this.#typingListeners.delete(listener);
    };
  }

  // noTools drops activity lines, as turn context does.
  // before reads the newest page older than that id.
  read(roomId: string, opts: { since?: number; before?: number; limit?: number; noTools?: boolean } = {}): Message[] {
    this.#requireRoom(roomId);
    const limit = clampLimit(opts.limit);
    const kinds = opts.noTools ? " AND kind != 'tool'" : "";
    const rows =
      opts.before !== undefined
        ? this.#db
            .prepare(
              `SELECT * FROM (SELECT * FROM messages WHERE room_id = ?${kinds} AND id < ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`,
            )
            .all(roomId, opts.before, limit)
        : opts.since === undefined
        ? this.#db
            .prepare(
              `SELECT * FROM (SELECT * FROM messages WHERE room_id = ?${kinds} ORDER BY id DESC LIMIT ?) ORDER BY id ASC`,
            )
            .all(roomId, limit)
        : this.#db
            .prepare(`SELECT * FROM messages WHERE room_id = ?${kinds} AND id > ? ORDER BY id ASC LIMIT ?`)
            .all(roomId, opts.since, limit);
    return (rows as unknown as MessageRow[]).map(toMessage);
  }

  touch(caller: Caller): void {
    this.#db
      .prepare(
        "INSERT INTO presence (caller, last_seen) VALUES (?, ?) " +
          "ON CONFLICT(caller) DO UPDATE SET last_seen = excluded.last_seen",
      )
      .run(caller, this.#now().toISOString());
  }

  who(): { caller: Caller; lastSeen: string | null; nickname?: string }[] {
    const rows = this.#db.prepare("SELECT caller, last_seen FROM presence").all();
    const seen = new Map(rows.map((r) => [String(r.caller), String(r.last_seen)]));
    const nicks = this.nicknames();
    return this.#callers().map((caller) => {
      const entry: { caller: Caller; lastSeen: string | null; nickname?: string } = {
        caller,
        lastSeen: seen.get(caller) ?? null,
      };
      const nick = Object.hasOwn(nicks, caller) ? nicks[caller] : undefined;
      if (nick) entry.nickname = nick;
      return entry;
    });
  }

  nicknames(): Record<string, string> {
    const rows = this.#db.prepare("SELECT caller, name FROM nicknames").all();
    return Object.fromEntries(rows.map((r) => [String(r.caller), String(r.name)]));
  }

  // The change shows as an event line in #lounge.
  setNickname(caller: Caller, name: unknown): Nickname {
    const clean = cleanNickname(name);
    const saved = this.nicknames();
    const before = Object.hasOwn(saved, caller) ? saved[caller]! : "";
    if (clean === before) return { caller, name: clean };
    if (clean) {
      this.#db
        .prepare("INSERT INTO nicknames (caller, name) VALUES (?, ?) ON CONFLICT(caller) DO UPDATE SET name = excluded.name")
        .run(caller, clean);
    } else {
      this.#db.prepare("DELETE FROM nicknames WHERE caller = ?").run(caller);
    }
    const event = { caller, name: clean };
    for (const listener of [...this.#nicknameListeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error("nickname listener failed:", err);
      }
    }
    const from = before ? `"${before}"` : caller;
    const text = clean ? `changed their name from ${from} to "${clean}"` : `went back to their own name, ${caller}`;
    this.post(caller, DEFAULT_ROOM, text, "event");
    return event;
  }

  onNickname(listener: (n: Nickname) => void): () => void {
    this.#nicknameListeners.add(listener);
    return () => {
      this.#nicknameListeners.delete(listener);
    };
  }

  onMessage(listener: Listener): () => void {
    const wrapped: Listener = (m) => listener(m);
    this.#listeners.add(wrapped);
    return () => {
      this.#listeners.delete(wrapped);
    };
  }
}
