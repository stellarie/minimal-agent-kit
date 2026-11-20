import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openDb } from "../src/db/db.ts";
import { Events, type LoungeEvent } from "../src/lounge/events.ts";
import { LoungeError, Room } from "../src/lounge/room.ts";
import { localIso } from "../src/adapters/prompt.ts";
import { FakeTimers, tempHome } from "./helpers.ts";

function setup(t: TestContext) {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  const room = new Room(db);
  const clock = { ms: Date.parse("2026-11-06T12:00:00Z") };
  const timers = new FakeTimers();
  const make = () => new Events({ db, room, timers, now: () => new Date(clock.ms) });
  const events = make();
  const fired: LoungeEvent[] = [];
  events.onFire((e) => fired.push(e));
  t.after(() => {
    events.stop();
    db.close();
    home.cleanup();
  });
  return { db, room, clock, timers, events, fired, make };
}

const inMinutes = (clock: { ms: number }, m: number) => new Date(clock.ms + m * 60_000).toISOString();

function code(c: string) {
  return (err: unknown) => err instanceof LoungeError && err.code === c;
}

test("events: create posts a line, and the due time fires once", (t) => {
  const h = setup(t);
  h.events.start();
  const e = h.events.create("cyd", { title: "Movie night", context: "Bring snacks", at: inMinutes(h.clock, 30) });
  assert.equal(e.state, "pending");
  assert.equal(e.roomId, "lounge");
  assert.match(h.room.read("lounge").at(-1)!.text, /^scheduled an event for .*: Movie night: Bring snacks$/);
  const [timer] = [...h.timers.pending.values()];
  assert.equal(timer?.ms, 30 * 60_000);
  h.clock.ms += 30 * 60_000;
  h.timers.fireAll();
  assert.equal(h.fired.length, 1);
  assert.equal(h.events.get(e.id)?.state, "fired");
  const last = h.room.read("lounge").at(-1)!;
  assert.deepEqual([last.author, last.kind, last.text], ["cyd", "event", "event starts now: Movie night: Bring snacks"]);
  assert.equal(h.timers.pending.size, 0);
});

test("events: a missed event fires late at start", (t) => {
  const h = setup(t);
  h.events.create("owner", { title: "Standup", at: inMinutes(h.clock, 5) });
  h.clock.ms += 60 * 60_000;
  h.events.start();
  h.timers.fireAll();
  assert.equal(h.fired.length, 1);
});

test("events: a far event waits in steps of one day", (t) => {
  const h = setup(t);
  h.events.start();
  h.events.create("owner", { title: "Birthday", at: inMinutes(h.clock, 60 * 24 * 40) });
  assert.equal([...h.timers.pending.values()][0]?.ms, 86_400_000);
  h.clock.ms += 86_400_000;
  h.timers.fireAll();
  assert.equal(h.fired.length, 0);
  assert.equal(h.timers.pending.size, 1, "re-armed");
});

test("events: validation", (t) => {
  const h = setup(t);
  assert.throws(() => h.events.create("ada", { title: "", at: inMinutes(h.clock, 5) }), code("bad_event"));
  assert.throws(() => h.events.create("ada", { title: "a\nb", at: inMinutes(h.clock, 5) }), code("bad_event"));
  assert.throws(() => h.events.create("ada", { title: "x", at: "soon" }), code("bad_event"));
  assert.throws(() => h.events.create("ada", { title: "x", at: inMinutes(h.clock, -1) }), code("bad_event"));
  assert.throws(() => h.events.create("ada", { title: "x", at: inMinutes(h.clock, 60 * 24 * 400) }), code("bad_event"));
  assert.throws(() => h.events.create("ada", { title: "x", context: "c".repeat(2001), at: inMinutes(h.clock, 5) }), code("bad_event"));
  assert.throws(() => h.events.create("ada", { room: "nope", title: "x", at: inMinutes(h.clock, 5) }), code("unknown_room"));
  assert.deepEqual(h.events.list(), []);
});

test("events: only the creator or owner cancels; a cancelled event never fires", (t) => {
  const h = setup(t);
  h.events.start();
  const e = h.events.create("ada", { title: "Nap", at: inMinutes(h.clock, 10) });
  assert.throws(() => h.events.cancel("cyd", e.id), code("forbidden"));
  assert.throws(() => h.events.cancel("cyd", 999), code("unknown_event"));
  assert.equal(h.events.cancel("owner", e.id).state, "cancelled");
  assert.throws(() => h.events.cancel("ada", e.id), code("bad_event"));
  assert.equal(h.timers.pending.size, 0);
  assert.match(h.room.read("lounge").at(-1)!.text, /^cancelled the event: Nap$/);
});

test("events: the list sorts pending events by time", (t) => {
  const h = setup(t);
  h.events.create("ada", { title: "Later", at: inMinutes(h.clock, 20) });
  h.events.create("ada", { title: "Sooner", at: inMinutes(h.clock, 10) });
  assert.deepEqual(h.events.list({ pending: true }).map((e) => e.title), ["Sooner", "Later"]);
});

test("localIso keeps the local zone offset", () => {
  const text = localIso(new Date("2026-11-06T12:00:00Z"));
  assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(new Date(text).getTime(), Date.parse("2026-11-06T12:00:00Z"));
});

test("events: a daily event fires and waits for the next day", (t) => {
  const h = setup(t);
  h.events.start();
  const e = h.events.create("owner", { title: "Check-in", at: inMinutes(h.clock, 10), repeat: "daily" });
  assert.equal(e.repeat, "daily");
  assert.match(h.room.read("lounge").at(-1)!.text, /repeats daily: Check-in$/);
  h.clock.ms += 10 * 60_000;
  h.timers.fireAll();
  assert.equal(h.fired.length, 1);
  const after = h.events.get(e.id)!;
  assert.equal(after.state, "pending");
  assert.equal(Date.parse(after.at) - Date.parse(e.at), 86_400_000);
  // Days missed while down post once.
  h.clock.ms += 3 * 86_400_000;
  h.timers.fireAll();
  assert.equal(h.fired.length, 2);
  assert.ok(Date.parse(h.events.get(e.id)!.at) > h.clock.ms);
});

test("events: nextTime skips weekends and keeps the day of the month", async () => {
  const { nextTime } = await import("../src/lounge/events.ts");
  const fri = new Date(2026, 10, 6, 9, 0);
  const mon = nextTime(fri, "weekdays", fri)!;
  assert.equal(mon.getDay(), 1);
  assert.equal(mon.getHours(), 9);
  const monthly = nextTime(new Date(2026, 0, 15, 9, 0), "monthly", new Date(2026, 0, 15, 9, 0))!;
  assert.deepEqual([monthly.getMonth(), monthly.getDate()], [1, 15]);
  assert.equal(nextTime(fri, "none", fri), undefined);
});

test("events: bad repeat values and late monthly days are refused", (t) => {
  const h = setup(t);
  assert.throws(() => h.events.create("owner", { title: "X", at: inMinutes(h.clock, 5), repeat: "hourly" }), code("bad_event"));
  const day30 = new Date(2026, 10, 30, 9, 0).toISOString();
  assert.throws(() => h.events.create("owner", { title: "X", at: day30, repeat: "monthly" }), code("bad_event"));
});
