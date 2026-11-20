import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import { Gates, openGate } from "../src/gates/gates.ts";
import { LoungeError, Room } from "../src/lounge/room.ts";
import { Threads } from "../src/lounge/threads.ts";
import { Children } from "../src/threads/children.ts";
import type { TurnOutcome, WorkTurnInput } from "../src/sessions/sessions.ts";
import { tempHome, testRoster } from "./helpers.ts";

interface Call {
  input: WorkTurnInput;
  finish(): void;
}

function setup(t: TestContext) {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  const room = new Room(db);
  const calls: Call[] = [];
  const turns = {
    workTurn(input: WorkTurnInput, signal?: AbortSignal): Promise<TurnOutcome> {
      return new Promise((resolve, reject) => {
        calls.push({ input, finish: () => resolve({}) });
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  };
  const roster = testRoster(db, defaultConfig());
  const threads = new Threads({ db, room, home: home.dir, roster, turns });
  threads.start();
  const gates = new Gates({ db, room, threads });
  const thread = threads.create("owner", { channel: "lounge", title: "Plan the lounge", brief: "go", lead: "ada" });
  // The lead's first turn ends, so a later turn is a new call.
  calls[0]!.finish();
  t.after(() => {
    threads.stop();
    db.close();
    home.cleanup();
  });
  const input = { agent: "ada", roomId: thread.id, phase: "design", summary: "The design is ready.", file: "design.md" };
  return { db, room, threads, gates, thread, calls, input };
}

const tick = () => new Promise((r) => setImmediate(r));

const posts = (h: ReturnType<typeof setup>) =>
  h.room.read(h.thread.id, { noTools: true }).filter((m) => m.author === "owner" && m.text.startsWith("@"));

test("c13_1_approve: the post says approved with the note and mentions the lead, and her turn starts", async (t) => {
  const h = setup(t);
  const open = openGate(h.gates, h.input);
  const [card] = h.gates.cards();
  assert.ok(card);
  await tick();
  const before = h.calls.length;
  h.gates.decide("owner", card.id, "approve", "looks right");
  assert.deepEqual(await open, { status: "approved", note: "looks right" });
  const [post] = posts(h);
  assert.equal(post?.text, "@ada approved: looks right");
  await tick();
  assert.equal(h.calls.length, before + 1);
  assert.equal(h.calls.at(-1)?.input.agent, "ada");
  assert.equal(h.calls.at(-1)?.input.roomId, h.thread.id);
  assert.deepEqual(h.gates.cards(), []);
});

test("c13_1_change: a change decision posts change requested with the note", async (t) => {
  const h = setup(t);
  const open = openGate(h.gates, h.input);
  const [card] = h.gates.cards();
  h.gates.decide("owner", card!.id, "change", "split slice 3");
  assert.deepEqual(await open, { status: "changed", note: "split slice 3" });
  assert.equal(posts(h)[0]?.text, "@ada change requested: split slice 3");
});

test("c13_1_decided_twice: the second decision gives conflict and posts nothing", async (t) => {
  const h = setup(t);
  void openGate(h.gates, h.input);
  const [card] = h.gates.cards();
  h.gates.decide("owner", card!.id, "approve", "ok");
  assert.throws(
    () => h.gates.decide("owner", card!.id, "change", "late"),
    (err) => err instanceof LoungeError && err.code === "conflict",
  );
  assert.equal(posts(h).length, 1);
  assert.throws(
    () => h.gates.decide("owner", "no-such-gate", "approve", ""),
    (err) => err instanceof LoungeError && err.code === "unknown_gate",
  );
});

test("c13_1_thread_stopped: a decision on a gate whose thread was stopped posts the record and starts no turn", async (t) => {
  const h = setup(t);
  const open = openGate(h.gates, h.input);
  const [card] = h.gates.cards();
  await tick();
  const before = h.calls.length;
  h.gates.stopRoom(h.thread.id);
  assert.equal((await open).status, "cancelled", "the call stops waiting");
  assert.equal(h.gates.cards().length, 1, "the card stays for a decision");
  h.gates.decide("owner", card!.id, "approve", "ok");
  await tick();
  const [post] = posts(h);
  assert.equal(post?.text, "@ada approved: ok");
  assert.equal(post?.kind, "event", "an event line starts no turn");
  assert.equal(h.calls.length, before);
  assert.deepEqual(h.gates.cards(), []);
});

test("c13_1_thread_stopped: a new gate in the thread ends the stop, so the next decision starts the lead", async (t) => {
  const h = setup(t);
  void openGate(h.gates, h.input);
  h.gates.stopRoom(h.thread.id);
  void openGate(h.gates, h.input);
  await tick();
  const before = h.calls.length;
  const [, second] = h.gates.cards();
  h.gates.decide("owner", second!.id, "approve", "");
  await tick();
  assert.equal(posts(h)[0]?.kind, undefined, "a text post starts the lead");
  assert.equal(h.calls.length, before + 1);
});

test("c13_1_thread_stopped: stopTree with the gates hook cancels the thread's open gate", async (t) => {
  const h = setup(t);
  const children = new Children({ db: h.db, room: h.room, threads: h.threads, onStop: (id) => h.gates.stopRoom(id) });
  const open = openGate(h.gates, h.input);
  await tick();
  children.stopTree("owner", h.thread.id);
  assert.equal((await open).status, "cancelled");
  const [card] = h.gates.cards();
  h.gates.decide("owner", card!.id, "approve", "");
  await tick();
  assert.equal(posts(h)[0]?.kind, "event", "the decision starts no turn");
});

test("SC27: an open gate sets the thread phase and shows one card; the owner approves; the thread gets approved with a mention of the lead", async (t) => {
  const h = setup(t);
  assert.equal(h.threads.info(h.thread.id)?.phase, undefined);
  const seen: number[] = [];
  h.gates.onChange((cards) => seen.push(cards.length));
  void openGate(h.gates, h.input);
  assert.equal(h.threads.info(h.thread.id)?.phase, "design");
  const [card] = h.gates.cards();
  assert.equal(card?.agent, "ada");
  assert.equal(card?.tool, "lounge_gate");
  assert.equal(card?.summary, "The design is ready.");
  assert.deepEqual(card?.gate, { phase: "design", file: "design.md", roomId: h.thread.id });
  h.gates.decide("owner", card!.id, "approve", "");
  assert.deepEqual(seen, [1, 0]);
  assert.equal(posts(h)[0]?.text, "@ada approved");
  assert.equal(h.threads.info(h.thread.id)?.phase, "design", "the phase stays after the decision");
});

test("SC27: an agent cannot decide a gate, not even its own", async (t) => {
  const h = setup(t);
  void openGate(h.gates, h.input);
  const [card] = h.gates.cards();
  assert.throws(
    () => h.gates.decide("ada", card!.id, "approve", "me"),
    (err) => err instanceof LoungeError && err.code === "forbidden",
  );
  assert.equal(h.gates.cards().length, 1);
});

test("SC28: a decided gate that is decided again gives conflict", async (t) => {
  const h = setup(t);
  void openGate(h.gates, h.input);
  const [card] = h.gates.cards();
  h.gates.decide("owner", card!.id, "approve", "");
  assert.throws(
    () => h.gates.decide("owner", card!.id, "approve", ""),
    (err) => err instanceof LoungeError && err.code === "conflict",
  );
});

test("gates: a bad decision, a long note, or a bad gate input is refused", (t) => {
  const h = setup(t);
  const bad = (code: string) => (err: unknown) => err instanceof LoungeError && err.code === code;
  assert.throws(() => openGate(h.gates, { ...h.input, roomId: "lounge" }), bad("bad_thread"));
  assert.throws(() => openGate(h.gates, { ...h.input, phase: " " }), bad("bad_gate"));
  assert.throws(() => openGate(h.gates, { ...h.input, summary: 7 }), bad("bad_gate"));
  void openGate(h.gates, h.input);
  const id = h.gates.cards()[0]!.id;
  assert.throws(() => h.gates.decide("owner", id, "maybe" as never, ""), bad("bad_gate"));
  assert.throws(() => h.gates.decide("owner", id, "approve", "x".repeat(5000)), bad("bad_gate"));
  assert.equal(h.gates.cards().length, 1);
});

test("gates: an aborted signal, a stopped room, and close cancel the open gate", async (t) => {
  const h = setup(t);
  const controller = new AbortController();
  const a = openGate(h.gates, h.input, controller.signal);
  controller.abort();
  assert.deepEqual(await a, { status: "cancelled", note: "" });
  assert.deepEqual(h.gates.cards(), []);
  const b = openGate(h.gates, h.input);
  h.gates.stopRoom(h.thread.id);
  assert.equal((await b).status, "cancelled");
  h.gates.close();
  const c = openGate(h.gates, h.input);
  const id = h.gates.cards()[0]!.id;
  h.gates.close();
  assert.equal((await c).status, "cancelled");
  assert.throws(
    () => h.gates.decide("owner", id, "approve", ""),
    (err) => err instanceof LoungeError && err.code === "conflict",
  );
  assert.equal(posts(h).length, 0);
});

test("gates: a gate open at a restart is cancelled, not shown again", (t) => {
  const h = setup(t);
  void openGate(h.gates, h.input);
  const again = new Gates({ db: h.db, room: h.room, threads: h.threads });
  assert.deepEqual(again.cards(), []);
});
