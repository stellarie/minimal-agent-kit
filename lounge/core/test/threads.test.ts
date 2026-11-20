import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { claudeToolLines, lineSplitter, toolLine } from "../src/adapters/activity.ts";
import { systemText, turnText } from "../src/adapters/prompt.ts";
import { defaultConfig, SEED_AGENTS } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import { LoungeError, Room } from "../src/lounge/room.ts";
import { Threads, type WorkEvent } from "../src/lounge/threads.ts";
import type { TurnOutcome, WorkTurnInput } from "../src/sessions/sessions.ts";
import { tempHome, testRoster } from "./helpers.ts";

interface Call {
  input: WorkTurnInput;
  signal?: AbortSignal;
  finish(outcome?: TurnOutcome): void;
  fail(err: Error): void;
}

function setup(t: TestContext, disabled: string[] = []) {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  const room = new Room(db);
  const calls: Call[] = [];
  const turns = {
    workTurn(input: WorkTurnInput, signal?: AbortSignal): Promise<TurnOutcome> {
      return new Promise((resolve, reject) => {
        const call: Call = { input, signal, finish: (o = {}) => resolve(o), fail: reject };
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        calls.push(call);
      });
    },
  };
  const config = defaultConfig();
  // Every agent works unless a test disables one.
  for (const name of SEED_AGENTS) config.adapters[name].enabled = !disabled.includes(name);
  const roster = testRoster(db, config);
  const threads = new Threads({ db, room, home: home.dir, roster, turns });
  const work: WorkEvent[] = [];
  threads.onWork((w) => work.push(w));
  threads.start();
  t.after(() => {
    threads.stop();
    db.close();
    home.cleanup();
  });
  return { home, db, room, threads, calls, work };
}

const tick = () => new Promise((r) => setImmediate(r));

function code(c: string) {
  return (err: unknown) => err instanceof LoungeError && err.code === c;
}

test("threads: owner starts a thread; the lead works at once", async (t) => {
  const h = setup(t);
  const info = h.threads.create("owner", { channel: "lounge", title: "Fix the build", brief: "npm test fails", lead: "ada" });
  assert.match(info.id, /^thread-[0-9a-f]{8}$/);
  assert.equal(info.parent, "lounge");
  assert.equal(info.cwd, join(h.home.dir, "work", info.id));
  assert.ok(existsSync(info.cwd));
  assert.equal(h.room.read("lounge").at(-1)!.text, "started a thread: Fix the build");
  const channels = h.room.channels();
  assert.deepEqual(channels.find((c) => c.id === info.id)?.parent, "lounge");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.input.agent, "ada");
  assert.equal(h.calls[0]!.input.cwd, info.cwd);
  assert.match(h.calls[0]!.input.brief, /^You lead the work thread "Fix the build" under #lounge/);
  assert.deepEqual(h.threads.work().map((w) => w.agent), ["ada"]);
  // A handoff line shows who delegates.
  assert.ok(h.room.read(info.id).some((m) => m.kind === "event" && m.text === "handed work to ada"));
});

test("threads: tool activity posts tool lines and work events", async (t) => {
  const h = setup(t);
  const info = h.threads.create("owner", { channel: "lounge", title: "Work", brief: "go", lead: "cyd" });
  h.calls[0]!.input.onActivity("Bash: npm test");
  const last = h.room.read(info.id).at(-1)!;
  assert.equal(last.kind, "tool");
  assert.equal(last.author, "cyd");
  assert.equal(last.text, "Bash: npm test");
  assert.equal(h.threads.work()[0]!.tool, "Bash: npm test");
  // Turn context skips tool lines.
  assert.ok(!h.room.read(info.id, { noTools: true }).some((m) => m.kind === "tool"));
  h.calls[0]!.finish();
  await tick();
  assert.deepEqual(h.threads.work(), []);
  assert.deepEqual(
    h.work.map((w) => [w.agent, w.active, w.tool ?? ""]),
    [
      ["cyd", true, ""],
      ["cyd", true, "Bash: npm test"],
      ["cyd", false, ""],
    ],
  );
});

test("threads: an agent mention hands work over; a busy agent runs again once", async (t) => {
  const h = setup(t);
  const info = h.threads.create("owner", { channel: "lounge", title: "Work", brief: "go", lead: "ada" });
  h.room.post("ada", info.id, "@bea check the tests please");
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1]!.input.agent, "bea");
  assert.match(h.calls[1]!.input.brief, /^ada handed you work/);
  assert.equal(h.room.read(info.id).at(-1)!.text, "handed work to bea");
  // Two more mentions while bea works: one rerun.
  h.room.post("ada", info.id, "@bea also lint");
  h.room.post("owner", info.id, "@bea and docs");
  assert.equal(h.calls.length, 2);
  h.calls[1]!.finish();
  await tick();
  assert.equal(h.calls.length, 3);
  assert.match(h.calls[2]!.input.brief, /^New messages came while you worked/);
  h.calls[2]!.finish();
  await tick();
  assert.equal(h.calls.length, 3);
});

test("threads: owner without a mention wakes the lead; agent text without one wakes nobody", async (t) => {
  const h = setup(t);
  const info = h.threads.create("owner", { channel: "lounge", title: "Work", brief: "go", lead: "ada" });
  h.calls[0]!.finish();
  await tick();
  h.room.post("cyd", info.id, "nice");
  assert.equal(h.calls.length, 1);
  h.room.post("owner", info.id, "keep going");
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1]!.input.agent, "ada");
});

test("threads: an agent starts a thread and leads it herself by default", (t) => {
  const h = setup(t);
  const info = h.threads.create("cyd", { channel: "lounge", title: "Research", brief: "find X, @dee help" });
  assert.equal(info.lead, "cyd");
  assert.deepEqual(h.calls.map((c) => c.input.agent), ["cyd", "dee"]);
  assert.match(h.calls[0]!.input.brief, /^You started the work thread/);
});

test("threads: halt stops every turn in the thread", async (t) => {
  const h = setup(t);
  const info = h.threads.create("owner", { channel: "lounge", title: "Work", brief: "go @cyd", lead: "ada" });
  assert.equal(h.calls.length, 2);
  assert.equal(h.threads.halt("owner", info.id), 2);
  await tick();
  assert.deepEqual(h.threads.work(), []);
  assert.equal(h.room.read(info.id).at(-1)!.text, "stopped the work");
  // A stopped turn posts no failure line.
  assert.ok(!h.room.read(info.id).some((m) => m.text.startsWith("could not finish")));
});

test("threads: a failed turn posts the reason", async (t) => {
  const h = setup(t);
  const info = h.threads.create("owner", { channel: "lounge", title: "Work", brief: "go", lead: "ada" });
  h.calls[0]!.fail(new Error("claude not found"));
  await tick();
  assert.equal(h.room.read(info.id).at(-1)!.text, "could not finish: claude not found");
});

test("threads: bad drafts are refused", (t) => {
  const h = setup(t);
  assert.throws(() => h.threads.create("owner", { channel: "nope", title: "x", brief: "y", lead: "ada" }), code("bad_thread"));
  assert.throws(() => h.threads.create("owner", { channel: "lounge", title: "", brief: "y", lead: "ada" }), code("bad_thread"));
  assert.throws(() => h.threads.create("owner", { channel: "lounge", title: "x", brief: " ", lead: "ada" }), code("bad_thread"));
  assert.throws(() => h.threads.create("owner", { channel: "lounge", title: "x", brief: "y" }), code("bad_thread"));
  assert.throws(
    () => h.threads.create("owner", { channel: "lounge", title: "x", brief: "y", lead: "ada", cwd: "relative/dir" }),
    code("bad_thread"),
  );
  assert.throws(() => h.room.createChannel("thread-abc", "owner"), code("bad_channel"));
});

test("threads: a disabled agent is skipped, and cannot lead", (t) => {
  const h = setup(t, ["dee"]);
  const info = h.threads.create("owner", { channel: "lounge", title: "Work", brief: "go", lead: "ada" });
  h.room.post("ada", info.id, "@dee help");
  assert.deepEqual(h.calls.map((c) => c.input.agent), ["ada"]);
  assert.throws(() => h.threads.create("owner", { channel: "lounge", title: "x", brief: "y", lead: "dee" }), code("forbidden"));
});

test("threads: a given cwd is used", (t) => {
  const h = setup(t);
  const info = h.threads.create("owner", { channel: "lounge", title: "Work", brief: "go", lead: "ada", cwd: h.home.dir });
  assert.equal(info.cwd, h.home.dir);
  assert.equal(h.calls[0]!.input.cwd, h.home.dir);
});

test("activity: tool lines from Claude", () => {
  assert.equal(toolLine("Bash", { command: "npm test", description: "run" }), "Bash: npm test");
  assert.equal(toolLine("Read", '{"file_path":"C:/x.ts"}'), "Read: C:/x.ts");
  assert.equal(toolLine("Think", {}), "Think");
  assert.equal(toolLine("Bash", { command: "a\n  b" }), "Bash: a b");
  assert.equal(toolLine("Bash", { command: "x".repeat(300) }).length, 160);
  assert.deepEqual(
    claudeToolLines({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Grep", input: { pattern: "foo" } }] },
    }),
    ["Grep: foo"],
  );
  assert.deepEqual(claudeToolLines({ type: "user", message: { content: [] } }), []);
  const lines: string[] = [];
  const feed = lineSplitter((l) => lines.push(l));
  feed('{"a":');
  feed('1}\n{"b":2}\n\n{"c"');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("prompt: work turns get the thread head and work rules", () => {
  const input = {
    agent: "ada" as const,
    brief: "B",
    channel: { id: "thread-1", topic: "", name: "Fix it", parent: "lounge" },
    work: { cwd: "C:/w" },
    context: [],
    mcpToken: "t",
    onSlow() {},
  };
  const head = turnText(input);
  assert.match(head, /^Thread: Fix it \(thread-1\) under #lounge$/m);
  assert.match(head, /^Working folder: C:\/w$/m);
  assert.match(systemText(input), /This is a work thread/);
  assert.doesNotMatch(systemText({ ...input, work: undefined }), /This is a work thread/);
});

test("threads: near lists the threads of the channel; similar finds a like title", async (t) => {
  const h = setup(t);
  h.room.createChannel("games", "owner");
  const a = h.threads.create("ada", { channel: "games", title: "Fix the lounge build", brief: "go" });
  const b = h.threads.create("cyd", { channel: "games", title: "Write docs", brief: "go" });
  h.threads.create("cyd", { channel: "lounge", title: "Fix the lounge build", brief: "go" });
  const near = h.threads.near("games");
  assert.deepEqual(near.map((x) => x.id).sort(), [a.id, b.id].sort());
  assert.deepEqual(h.threads.near(a.id).map((x) => x.id), [b.id], "a thread sees its siblings");
  assert.equal(h.threads.similar("games", "fix lounge build")?.id, a.id);
  assert.equal(h.threads.similar("games", "plan a party"), undefined);
  for (const c of h.calls) c.finish();
  await tick();
});

test("threads: a deleted room stops its runs with no event line", async (t) => {
  const h = setup(t);
  h.room.createChannel("games", "owner");
  const info = h.threads.create("ada", { channel: "games", title: "work", brief: "go" });
  await tick();
  assert.equal(h.calls.length, 1);
  h.room.deleteRoom("games");
  await tick();
  assert.equal(h.calls[0]!.signal?.aborted, true);
  assert.deepEqual(h.threads.work(), []);
  assert.equal(h.room.channel(info.id), undefined);
});

test("threads: a thread id as the channel creates in the parent", (t) => {
  const h = setup(t);
  h.room.createChannel("games", "owner");
  const first = h.threads.create("owner", { channel: "games", title: "Work", brief: "go", lead: "ada" });
  const second = h.threads.create("owner", { channel: first.id, title: "More", brief: "go", lead: "ada" });
  assert.equal(second.parent, "games");
  assert.deepEqual(h.threads.open("games").map((x) => x.id).sort(), [first.id, second.id].sort());
});

test("threads: a channel name resolves case-insensitively", (t) => {
  const h = setup(t);
  assert.equal(h.threads.create("owner", { channel: "LOUNGE", title: "Work", brief: "go", lead: "ada" }).parent, "lounge");
  assert.equal(h.threads.create("owner", { channel: "Lounge", title: "More", brief: "go", lead: "ada" }).parent, "lounge");
});

test("threads: an unknown channel fails with the valid ids and writes nothing", (t) => {
  const h = setup(t);
  h.room.createChannel("games", "owner");
  const rooms = () => h.db.prepare("SELECT COUNT(*) AS n FROM rooms").get()!.n;
  const rows = () => h.db.prepare("SELECT COUNT(*) AS n FROM threads").get()!.n;
  const before = [rooms(), rows()];
  for (const channel of ["nope", "session-1", "#"]) {
    assert.throws(
      () => h.threads.create("owner", { channel, title: "x", brief: "y", lead: "ada" }),
      (err: unknown) =>
        err instanceof LoungeError &&
        err.code === "bad_thread" &&
        err.message === `unknown channel: ${channel}. Valid channels: lounge, games`,
    );
  }
  assert.deepEqual([rooms(), rows()], before);
  assert.deepEqual(readdirSync(h.home.dir).filter((n) => n === "work"), []);
  assert.equal(h.calls.length, 0);
});

test("threads: an ambiguous channel name fails", (t) => {
  const h = setup(t);
  h.db.prepare("INSERT INTO rooms (id, name, topic) VALUES ('other', 'LOUNGE', '')").run();
  assert.throws(
    () => h.threads.create("owner", { channel: "lounge ", title: "x", brief: "y", lead: "ada" }),
    (err: unknown) => err instanceof LoungeError && err.code === "bad_thread",
  );
  assert.throws(
    () => h.threads.create("owner", { channel: "Lounge", title: "x", brief: "y", lead: "ada" }),
    (err: unknown) => err instanceof LoungeError && err.code === "bad_thread" && /Valid channels: lounge, other/.test(err.message),
  );
});

test("threads: open leaves out threads with no activity for 7 days", async (t) => {
  const h = setup(t);
  h.room.createChannel("games", "owner");
  const old = h.threads.create("owner", { channel: "games", title: "Old job", brief: "go", lead: "ada" });
  const fresh = h.threads.create("owner", { channel: "games", title: "New job", brief: "go", lead: "ada" });
  const stale = new Date(Date.now() - 8 * 86_400_000).toISOString();
  h.db.prepare("UPDATE threads SET created_at = ? WHERE room_id = ?").run(stale, old.id);
  h.db.prepare("UPDATE messages SET created_at = ? WHERE room_id = ?").run(stale, old.id);
  assert.deepEqual(
    h.threads.open("games").map((x) => x.id),
    [fresh.id],
  );
  for (const c of h.calls) c.finish();
  await tick();
});

test("threads: open lists threads of the channel, newest activity first, at most 8", async (t) => {
  const h = setup(t);
  h.room.createChannel("games", "owner");
  const made = Array.from({ length: 10 }, (_, i) =>
    h.threads.create("owner", { channel: "games", title: `Job ${i}`, brief: "go", lead: "ada" }),
  );
  h.threads.create("owner", { channel: "lounge", title: "Elsewhere", brief: "go", lead: "ada" });
  h.room.post("ada", made[0]!.id, "news");
  const open = h.threads.open("games");
  assert.equal(open.length, 8);
  assert.equal(open[0]!.id, made[0]!.id);
  assert.ok(open.every((x) => x.title !== "Elsewhere"));
  for (const c of h.calls) c.finish();
  await tick();
});
