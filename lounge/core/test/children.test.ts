import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { defaultConfig, SEED_AGENTS } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import { LoungeError, Room } from "../src/lounge/room.ts";
import { Threads } from "../src/lounge/threads.ts";
import { Children, MAX_DEPTH } from "../src/threads/children.ts";
import spawnTool from "../src/mcp/tools/lounge_spawn.ts";
import type { McpDeps } from "../src/mcp/server.ts";
import type { TurnOutcome, WorkTurnInput } from "../src/sessions/sessions.ts";
import { tempHome, testRoster } from "./helpers.ts";

interface Call {
  input: WorkTurnInput;
  finish(outcome?: TurnOutcome): void;
  fail(err: Error): void;
}

// Fake runtimes: a turn ends when the test says so. No model runs.
function setup(t: TestContext) {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  const room = new Room(db);
  const calls: Call[] = [];
  const turns = {
    workTurn(input: WorkTurnInput, signal?: AbortSignal): Promise<TurnOutcome> {
      return new Promise((resolve, reject) => {
        calls.push({ input, finish: (o = {}) => resolve(o), fail: reject });
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  };
  const config = defaultConfig();
  for (const name of SEED_AGENTS) config.adapters[name].enabled = true;
  const roster = testRoster(db, config);
  let children: Children | undefined;
  const threads = new Threads({
    db,
    room,
    home: home.dir,
    roster,
    turns,
    gate: (id, from) => children!.mayStart(id, from),
    onTurnEnd: (id, agent, end) => children!.turnEnded(id, agent, end),
  });
  children = new Children({ db, room, threads });
  threads.start();
  t.after(() => {
    threads.stop();
    db.close();
    home.cleanup();
  });
  // The open turn of an agent in a room.
  const turn = (agent: string, roomId: string) => {
    const call = calls.find((c) => c.input.agent === agent && c.input.roomId === roomId);
    assert.ok(call, `no turn of ${agent} in ${roomId}`);
    return call;
  };
  return { home, db, room, threads, children, calls, turn };
}

const tick = () => new Promise((r) => setImmediate(r));
const code = (c: string) => (err: unknown) => err instanceof LoungeError && err.code === c;
const deps = (h: ReturnType<typeof setup>) => ({ children: h.children, threads: h.threads }) as unknown as McpDeps;

function root(h: ReturnType<typeof setup>) {
  return h.threads.create("owner", { channel: "lounge", title: "Root", brief: "build it", lead: "ada" });
}

test("SC23: lounge_spawn from the lead makes a child thread with that lead under the parent in the tree", async (t) => {
  const h = setup(t);
  const top = root(h);
  const out = (await spawnTool.run({ agent: "cyd", brief: "explore the code" }, { caller: "ada", deps: deps(h) })) as {
    id: string;
  };
  const child = h.threads.info(out.id)!;
  assert.equal(child.lead, "cyd");
  assert.equal(child.cwd, top.cwd, "the child works in the parent folder");
  assert.equal(h.children.parentOf(child.id), top.id);
  assert.match(h.room.read(child.id).find((m) => m.kind === undefined)!.text, /^@cyd explore the code/);
  assert.ok(h.turn("cyd", child.id), "the brief wakes the child lead");
  const tree = h.children.tree(child.id);
  assert.equal(tree.id, top.id);
  assert.deepEqual(tree.children.map((c) => [c.id, c.lead, c.working]), [[child.id, "cyd", ["cyd"]]]);
  assert.deepEqual(tree.working, ["ada"]);
});

test("SC24: lounge_spawn with a name not in the roster returns an error and makes no thread", async (t) => {
  const h = setup(t);
  root(h);
  const before = h.threads.list().length;
  await assert.rejects(
    async () => spawnTool.run({ agent: "nobody", brief: "x" }, { caller: "ada", deps: deps(h) }),
    code("bad_thread"),
  );
  assert.equal(h.threads.list().length, before);
});

test("SC25: lounge_spawn in a thread at depth 2 returns depth cap", async (t) => {
  const h = setup(t);
  const top = root(h);
  const one = h.children.spawnChild("ada", top.id, { agent: "cyd", brief: "level one" });
  const two = h.children.spawnChild("cyd", one.id, { agent: "dee", brief: "level two" });
  assert.equal(h.children.depth(two.id), MAX_DEPTH);
  const before = h.threads.list().length;
  assert.throws(() => h.children.spawnChild("dee", two.id, { agent: "ada", brief: "too deep" }), /depth cap/);
  assert.equal(h.threads.list().length, before);
});

test("SC26: after the owner stops a parent with running children, no descendant starts a turn", async (t) => {
  const h = setup(t);
  const top = root(h);
  const one = h.children.spawnChild("ada", top.id, { agent: "cyd", brief: "one" });
  const two = h.children.spawnChild("cyd", one.id, { agent: "dee", brief: "two" });
  assert.equal(h.children.stopTree("owner", top.id), 3);
  await tick();
  assert.deepEqual(h.threads.work(), []);
  const count = h.calls.length;
  h.room.post("owner", one.id, "@cyd go on");
  h.room.post("ada", two.id, "@dee go on");
  assert.throws(() => h.children.spawnChild("cyd", one.id, { agent: "ada", brief: "again" }), /stopped/);
  await tick();
  assert.equal(h.calls.length, count, "no descendant turn started");
  // The owner may resume the parent itself; its children stay stopped.
  h.room.post("owner", top.id, "carry on");
  assert.equal(h.calls.length, count + 1);
  h.room.post("owner", one.id, "@cyd now?");
  assert.equal(h.calls.length, count + 1);
});

test("c15_1: a child's finish posts its reply into the parent and wakes the spawner exactly once", async (t) => {
  const h = setup(t);
  const top = root(h);
  const child = h.children.spawnChild("ada", top.id, { agent: "cyd", brief: "explore" });
  h.turn("ada", top.id).finish();
  await tick();
  const reply = h.room.post("cyd", child.id, "found three files");
  const wakesBefore = h.calls.filter((c) => c.input.agent === "ada").length;
  h.turn("cyd", child.id).finish({ message: reply });
  await tick();
  const reports = h.room.read(top.id).filter((m) => m.author === "cyd" && m.kind === undefined);
  assert.equal(reports.length, 1);
  assert.match(reports[0]!.text, /^@ada .*found three files/s);
  assert.equal(h.calls.filter((c) => c.input.agent === "ada").length, wakesBefore + 1, "the spawner woke once");
  // A later child turn does not report again.
  h.room.post("owner", child.id, "@cyd one more thing");
  await tick();
  h.calls.at(-1)!.finish({ message: h.room.post("cyd", child.id, "done too") });
  await tick();
  assert.equal(h.room.read(top.id).filter((m) => m.author === "cyd" && m.kind === undefined).length, 1);
  // The chain ends: no thread deeper than MAX_DEPTH.
  const two = h.children.spawnChild("cyd", child.id, { agent: "dee", brief: "deeper" });
  assert.throws(() => h.children.spawnChild("dee", two.id, { agent: "ada", brief: "x" }), /depth cap/);
});

test("c15_1: a self-spawn wakes the spawner, and a failed child turn still reports", async (t) => {
  const h = setup(t);
  const top = root(h);
  h.turn("ada", top.id).finish();
  await tick();
  const child = h.children.spawnChild("ada", top.id, { agent: "ada", brief: "split work" });
  h.turn("ada", child.id).fail(new Error("runtime crashed"));
  await tick();
  const report = h.room.read(top.id).filter((m) => m.author === "ada" && m.kind === undefined).at(-1)!;
  assert.match(report.text, /could not finish: runtime crashed/);
  assert.equal(h.calls.filter((c) => c.input.agent === "ada" && c.input.roomId === top.id).length, 2);
});

test("c15_1: a stopped child does not report", async (t) => {
  const h = setup(t);
  const top = root(h);
  const child = h.children.spawnChild("ada", top.id, { agent: "cyd", brief: "explore" });
  h.children.stopTree("owner", child.id);
  await tick();
  assert.equal(h.room.read(top.id).filter((m) => m.author === "cyd").length, 0);
});

test("c15_1: a halt after a finished loop round reports nothing", async (t) => {
  const h = setup(t);
  const top = root(h);
  const child = h.children.spawnChild("ada", top.id, { agent: "cyd", brief: "explore" });
  h.room.post("owner", child.id, "@cyd also this");
  h.turn("cyd", child.id).finish({ message: h.room.post("cyd", child.id, "half") });
  await tick();
  h.threads.halt("owner", child.id);
  await tick();
  assert.equal(h.room.read(top.id).filter((m) => m.author === "cyd").length, 0);
});

test("c15_1: when a helper ends last in a child, the lead's reply goes to the spawner", async (t) => {
  const h = setup(t);
  const top = root(h);
  const child = h.children.spawnChild("ada", top.id, { agent: "cyd", brief: "explore, @dee help" });
  h.turn("cyd", child.id).finish({ message: h.room.post("cyd", child.id, "lead result") });
  await tick();
  assert.equal(h.room.read(top.id).filter((m) => m.author === "cyd").length, 0, "a helper still runs");
  h.turn("dee", child.id).finish();
  await tick();
  const reports = h.room.read(top.id).filter((m) => m.author === "dee" || m.author === "cyd");
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.author, "cyd", "the child lead reports");
  assert.match(reports[0]!.text, /^@ada .*lead result/s);
});

test("c15_2: stopTree stops every live descendant", async (t) => {
  const h = setup(t);
  const top = root(h);
  const a = h.children.spawnChild("ada", top.id, { agent: "cyd", brief: "a" });
  const b = h.children.spawnChild("ada", top.id, { agent: "dee", brief: "b" });
  const a1 = h.children.spawnChild("cyd", a.id, { agent: "ada", brief: "a1" });
  assert.equal(h.threads.work().length, 4);
  h.children.stopTree("owner", top.id);
  await tick();
  assert.deepEqual(h.threads.work(), []);
  for (const id of [top.id, a.id, b.id, a1.id]) assert.equal(h.children.stopped(id), true, id);
  assert.equal(h.children.tree(top.id).children.every((c) => c.stopped), true);
});

test("c15_3: no child turn starts after an ancestor stops", async (t) => {
  const h = setup(t);
  const top = root(h);
  const one = h.children.spawnChild("ada", top.id, { agent: "cyd", brief: "one" });
  const two = h.children.spawnChild("cyd", one.id, { agent: "dee", brief: "two" });
  h.children.stopTree("owner", top.id);
  await tick();
  for (const id of [one.id, two.id]) {
    assert.equal(h.children.mayStart(id), false, id);
    assert.equal(h.children.mayStart(id, "owner"), false, id);
  }
});

test("lounge_spawn: a caller with no running turn has no parent thread", async (t) => {
  const h = setup(t);
  root(h);
  await assert.rejects(async () => spawnTool.run({ agent: "cyd", brief: "x" }, { caller: "dee", deps: deps(h) }), code("bad_thread"));
});

test("lounge_spawn: one turn spawns several children, even when a child has the spawner's own agent", async (t) => {
  const h = setup(t);
  const top = root(h);
  const ids: string[] = [];
  for (const brief of ["scout one", "scout two", "scout three"]) {
    const out = (await spawnTool.run(
      { agent: "ada", brief },
      { caller: "ada", roomId: top.id, deps: deps(h) },
    )) as { id: string };
    ids.push(out.id);
  }
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(h.children.childrenOf(top.id).sort(), [...ids].sort());
});

test("lounge_spawn: a child with the spawner's agent can spawn below itself", async (t) => {
  const h = setup(t);
  const top = root(h);
  const one = h.children.spawnChild("ada", top.id, { agent: "ada", brief: "scout" });
  const out = (await spawnTool.run(
    { agent: "cyd", brief: "dig" },
    { caller: "ada", roomId: one.id, deps: deps(h) },
  )) as { id: string };
  assert.equal(h.children.parentOf(out.id), one.id);
});

test("lounge_spawn: a turn token of a room with no running turn of the caller cannot spawn", async (t) => {
  const h = setup(t);
  const top = root(h);
  h.turn("ada", top.id).finish();
  await tick();
  await assert.rejects(
    async () => spawnTool.run({ agent: "cyd", brief: "x" }, { caller: "ada", roomId: top.id, deps: deps(h) }),
    code("bad_thread"),
  );
  await assert.rejects(
    async () => spawnTool.run({ agent: "cyd", brief: "x" }, { caller: "ada", roomId: "lounge", deps: deps(h) }),
    code("bad_thread"),
  );
});

test("lounge_spawn: with no turn room and two running threads the parent stays ambiguous", async (t) => {
  const h = setup(t);
  const top = root(h);
  h.children.spawnChild("ada", top.id, { agent: "ada", brief: "scout" });
  await assert.rejects(async () => spawnTool.run({ agent: "cyd", brief: "x" }, { caller: "ada", deps: deps(h) }), code("bad_thread"));
});

test("c15_1: a child reply near the room limit still reaches the spawner", async (t) => {
  const h = setup(t);
  const top = root(h);
  const child = h.children.spawnChild("ada", top.id, { agent: "cyd", brief: "explore" });
  h.turn("ada", top.id).finish();
  await tick();
  const long = "x".repeat(990);
  const reply = h.room.post("cyd", child.id, long);
  h.turn("cyd", child.id).finish({ message: reply });
  await tick();
  const reports = h.room.read(top.id).filter((m) => m.author === "cyd" && m.kind === undefined);
  assert.equal(reports.length, 1);
  assert.ok(reports[0]!.text.includes(long));
});
