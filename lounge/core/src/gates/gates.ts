import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Agent, Caller } from "../config.ts";
import { LoungeError, type Room } from "../lounge/room.ts";
import type { Threads } from "../lounge/threads.ts";

export type Decision = "approve" | "change";

export interface GateOutcome {
  status: "approved" | "changed" | "cancelled";
  note: string;
}

export interface GateInput {
  agent: Agent;
  roomId: string;
  phase: unknown;
  summary: unknown;
  file?: unknown;
}

// A gate as a card of the approval stack. It does not time out.
export interface GateCard {
  id: string;
  agent: Agent;
  tool: "lounge_gate";
  summary: string;
  reason: string;
  createdAt: string;
  expiresAt: "";
  gate: { phase: string; file: string; roomId: string };
}

const PHASE_MAX = 40;
const SUMMARY_MAX = 4000;
const FILE_MAX = 500;
const NOTE_MAX = 2000;

const WORDS: Record<Decision, { status: "approved" | "changed"; text: string }> = {
  approve: { status: "approved", text: "approved" },
  change: { status: "changed", text: "change requested" },
};

function field(raw: unknown, name: string, max: number, required: boolean): string {
  if (raw === undefined && !required) return "";
  const text = typeof raw === "string" ? raw.trim() : "";
  if (typeof raw !== "string" || (required && text === "") || text.length > max) {
    throw new LoungeError("bad_gate", `${name} is ${required ? "a text of" : "a text with"} at most ${max} characters`);
  }
  return text;
}

// Cards in the approval stack that block an agent turn until the owner decides.
export class Gates {
  readonly #db: DatabaseSync;
  readonly #room: Room;
  readonly #threads: Threads;
  readonly #now: () => Date;
  // Open gates, oldest first.
  #cards = new Map<string, GateCard>();
  // Calls that wait for their gate. A stopped thread drops its calls and keeps its cards.
  #waiting = new Map<string, (outcome: GateOutcome) => void>();
  // Threads the owner stopped, until a new gate opens in them.
  #stopped = new Set<string>();
  #listeners = new Set<(cards: GateCard[]) => void>();

  constructor(opts: { db: DatabaseSync; room: Room; threads: Threads; now?: () => Date }) {
    this.#db = opts.db;
    this.#room = opts.room;
    this.#threads = opts.threads;
    this.#now = opts.now ?? (() => new Date());
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS gates (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent TEXT NOT NULL, " +
        "phase TEXT NOT NULL, summary TEXT NOT NULL, file TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', " +
        "created_at TEXT NOT NULL, decided_at TEXT)",
    );
    if (!this.#db.prepare("PRAGMA table_info(threads)").all().some((c) => c.name === "phase")) {
      this.#db.exec("ALTER TABLE threads ADD COLUMN phase TEXT");
    }
    // The turn that waited died with the last run.
    this.#db.exec("UPDATE gates SET status = 'cancelled' WHERE status = 'open'");
  }

  // Oldest first.
  cards(): GateCard[] {
    return [...this.#cards.values()];
  }

  onChange(listener: (cards: GateCard[]) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // Stores an open gate and sets the thread phase. Resolves when the gate ends.
  add(input: GateInput, signal?: AbortSignal): Promise<GateOutcome> {
    const { agent, roomId } = input;
    if (!this.#threads.info(roomId)) throw new LoungeError("bad_thread", `not a work thread: ${roomId}`);
    const phase = field(input.phase, "phase", PHASE_MAX, true);
    const summary = field(input.summary, "summary", SUMMARY_MAX, true);
    const file = field(input.file, "file", FILE_MAX, false);
    const id = randomUUID();
    const createdAt = this.#now().toISOString();
    this.#db
      .prepare("INSERT INTO gates (id, room_id, agent, phase, summary, file, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)")
      .run(id, roomId, agent, phase, summary, file, createdAt);
    this.#db.prepare("UPDATE threads SET phase = ? WHERE room_id = ?").run(phase, roomId);
    const card: GateCard = {
      id,
      agent,
      tool: "lounge_gate",
      summary,
      reason: `${phase}: ${summary}`,
      createdAt,
      expiresAt: "",
      gate: { phase, file, roomId },
    };
    this.#stopped.delete(roomId);
    this.#cards.set(id, card);
    return new Promise((resolve) => {
      const onAbort = () => this.#cancel(id);
      this.#waiting.set(id, (outcome) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#emit();
      if (signal?.aborted) onAbort();
    });
  }

  // Only the owner decides, and only an open gate takes a decision.
  decide(by: Caller, id: string, decision: Decision, note: unknown): void {
    if (by !== "owner") throw new LoungeError("forbidden", "only the owner decides a gate");
    if (!Object.hasOwn(WORDS, decision)) throw new LoungeError("bad_gate", "decision is approve or change");
    const word = WORDS[decision];
    const text = field(note, "note", NOTE_MAX, false);
    const row = this.#db.prepare("SELECT room_id FROM gates WHERE id = ?").get(id);
    if (!row) throw new LoungeError("unknown_gate", `no gate: ${id}`);
    const done = this.#db
      .prepare("UPDATE gates SET status = ?, note = ?, decided_at = ? WHERE id = ? AND status = 'open'")
      .run(word.status, text, this.#now().toISOString(), id);
    if (done.changes === 0) throw new LoungeError("conflict", "the gate is decided or cancelled");
    const roomId = String(row.room_id);
    // The post mentions the lead, which starts her turn. A stopped thread gets an event line: it starts no turn.
    const lead = this.#threads.info(roomId)?.lead;
    if (lead) {
      const line = `@${lead} ${text ? `${word.text}: ${text}` : word.text}`;
      if (this.#stopped.has(roomId)) this.#room.post("owner", roomId, line, "event");
      else this.#room.post("owner", roomId, line);
    }
    this.#end(id, { status: word.status, note: text });
  }

  // The owner stops the thread: its calls stop waiting. Its cards stay for a decision.
  stopRoom(roomId: string): void {
    this.#stopped.add(roomId);
    for (const [id, card] of this.#cards) if (card.gate.roomId === roomId) this.#release(id, { status: "cancelled", note: "" });
  }

  close(): void {
    for (const id of [...this.#cards.keys()]) this.#cancel(id);
  }

  // The call is gone: the gate ends.
  #cancel(id: string): void {
    const done = this.#db
      .prepare("UPDATE gates SET status = 'cancelled', decided_at = ? WHERE id = ? AND status = 'open'")
      .run(this.#now().toISOString(), id);
    if (done.changes > 0) this.#end(id, { status: "cancelled", note: "" });
  }

  #end(id: string, outcome: GateOutcome): void {
    this.#cards.delete(id);
    this.#release(id, outcome);
    this.#emit();
  }

  #release(id: string, outcome: GateOutcome): void {
    this.#waiting.get(id)?.(outcome);
    this.#waiting.delete(id);
  }

  #emit(): void {
    const cards = this.cards();
    for (const listener of [...this.#listeners]) {
      try {
        listener(cards);
      } catch (err) {
        console.error("gate listener failed:", err);
      }
    }
  }
}

// An agent opens a gate and waits for the decision.
export function openGate(gates: Gates, input: GateInput, signal?: AbortSignal): Promise<GateOutcome> {
  return gates.add(input, signal);
}
