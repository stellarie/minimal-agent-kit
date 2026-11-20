import type { DatabaseSync } from "node:sqlite";
import type { Agent, Caller } from "../config.ts";
import { LoungeError, type Room } from "../lounge/room.ts";
import type { ThreadInfo, Threads, TurnEnd } from "../lounge/threads.ts";

// Below a channel thread: lead -> implementer -> explorer.
export const MAX_DEPTH = 2;
const TITLE_MAX = 60;
const REPORT_MAX = 4000;

export interface SpawnDraft {
  agent: unknown;
  brief: unknown;
  cwd?: unknown;
}

export interface TreeNode {
  id: string;
  name: string;
  lead: Agent;
  stopped: boolean;
  // Agents with a running turn in this thread.
  working: Agent[];
  children: TreeNode[];
}

export interface ChildrenOptions {
  db: DatabaseSync;
  room: Room;
  threads: Threads;
}

// Child threads: a subagent is a roster agent that leads its own thread.
export class Children {
  readonly #opts: ChildrenOptions;
  // Stop marks and reports live in memory: runs do not outlive the core.
  #stopped = new Set<string>();
  #reported = new Set<string>();

  constructor(opts: ChildrenOptions) {
    this.#opts = opts;
  }

  parentOf(id: string): string | undefined {
    const row = this.#opts.db.prepare("SELECT parent_id FROM threads WHERE room_id = ?").get(id);
    return row?.parent_id ? String(row.parent_id) : undefined;
  }

  childrenOf(id: string): string[] {
    const rows = this.#opts.db
      .prepare("SELECT room_id FROM threads WHERE parent_id = ? ORDER BY created_at, room_id")
      .all(id);
    return rows.map((r) => String(r.room_id));
  }

  // parent_id is set once at insert to an older thread, so the chain ends.
  depth(id: string): number {
    let depth = 0;
    for (let at = this.parentOf(id); at !== undefined; at = this.parentOf(at)) depth += 1;
    return depth;
  }

  stopped(id: string): boolean {
    for (let at: string | undefined = id; at !== undefined; at = this.parentOf(at)) {
      if (this.#stopped.has(at)) return true;
    }
    return false;
  }

  // The caller's one running turn is the parent.
  parentFor(caller: Caller): string {
    const rooms = [...new Set(this.#opts.threads.work().filter((w) => w.agent === caller).map((w) => w.roomId))];
    if (rooms.length !== 1) {
      throw new LoungeError("bad_thread", "lounge_spawn works only during your turn in one work thread");
    }
    return rooms[0]!;
  }

  spawnChild(by: Caller, parentId: string, draft: SpawnDraft): ThreadInfo {
    const parent = this.#opts.threads.info(parentId);
    if (!parent) throw new LoungeError("bad_thread", `unknown thread: ${parentId}`);
    if (this.depth(parentId) + 1 > MAX_DEPTH) {
      throw new LoungeError("bad_thread", `depth cap: a child thread may be at most ${MAX_DEPTH} below a channel thread`);
    }
    if (this.stopped(parentId)) throw new LoungeError("bad_thread", "the parent thread is stopped");
    const brief = typeof draft.brief === "string" ? draft.brief.trim() : "";
    if (!brief) throw new LoungeError("bad_thread", "a child thread needs a brief");
    const agent = typeof draft.agent === "string" ? draft.agent : "";
    const cwd = draft.cwd === undefined || draft.cwd === "" ? parent.cwd : draft.cwd;
    const title = brief.split("\n")[0]!.slice(0, TITLE_MAX);
    return this.#opts.threads.create(
      by,
      { channel: parent.parent, title, brief: `@${agent} ${brief}`, lead: agent, cwd },
      { parentId },
    );
  }

  // Stops t, then each child, then the running turns of t.
  stopTree(by: Caller, id: string): number {
    if (!this.#opts.threads.info(id)) throw new LoungeError("unknown_room", `unknown thread: ${id}`);
    this.#stopped.add(id);
    let count = 0;
    for (const child of this.childrenOf(id)) count += this.stopTree(by, child);
    return count + this.#opts.threads.halt(by, id);
  }

  // The owner may resume a stopped channel thread. A stopped child stays stopped.
  mayStart(id: string, from?: Caller | "self"): boolean {
    if (from === "owner" && this.parentOf(id) === undefined) this.#stopped.delete(id);
    return !this.stopped(id);
  }

  // A child lead with no pending turns reports to the spawner once.
  turnEnded(id: string, agent: Agent, end: TurnEnd): void {
    const parentId = this.parentOf(id);
    const info = this.#opts.threads.info(id);
    if (!parentId || !info || agent !== info.lead || this.#reported.has(id) || this.stopped(id)) return;
    if (this.#opts.threads.work().some((w) => w.roomId === id)) return;
    this.#reported.add(id);
    const spawner = info.createdBy as Agent;
    const body = end.failed ? `could not finish: ${end.failed}` : (end.reply?.text ?? "finished with no reply");
    const text = `@${spawner} child thread "${info.name}" finished: ${body}`.slice(0, REPORT_MAX);
    this.#opts.threads.deliver(agent, parentId, text, spawner);
  }

  // The whole tree that holds id, from its root thread.
  tree(id: string): TreeNode {
    if (!this.#opts.threads.info(id)) throw new LoungeError("unknown_room", `unknown thread: ${id}`);
    let top = id;
    for (let at = this.parentOf(id); at !== undefined; at = this.parentOf(at)) top = at;
    const work = this.#opts.threads.work();
    const node = (at: string): TreeNode => {
      const info = this.#opts.threads.info(at)!;
      return {
        id: at,
        name: info.name,
        lead: info.lead,
        stopped: this.stopped(at),
        working: work.filter((w) => w.roomId === at).map((w) => w.agent),
        children: this.childrenOf(at).map(node),
      };
    };
    return node(top);
  }
}
