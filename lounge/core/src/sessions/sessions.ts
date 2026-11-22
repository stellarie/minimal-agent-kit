import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { permissionsFor, type Caller, type Agent, type LoungeConfig } from "../config.ts";
import type { Adapter, AdapterLookup, NearThread, TurnMember, TurnSelf } from "../adapters/types.ts";
import { localIso } from "../adapters/prompt.ts";
import type { RestrictedTokens } from "../auth/restricted.ts";
import { LoungeError, postLimit, SESSION_ROOM_PREFIX, type Message, type Room } from "../lounge/room.ts";
import type { Roster } from "../roster/roster.ts";
import type { AgentEntry } from "../roster/types.ts";
import { realTimers, Slots, type TimerApi } from "./slots.ts";
import { Grants } from "../auth/grants.ts";
import { attachmentDir, attachmentPath } from "../lounge/attachments.ts";
import { driveRoots } from "../guard/drives.ts";
import type { GuardMode } from "../guard/guardMode.ts";
import { sweepTurnFolders } from "./turn-folders.ts";

export interface TurnEnd {
  agent: Agent;
  roomId: string;
  outcome: "post" | "pass" | "error";
}

export type SessionState =
  | "pending_approval"
  | "starting"
  | "running"
  | "idle"
  | "closed"
  | "failed"
  | "detached";

export const SESSION_STATES: readonly SessionState[] = [
  "pending_approval",
  "starting",
  "running",
  "idle",
  "closed",
  "failed",
  "detached",
];

export { SESSION_ROOM_PREFIX };

export interface SessionView {
  id: string;
  agent: Agent;
  kind: "chat";
  openedBy: Caller;
  brief: string;
  roomId: string;
  state: SessionState;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionsOptions {
  db: DatabaseSync;
  room: Room;
  home: string;
  config: LoungeConfig;
  adapters: AdapterLookup;
  roster: Roster;
  restricted: RestrictedTokens;
  grants?: Grants;
  // Runtime label and effective model.
  // Unset: the runtime id and the entry model.
  runtimeInfo?(entry: AgentEntry): { label: string; model: string };
  // The owner's rules for every agent. Unset: none.
  loungeRules?(): string;
  // The lounge guard mode. Unset: turns carry none.
  guardMode?(): GuardMode;
  // Threads near a room. Unset: none.
  nearThreads?(roomId: string): NearThread[];
  now?: () => Date;
  timers?: TimerApi;
}

interface SessionRow {
  id: string;
  agent: string;
  kind: string;
  opened_by: string;
  brief: string;
  room_id: string;
  state: string;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface TurnOutcome {
  // Unset when the agent passed.
  message?: Message;
}

interface Runner {
  agent: Agent;
  controller: AbortController;
  done: Promise<Message | undefined>;
}

export interface WorkTurnInput {
  agent: Agent;
  roomId: string;
  cwd: string;
  brief: string;
  // The owner's message started this turn.
  lead?: boolean;
  onActivity(line: string): void;
}

interface TurnMode {
  // The owner's message started this turn.
  lead?: boolean;
  // Work turns skip the chat slots and the hard timeout.
  work?: { cwd: string; onActivity(line: string): void };
}

function toView(row: SessionRow): SessionView {
  const view: SessionView = {
    id: row.id,
    agent: row.agent as Agent,
    kind: "chat",
    openedBy: row.opened_by as Caller,
    brief: row.brief,
    roomId: row.room_id,
    state: row.state as SessionState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.reason !== null) view.reason = row.reason;
  return view;
}

// Two tries to fit the limit, then nothing posts.
const MAX_REDO = 2;

export function redoNote(draft: string, limit: number): string {
  return [
    `System: your reply was not posted. It has ${draft.length} characters. A post here has at most ${limit} characters.`,
    `Write the reply again in ${limit} characters or fewer. Your draft:`,
    draft,
    "End of draft.",
  ].join("\n");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Sessions {
  #db: DatabaseSync;
  #room: Room;
  #home: string;
  #config: LoungeConfig;
  #adapters: AdapterLookup;
  #roster: Roster;
  #restricted: RestrictedTokens;
  #grants: Grants;
  #runtimeInfo: NonNullable<SessionsOptions["runtimeInfo"]>;
  #loungeRules: () => string;
  #guardMode: (() => GuardMode) | undefined;
  #nearThreads: (roomId: string) => NearThread[];
  #now: () => Date;
  #timers: TimerApi;
  #slots: Slots;
  #runners = new Map<string, Runner>();
  #slow = new Map<Agent, number>();
  #busy = new Map<Agent, number>();
  #stopping = false;
  #turnEnd = new Set<(e: TurnEnd) => void>();

  constructor(opts: SessionsOptions) {
    this.#db = opts.db;
    this.#room = opts.room;
    this.#home = opts.home;
    this.#config = opts.config;
    this.#adapters = opts.adapters;
    this.#roster = opts.roster;
    this.#restricted = opts.restricted;
    this.#grants = opts.grants ?? new Grants(opts.db);
    this.#runtimeInfo = opts.runtimeInfo ?? ((entry) => ({ label: entry.runtime, model: entry.model || "default model" }));
    this.#loungeRules = opts.loungeRules ?? (() => "");
    this.#guardMode = opts.guardMode;
    this.#nearThreads = opts.nearThreads ?? (() => []);
    this.#now = opts.now ?? (() => new Date());
    this.#timers = opts.timers ?? realTimers;
    const { maxRunning, queueTimeoutMs } = opts.config.sessions;
    this.#slots = new Slots(maxRunning, queueTimeoutMs, this.#timers);
    // Turns from a previous core run are gone.
    this.#db
      .prepare(
        "UPDATE sessions SET state = 'detached', updated_at = ? WHERE state IN ('starting', 'running')",
      )
      .run(this.#stamp());
    sweepTurnFolders(opts.home);
  }

  onTurnEnd(listener: (e: TurnEnd) => void): () => void {
    this.#turnEnd.add(listener);
    return () => {
      this.#turnEnd.delete(listener);
    };
  }

  #stamp(): string {
    return this.#now().toISOString();
  }

  #row(id: string): SessionRow {
    const row = this.#db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    if (!row) throw new LoungeError("unknown_session", `unknown session: ${id}`);
    return row as unknown as SessionRow;
  }

  #setState(id: string, state: SessionState, reason?: string): void {
    this.#db
      .prepare("UPDATE sessions SET state = ?, reason = COALESCE(?, reason), updated_at = ? WHERE id = ?")
      .run(state, reason ?? null, this.#stamp(), id);
  }

  #fail(id: string, reason: string): void {
    this.#db
      .prepare(
        "UPDATE sessions SET state = 'failed', reason = ?, updated_at = ? WHERE id = ? AND state != 'closed'",
      )
      .run(reason, this.#stamp(), id);
  }

  // A runner must never reject; log a failed write.
  #failQuietly(id: string, err: unknown): void {
    try {
      this.#fail(id, errorText(err));
    } catch (writeErr) {
      console.error("session state write failed:", errorText(writeErr));
    }
  }

  #requireDriver(caller: Caller, row: SessionRow): void {
    if (caller === "owner" || caller === row.opened_by) return;
    throw new LoungeError("forbidden", `${caller} did not open session ${row.id}`);
  }

  #requireRunning(): void {
    if (this.#stopping) throw new LoungeError("unsupported", "the core is shutting down");
  }

  open(caller: Caller, input: { agent: string; kind: string; brief: string }): SessionView {
    this.#requireRunning();
    const agent = input.agent;
    if (!this.#roster.has(agent)) throw new LoungeError("unknown_agent", `no agent: ${agent}`);
    if (input.kind !== "chat") {
      const detail =
        input.kind === "work" ? "work sessions arrive in build step 7" : `unknown kind ${input.kind}`;
      throw new LoungeError("unsupported", detail);
    }
    if (permissionsFor(this.#config, caller).chat === "reject") {
      throw new LoungeError("forbidden", `${caller} may not open chat sessions`);
    }
    if (!this.#roster.enabled(agent)) {
      throw new LoungeError("forbidden", `${agent} is disabled`);
    }
    const id = randomUUID();
    const roomId = `${SESSION_ROOM_PREFIX}${id}`;
    const stamp = this.#stamp();
    this.#db.exec("BEGIN");
    try {
      this.#room.createRoom(roomId, `chat with ${agent}`);
      this.#db
        .prepare(
          "INSERT INTO sessions (id, agent, kind, opened_by, brief, room_id, state, reason, created_at, updated_at) " +
            "VALUES (?, ?, 'chat', ?, ?, ?, 'starting', NULL, ?, ?)",
        )
        .run(id, agent, caller, String(input.brief), roomId, stamp, stamp);
      // Last write: post runs listeners only on success.
      this.#room.post(caller, roomId, input.brief);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
    void this.#startTurn(id);
    return this.status(id);
  }

  async message(
    caller: Caller,
    id: string,
    text: string,
  ): Promise<{ session: SessionView; reply?: Message }> {
    this.#requireRunning();
    const row = this.#row(id);
    this.#requireDriver(caller, row);
    if (row.state === "closed" || row.state === "failed") {
      throw new LoungeError("session_closed", `session ${id} is ${row.state}`);
    }
    if (row.state !== "idle" && row.state !== "detached") {
      throw new LoungeError("session_busy", `session ${id} is ${row.state}`);
    }
    // Post first: a bad text leaves the state alone.
    this.#room.post(caller, row.room_id, text);
    this.#setState(id, "running");
    const turn = this.#startTurn(id);
    let handle: unknown;
    const wait = new Promise<undefined>((resolve) => {
      handle = this.#timers.setTimeout(() => resolve(undefined), this.#config.sessions.replyWaitMs);
    });
    const reply = await Promise.race([turn, wait]);
    this.#timers.clearTimeout(handle);
    const session = this.status(id);
    return reply ? { session, reply } : { session };
  }

  status(id: string): SessionView {
    return toView(this.#row(id));
  }

  list(state?: SessionState): SessionView[] {
    const rows =
      state === undefined
        ? this.#db.prepare("SELECT * FROM sessions ORDER BY created_at, id").all()
        : this.#db.prepare("SELECT * FROM sessions WHERE state = ? ORDER BY created_at, id").all(state);
    return (rows as unknown as SessionRow[]).map(toView);
  }

  close(caller: Caller, id: string): SessionView {
    const row = this.#row(id);
    this.#requireDriver(caller, row);
    if (row.state !== "closed") this.#setState(id, "closed");
    this.#runners.get(id)?.controller.abort(new Error("closed"));
    return this.status(id);
  }

  slow(): ReadonlySet<Agent> {
    return new Set([...this.#slow].filter(([, count]) => count > 0).map(([agent]) => agent));
  }

  busy(): ReadonlySet<Agent> {
    return new Set([...this.#busy].filter(([, count]) => count > 0).map(([agent]) => agent));
  }

  // A turn outside sessions; shutdown aborts it.
  roomTurn(agent: Agent, roomId: string, brief: string, signal?: AbortSignal, lead = false): Promise<TurnOutcome> {
    return this.#tracked(`room-${randomUUID()}`, agent, signal, (key, s) =>
      this.#turn(agent, roomId, brief, key, s, { lead }),
    );
  }

  // A thread turn: no slot, no hard timeout.
  workTurn(input: WorkTurnInput, signal?: AbortSignal): Promise<TurnOutcome> {
    const { agent, roomId, brief, cwd, onActivity, lead } = input;
    return this.#tracked(`work-${randomUUID()}`, agent, signal, (key, s) =>
      this.#turn(agent, roomId, brief, key, s, { work: { cwd, onActivity }, lead: lead === true }),
    );
  }

  #tracked(
    key: string,
    agent: Agent,
    signal: AbortSignal | undefined,
    run: (key: string, signal: AbortSignal) => Promise<TurnOutcome>,
  ): Promise<TurnOutcome> {
    this.#requireRunning();
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }
    const turn = run(key, controller.signal);
    const done = turn.then(
      () => undefined,
      () => undefined,
    );
    this.#runners.set(key, { agent, controller, done });
    void done.then(() => this.#runners.delete(key));
    return turn;
  }

  // An abort here writes no state; the next start detaches.
  async shutdown(): Promise<void> {
    // No new turn may start after this point.
    this.#stopping = true;
    const running = [...this.#runners.values()];
    for (const runner of running) runner.controller.abort(new Error("shutdown"));
    await Promise.all(running.map((runner) => runner.done));
  }

  // A retired or unknown agent gets no turn.
  #adapterFor(agent: Agent): Adapter {
    if (!this.#roster.has(agent)) throw new LoungeError("unknown_agent", `no agent: ${agent}`);
    const missing = this.#roster.runtimeReason(agent);
    if (missing !== undefined) throw new Error(missing);
    const adapter = this.#adapters.get(agent);
    if (adapter === undefined) throw new Error(`${agent} has no runtime`);
    return adapter;
  }

  // Retire: stop its turns and close its sessions.
  retire(agent: Agent): void {
    for (const runner of this.#runners.values()) {
      if (runner.agent === agent) runner.controller.abort(new Error("retired"));
    }
    const rows = this.#db
      .prepare("SELECT id FROM sessions WHERE agent = ? AND state NOT IN ('closed', 'failed')")
      .all(agent);
    for (const row of rows) this.#setState(String(row.id), "closed", "retired");
  }

  // A missing file keeps its name, with no path.
  #withPaths(messages: Message[]): Message[] {
    return messages.map((m) => {
      if (!m.attachments || m.attachments.length === 0) return m;
      const attachments = m.attachments.map((a) => {
        try {
          return { ...a, path: attachmentPath(this.#home, a) };
        } catch {
          return a;
        }
      });
      return { ...m, attachments };
    });
  }

  #markBusy(agent: Agent, delta: number): void {
    this.#busy.set(agent, (this.#busy.get(agent) ?? 0) + delta);
  }

  #markSlow(agent: Agent, delta: number): void {
    this.#slow.set(agent, (this.#slow.get(agent) ?? 0) + delta);
  }

  #startTurn(id: string): Promise<Message | undefined> {
    const controller = new AbortController();
    const done = this.#runTurn(id, controller.signal);
    const runner: Runner = { agent: this.#row(id).agent, controller, done };
    this.#runners.set(id, runner);
    void done.then(() => {
      if (this.#runners.get(id) === runner) this.#runners.delete(id);
    });
    return done;
  }

  async #runTurn(id: string, signal: AbortSignal): Promise<Message | undefined> {
    try {
      const row = this.#row(id);
      const outcome = await this.#turn(row.agent as Agent, row.room_id, row.brief, id, signal, {});
      if (signal.aborted) return undefined;
      this.#setState(id, "idle");
      return outcome.message;
    } catch (err) {
      if (!signal.aborted) this.#failQuietly(id, err);
      return undefined;
    }
  }

  // One turn in any room. Throws with the reason.
  async #turn(
    agent: Agent,
    roomId: string,
    brief: string,
    scope: string,
    signal: AbortSignal,
    mode: TurnMode,
  ): Promise<TurnOutcome> {
    const release = mode.work ? () => {} : await this.#slots.acquire(signal);
    let token: string | undefined;
    let ended: TurnEnd["outcome"] = "error";
    let slow = false;
    let typing = false;
    // Its own lounge_post here makes the final text an echo.
    // A work turn keeps it: it may hold a hand-off.
    let postedHere = false;
    const stopWatch = mode.work
      ? () => {}
      : this.#room.onMessage((m) => {
          if (m.author === agent && m.roomId === roomId && m.kind === undefined) postedHere = true;
        });
    // A working agent may still chat.
    const busy = !mode.work;
    if (busy) this.#markBusy(agent, 1);
    try {
      const adapter = this.#adapterFor(agent);
      const ready = await adapter.available();
      if (signal.aborted) throw new Error("aborted");
      if (!ready.ok) throw new Error(ready.reason ?? `${adapter.name} is unavailable`);
      const { contextMessages } = this.#config.sessions;
      const context = this.#withPaths(this.#room.read(roomId, { limit: contextMessages, noTools: true }));
      token = this.#restricted.mint(agent, scope);
      typing = true;
      this.#room.setTyping(agent, roomId, true);
      const input = {
        agent,
        brief,
        channel: this.#room.channel(roomId),
        context,
        names: this.#room.nicknames(),
        now: localIso(this.#now()),
        mcpToken: token,
        allowedTools: this.#grants.runtimeTools(agent),
        ...this.#readDirs(agent),
        ...this.#facts(agent),
        ...this.#threadsFor(roomId),
        ...(mode.work ? { work: { cwd: mode.work.cwd }, onActivity: mode.work.onActivity } : {}),
        onSlow: () => {
          if (slow) return;
          slow = true;
          this.#markSlow(agent, 1);
        },
      };
      const maxPost = postLimit(agent, roomId);
      // A long reply goes back to the agent, never cut.
      for (let redo = 0; ; redo++) {
        const result = await adapter.chatTurn(input, signal);
        if (signal.aborted) throw new Error("aborted");
        ended = result.kind;
        if (result.kind !== "post") return {};
        if (postedHere) {
          ended = "pass";
          return {};
        }
        if (result.text.length <= maxPost) {
          if (result.text.trim().length === 0) return {};
          return { message: this.#room.post(agent, roomId, result.text) };
        }
        if (redo >= MAX_REDO) {
          this.#room.post(agent, roomId, `reply not posted: ${result.text.length} characters, the limit here is ${maxPost}`, "event");
          return {};
        }
        input.brief = `${brief}\n${redoNote(result.text, maxPost)}`;
      }
    } finally {
      stopWatch();
      if (typing) this.#room.setTyping(agent, roomId, false);
      if (token !== undefined) this.#restricted.revoke(token);
      if (slow) this.#markSlow(agent, -1);
      if (busy) this.#markBusy(agent, -1);
      release();
      for (const l of [...this.#turnEnd]) {
        try {
          l({ agent, roomId, outcome: ended });
        } catch (err) {
          console.error("turn end listener failed:", errorText(err));
        }
      }
    }
  }

  // Built on every turn, so a roster edit shows.
  #facts(agent: Agent): {
    self?: TurnSelf;
    members: TurnMember[];
    loungeRules: string;
    guardMode?: GuardMode;
  } {
    const names = this.#room.nicknames();
    const nameOf = (id: string): string => names[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
    const entry = this.#roster.get(agent);
    const members = this.#roster
      .active()
      .filter((e) => e.enabled && e.id !== agent)
      .map((e) => ({ id: e.id, name: nameOf(e.id), runtime: this.#runtimeInfo(e).label }));
    const loungeRules = this.#loungeRules();
    const guardMode = this.#guardModeNow();
    if (entry === undefined) return { members, loungeRules, ...guardMode };
    const info = this.#runtimeInfo(entry);
    const self = { id: agent, name: nameOf(agent), runtime: info.label, model: info.model, effort: entry.effort };
    return { self, members, loungeRules, ...guardMode };
  }

  // A broken lookup leaves the line out.
  #guardModeNow(): { guardMode?: GuardMode } {
    if (this.#guardMode === undefined) return {};
    try {
      return { guardMode: this.#guardMode() };
    } catch (err) {
      console.error("guard mode lookup failed:", errorText(err));
      return {};
    }
  }

  #threadsFor(roomId: string): { threads?: NearThread[] } {
    try {
      const threads = this.#nearThreads(roomId);
      return threads.length > 0 ? { threads } : {};
    } catch (err) {
      console.error("thread list failed:", errorText(err));
      return {};
    }
  }

  // Every turn reads attachments; PC access adds every drive.
  #readDirs(agent: Agent): { readDirs: string[] } {
    const dirs = this.#grants.pcAccess(agent) ? driveRoots() : [];
    dirs.push(attachmentDir(this.#home));
    return { readDirs: dirs };
  }
}
