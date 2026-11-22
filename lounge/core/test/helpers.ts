import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chatFolder } from "../src/config.ts";
import type { DatabaseSync } from "node:sqlite";
import { unavailableAdapter } from "../src/adapters/stub.ts";
import type { Adapter, AdapterLookup } from "../src/adapters/types.ts";
import { HOOK_FILE, coreKinds } from "../src/adapters/runtimes.ts";
import { chatPrompt, isPass, systemText, turnText } from "../src/adapters/prompt.ts";
import { claudeSubagents, claudeToolLines, lineSplitter, toolLine } from "../src/adapters/activity.ts";
import { Roster } from "../src/roster/roster.ts";
import type { AgentEntry, RuntimeContext, RuntimeKind } from "../src/roster/types.ts";
import { RestrictedTokens } from "../src/auth/restricted.ts";
import { defaultConfig, SEED_AGENTS, type LoungeConfig } from "../src/config.ts";
import { Threads } from "../src/lounge/threads.ts";
import { Attachments } from "../src/lounge/attachments.ts";
import { ProfileFiles } from "../src/lounge/files.ts";
import { Events } from "../src/lounge/events.ts";
import type { Room } from "../src/lounge/room.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import type { TimerApi } from "../src/sessions/slots.ts";

export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

export function tempHome(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "lounge-test-"));
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      rmSync(dirname(chatFolder(dir, "x")), { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

export class FakeTimers implements TimerApi {
  #next = 1;
  pending = new Map<number, { fn: () => void; ms: number }>();

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.#next++;
    this.pending.set(id, { fn, ms });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  fireAll(): void {
    const due = [...this.pending.values()];
    this.pending.clear();
    for (const entry of due) entry.fn();
  }
}

// The callers that every first start has.
export const SEED_CALLERS: readonly string[] = ["owner", ...SEED_AGENTS];

// What the core gives a plugin adapter, for tests that build one by hand.
export const HOST_PARTS = {
  hookFile: HOOK_FILE,
  prompt: { systemText, turnText, chatPrompt, isPass },
  activity: { claudeToolLines, claudeSubagents, lineSplitter, toolLine },
};

// The core kinds plus stand-ins for the seed runtimes.
// The CLI runtimes are plugins, so a bare roster does not know them.
export function testKinds(): RuntimeKind[] {
  return [...coreKinds(), ...fakeKinds(() => unavailableAdapter("test", "stand-in"))];
}

// Seeded from the config, as a first start.
export function testRoster(db: DatabaseSync, config: LoungeConfig = defaultConfig(), kinds?: RuntimeKind[]): Roster {
  return new Roster(db, config.adapters, () => kinds ?? testKinds());
}

export function adaptersOf(map: Record<string, Adapter>): AdapterLookup {
  return { get: (id) => map[id] };
}

export function stubAdapters(): AdapterLookup {
  return { get: () => unavailableAdapter("claude", "test stub") };
}

// Stands in for the seed runtimes.
// Each agent gets the adapter that pick returns.
export function fakeKinds(pick: (entry: AgentEntry, ctx: RuntimeContext) => Adapter): RuntimeKind[] {
  return ["claude-code", "codex"].map((id) => ({
    id,
    label: id,
    efforts: () => [],
    models: () => [],
    create: (entry, ctx) => pick(entry, ctx),
  }));
}

// Session deps for tests that do not run turns.
export function sessionDeps(opts: {
  db: DatabaseSync;
  room: Room;
  home: string;
  config?: LoungeConfig;
  adapters?: AdapterLookup;
  roster?: Roster;
}): {
  roster: Roster;
  sessions: Sessions;
  restricted: RestrictedTokens;
  events: Events;
  threads: Threads;
  attachments: Attachments;
  files: ProfileFiles;
} {
  const restricted = new RestrictedTokens();
  const roster = opts.roster ?? testRoster(opts.db, opts.config);
  const sessions = new Sessions({
    db: opts.db,
    room: opts.room,
    home: opts.home,
    config: opts.config ?? defaultConfig(),
    adapters: opts.adapters ?? stubAdapters(),
    roster,
    restricted,
  });
  const threads = new Threads({ db: opts.db, room: opts.room, home: opts.home, roster, turns: sessions });
  const profile = join(opts.home, "profile");
  mkdirSync(profile, { recursive: true });
  return {
    roster,
    sessions,
    restricted,
    events: new Events({ db: opts.db, room: opts.room }),
    threads,
    attachments: new Attachments({ db: opts.db, home: opts.home }),
    files: new ProfileFiles({ root: profile }),
  };
}
