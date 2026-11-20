import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openDb } from "../src/db/db.ts";
import { LoungeError, MAX_TEXT, Room, type Message } from "../src/lounge/room.ts";
import { tempHome } from "./helpers.ts";

function setup(t: TestContext, now?: () => Date): Room {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  t.after(() => {
    db.close();
    home.cleanup();
  });
  return new Room(db, now);
}

function loungeError(code: string, message?: string) {
  return (err: unknown) => {
    assert.ok(err instanceof LoungeError, "expected LoungeError");
    assert.equal(err.code, code);
    if (message !== undefined) assert.equal(err.message, message);
    return true;
  };
}

test("post then read returns the message with author and room", (t) => {
  const room = setup(t, () => new Date("2026-11-05T12:00:00.000Z"));
  const posted = room.post("ada", "lounge", "  hello  ");
  assert.equal(posted.author, "ada");
  assert.equal(posted.roomId, "lounge");
  assert.equal(posted.text, "  hello  ");
  assert.equal(posted.createdAt, "2026-11-05T12:00:00.000Z");
  assert.ok(Number.isInteger(posted.id) && posted.id > 0);
  assert.deepEqual(room.read("lounge"), [posted]);
});

test("read since excludes earlier ids", (t) => {
  const room = setup(t);
  const first = room.post("ada", "lounge", "one");
  const second = room.post("cyd", "lounge", "two");
  const third = room.post("dee", "lounge", "three");
  assert.deepEqual(
    room.read("lounge", { since: first.id }).map((m) => m.id),
    [second.id, third.id],
  );
  assert.deepEqual(room.read("lounge", { since: third.id }), []);
});

test("read without since returns the latest messages, oldest first", (t) => {
  const room = setup(t);
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) ids.push(room.post("ada", "lounge", `m${i}`).id);
  assert.deepEqual(
    room.read("lounge", { limit: 2 }).map((m) => m.id),
    ids.slice(3),
  );
});

test("read clamps limit to 200", (t) => {
  const room = setup(t);
  for (let i = 0; i < 205; i++) room.post("owner", "lounge", `m${i}`);
  assert.equal(room.read("lounge", { limit: 1000 }).length, 200);
  assert.equal(room.read("lounge").length, 50);
  assert.equal(room.read("lounge", { since: 0, limit: 1000 }).length, 200);
});

test("post rejects empty and whitespace-only text", (t) => {
  const room = setup(t);
  assert.throws(() => room.post("ada", "lounge", ""), loungeError("bad_text"));
  assert.throws(() => room.post("ada", "lounge", " \n\t "), loungeError("bad_text"));
  assert.deepEqual(room.read("lounge"), []);
});

test("post rejects text longer than 8000 in a session room", (t) => {
  const room = setup(t);
  assert.equal(MAX_TEXT, 8000);
  room.createRoom("session-long", "work");
  assert.throws(
    () => room.post("owner", "session-long", "a".repeat(8001)),
    loungeError("bad_text"),
  );
  const ok = room.post("ada", "session-long", "a".repeat(8000));
  assert.equal(ok.text.length, 8000);
});

test("post to unknown room", (t) => {
  const room = setup(t);
  assert.throws(
    () => room.post("ada", "nope", "hi"),
    loungeError("unknown_room", "unknown room: nope"),
  );
  assert.throws(() => room.read("nope"), loungeError("unknown_room", "unknown room: nope"));
});

test("onMessage fires once per post, and unsubscribe stops it", (t) => {
  const room = setup(t);
  const seen: Message[] = [];
  const unsubscribe = room.onMessage((m) => seen.push(m));
  const posted = room.post("bea", "lounge", "hi");
  assert.deepEqual(seen, [posted]);
  unsubscribe();
  room.post("bea", "lounge", "again");
  assert.equal(seen.length, 1);
});

test("who lists five callers, and touch sets lastSeen", (t) => {
  let clock = new Date("2026-11-05T10:00:00.000Z");
  const room = setup(t, () => clock);
  const before = room.who();
  assert.deepEqual(
    before.map((p) => p.caller).sort(),
    ["ada", "bea", "cyd", "dee", "owner"],
  );
  assert.ok(before.every((p) => p.lastSeen === null));
  room.touch("cyd");
  clock = new Date("2026-11-05T11:00:00.000Z");
  room.touch("cyd");
  const cyd = room.who().find((p) => p.caller === "cyd");
  assert.equal(cyd?.lastSeen, "2026-11-05T11:00:00.000Z");
  assert.equal(room.who().find((p) => p.caller === "ada")?.lastSeen, null);
});

test("createChannel slugs the name, posts an event, and lists the channel", (t) => {
  const room = setup(t);
  const seen: string[] = [];
  room.onChannel((c) => seen.push(c.id));
  const c = room.createChannel("Movie Night!", "owner", " films ");
  assert.deepEqual(c, { id: "movie-night", name: "movie-night", topic: "films" });
  assert.deepEqual(seen, ["movie-night"]);
  const [event] = room.read("movie-night");
  assert.equal(event?.kind, "event");
  assert.equal(event?.text, "created this channel. Topic: films");
  assert.deepEqual(room.channels().map((x) => x.id), ["lounge", "movie-night"]);
});

test("createChannel rejects bad, session, and duplicate names", (t) => {
  const room = setup(t);
  assert.throws(() => room.createChannel("!!!", "owner"), loungeError("bad_channel"));
  assert.throws(() => room.createChannel("session-x", "owner"), loungeError("bad_channel"));
  assert.throws(() => room.createChannel("Lounge", "owner"), loungeError("channel_exists"));
  assert.throws(() => room.createChannel("ok", "owner", "x".repeat(1025)), loungeError("bad_topic"));
});

test("channels hide session rooms", (t) => {
  const room = setup(t);
  room.createRoom("session-abc", "work");
  assert.deepEqual(room.channels().map((c) => c.id), ["lounge"]);
  assert.equal(room.channel("session-abc"), undefined);
});

test("setTopic posts one event per change and none for the same topic", (t) => {
  const room = setup(t);
  room.setTopic("lounge", "snacks", "ada");
  room.setTopic("lounge", " snacks ", "ada");
  room.setTopic("lounge", "", "owner");
  const events = room.read("lounge").map((m) => [m.author, m.kind, m.text]);
  assert.deepEqual(events, [
    ["ada", "event", "changed the channel topic: snacks"],
    ["owner", "event", "cleared the channel topic"],
  ]);
  assert.equal(room.channel("lounge")?.topic, "");
  assert.throws(() => room.setTopic("nope", "x", "ada"), loungeError("unknown_room"));
  assert.throws(() => room.setTopic("lounge", 5, "ada"), loungeError("bad_topic"));
});

test("setTyping counts overlapping turns and emits only on change", (t) => {
  const room = setup(t);
  const events: string[] = [];
  room.onTyping((e) => events.push(`${e.caller}@${e.roomId}:${e.active}`));
  room.setTyping("ada", "lounge", true);
  room.setTyping("ada", "lounge", true);
  assert.deepEqual(room.typing(), [{ roomId: "lounge", caller: "ada", active: true }]);
  room.setTyping("ada", "lounge", false);
  room.setTyping("ada", "lounge", false);
  room.setTyping("ada", "lounge", false);
  assert.deepEqual(events, ["ada@lounge:true", "ada@lounge:false"]);
  assert.deepEqual(room.typing(), []);
});

test("setNickname stores, announces in #lounge, and clears", (t) => {
  const room = setup(t);
  const seen: string[] = [];
  room.onNickname((n) => seen.push(`${n.caller}=${n.name}`));
  room.setNickname("ada", " Ada-sama ");
  room.setNickname("ada", "Ada-sama");
  room.setNickname("ada", "Queen");
  room.setNickname("ada", "");
  assert.deepEqual(seen, ["ada=Ada-sama", "ada=Queen", "ada="]);
  assert.deepEqual(
    room.read("lounge").map((m) => [m.kind, m.text]),
    [
      ["event", 'changed their name from ada to "Ada-sama"'],
      ["event", 'changed their name from "Ada-sama" to "Queen"'],
      ["event", "went back to their own name, ada"],
    ],
  );
  assert.deepEqual(room.nicknames(), {});
  room.setNickname("cyd", "Whale");
  assert.equal(room.who().find((w) => w.caller === "cyd")?.nickname, "Whale");
  assert.equal(room.who().find((w) => w.caller === "ada")?.nickname, undefined);
});

test("setNickname rejects long, multi-line, and non-string names", (t) => {
  const room = setup(t);
  assert.throws(() => room.setNickname("ada", "x".repeat(33)), loungeError("bad_nickname"));
  assert.throws(() => room.setNickname("ada", "a\nb"), loungeError("bad_nickname"));
  assert.throws(() => room.setNickname("ada", 7), loungeError("bad_nickname"));
  assert.deepEqual(room.read("lounge"), []);
});

test("renameChannel changes the name, keeps the id, and posts an event line", (t) => {
  const room = setup(t);
  room.createChannel("games", "owner");
  const seen: string[] = [];
  room.onChannel((c) => seen.push(`${c.id}:${c.name}`));
  const next = room.renameChannel("games", "  Game Night ", "owner");
  assert.deepEqual([next.id, next.name], ["games", "Game Night"]);
  assert.deepEqual(seen, ["games:Game Night"]);
  assert.equal(room.read("games").at(-1)!.text, "renamed the channel from games to Game Night");
  const before = room.read("games").length;
  room.renameChannel("games", "Game Night", "owner");
  assert.equal(room.read("games").length, before);
  const code = (c: string) => (err: unknown) => err instanceof LoungeError && err.code === c;
  for (const bad of ["", "x".repeat(33), "a\u000ab", 5]) {
    assert.throws(() => room.renameChannel("games", bad, "owner"), code("bad_channel"));
  }
  const thread = room.createThread("games", "Fix it", "owner");
  assert.throws(() => room.renameChannel(thread.id, "x", "owner"), code("unknown_room"));
  assert.throws(() => room.renameChannel("session-abc", "x", "owner"), code("unknown_room"));
});

test("a typing start counts as presence", (t) => {
  const room = setup(t, () => new Date("2026-11-06T14:00:00.000Z"));
  room.setTyping("cyd", "lounge", true);
  assert.equal(room.who().find((p) => p.caller === "cyd")?.lastSeen, "2026-11-06T14:00:00.000Z");
});

test("posts: 2000 characters in a channel for everyone, 1000 for an agent in a thread; events keep 8000", (t) => {
  const room = setup(t);
  assert.equal(room.post("ada", "lounge", "a".repeat(2000)).text.length, 2000);
  assert.throws(() => room.post("ada", "lounge", "a".repeat(2001)), loungeError("bad_text"));
  assert.throws(() => room.post("ext:bea", "lounge", "a".repeat(2001)), loungeError("bad_text"));
  assert.equal(room.post("owner", "lounge", "a".repeat(2000)).text.length, 2000);
  assert.throws(
    () => room.post("owner", "lounge", "a".repeat(2001)),
    loungeError("bad_text", "text has 2001 characters; a post here has at most 2000. Write it shorter and post again."),
  );
  const thread = room.createThread("lounge", "work", "ada");
  assert.equal(room.post("cyd", thread.id, "a".repeat(1000)).text.length, 1000);
  assert.throws(() => room.post("cyd", thread.id, "a".repeat(1001)), loungeError("bad_text"));
  assert.equal(room.post("owner", thread.id, "a".repeat(2000)).text.length, 2000);
  assert.throws(() => room.post("owner", thread.id, "a".repeat(2001)), loungeError("bad_text"));
  assert.equal(room.post("ada", "lounge", "a".repeat(8000), "event").text.length, 8000);
});

test("channel settings: mode and slow mode are stored, shown, and checked", (t) => {
  const room = setup(t);
  room.createChannel("games", "owner");
  assert.equal(room.channel("games")!.mode, undefined);
  const next = room.setChannelSettings("games", { mode: "sequential", slowSec: 120 }, "owner");
  assert.deepEqual(next, { id: "games", name: "games", topic: "", mode: "sequential", slowSec: 120 });
  assert.deepEqual(room.channel("games"), next);
  const back = room.setChannelSettings("games", { mode: "concurrent", slowSec: 0 }, "owner");
  assert.deepEqual(back, { id: "games", name: "games", topic: "" });
  for (const bad of [{ mode: "fast" }, { slowSec: -1 }, { slowSec: 1.5 }, { slowSec: 3601 }, { slowSec: "30" }]) {
    assert.throws(() => room.setChannelSettings("games", bad, "owner"), loungeError("bad_channel"), JSON.stringify(bad));
  }
  const thread = room.createThread("games", "work", "ada");
  assert.throws(() => room.setChannelSettings(thread.id, { mode: "sequential" }, "owner"), loungeError("unknown_room"));
});

test("deleteRoom removes a channel with its threads and rows, and keeps the lounge", (t) => {
  const room = setup(t);
  room.createChannel("games", "owner");
  const thread = room.createThread("games", "work", "ada");
  room.post("owner", "games", "hi");
  room.post("owner", thread.id, "hi");
  const removed: string[][] = [];
  room.onRemove((ids) => removed.push(ids));
  assert.deepEqual(room.deleteRoom("games"), ["games", thread.id]);
  assert.deepEqual(removed, [["games", thread.id]]);
  assert.equal(room.channel("games"), undefined);
  assert.equal(room.channel(thread.id), undefined);
  assert.throws(() => room.read("games"), loungeError("unknown_room"));
  assert.ok(room.read("lounge").every((m) => m.roomId === "lounge"));
  assert.throws(() => room.deleteRoom("lounge"), loungeError("forbidden"));
  assert.throws(() => room.deleteRoom("games"), loungeError("unknown_room"));
  const other = room.createThread("lounge", "side", "ada");
  assert.deepEqual(room.deleteRoom(other.id), [other.id], "a thread goes alone");
  assert.ok(room.channel("lounge"));
});

test("room: replyTo stores, reads back, and rejects another room's id", (t) => {
  const room = setup(t);
  room.createRoom("games", "Games");
  const first = room.post("owner", "lounge", "question?");
  const other = room.post("owner", "games", "elsewhere");
  const reply = room.post("ada", "lounge", "answer", "text", [], first.id);
  assert.equal(reply.replyTo, first.id);
  assert.equal(room.read("lounge").find((m) => m.id === reply.id)?.replyTo, first.id);
  assert.equal(room.read("lounge").find((m) => m.id === first.id)?.replyTo, undefined);
  assert.throws(() => room.post("ada", "lounge", "x", "text", [], other.id), { code: "bad_reply" });
  assert.throws(() => room.post("ada", "lounge", "x", "text", [], 99999), { code: "bad_reply" });
  const event = room.post("owner", "lounge", "changed the topic", "event");
  assert.throws(() => room.post("ada", "lounge", "x", "text", [], event.id), { code: "bad_reply" });
});
