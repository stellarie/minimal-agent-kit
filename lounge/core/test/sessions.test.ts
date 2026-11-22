import { Grants } from "../src/auth/grants.ts";
import { driveRoots } from "../src/guard/drives.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, ChatTurnInput, ChatTurnResult } from "../src/adapters/types.ts";
import { RestrictedTokens } from "../src/auth/restricted.ts";
import { defaultConfig, type LoungeConfig } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import { Attachments } from "../src/lounge/attachments.ts";
import { Room } from "../src/lounge/room.ts";
import { Sessions, type SessionsOptions } from "../src/sessions/sessions.ts";
import type { TimerApi } from "../src/sessions/slots.ts";
import { FakeTimers, SEED_CALLERS, tempHome, testRoster } from "./helpers.ts";

interface Turn {
  input: ChatTurnInput;
  signal: AbortSignal;
  resolve(result: ChatTurnResult): void;
  reject(err: Error): void;
}

class FakeAdapter implements Adapter {
  readonly name = "claude" as const;
  turns: Turn[] = [];

  async available(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true };
  }

  chatTurn(input: ChatTurnInput, signal: AbortSignal): Promise<ChatTurnResult> {
    return new Promise((resolve, reject) => {
      this.turns.push({ input, signal, resolve, reject });
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function setup(
  t: TestContext,
  opts: { config?: (c: LoungeConfig) => void; timers?: TimerApi; sessions?: Partial<SessionsOptions> } = {},
) {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  const room = new Room(db);
  const config = defaultConfig();
  opts.config?.(config);
  const adapter = new FakeAdapter();
  const adapters = { get: () => adapter };
  const roster = testRoster(db, config);
  const restricted = new RestrictedTokens();
  const attachments = new Attachments({ db, home: home.dir });
  const make = () =>
    new Sessions({
      db,
      room,
      home: home.dir,
      config,
      adapters,
      roster,
      restricted,
      attachments,
      timers: opts.timers,
      ...opts.sessions,
    });
  const sessions = make();
  t.after(async () => {
    for (const turn of adapter.turns) turn.reject(new Error("test end"));
    await sessions.shutdown();
    db.close();
    home.cleanup();
  });
  const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
  return { db, room, roster, sessions, adapter, restricted, config, make, count, attachments, homeDir: home.dir };
}

test("sessions: chat grants follow the spec table", async (t) => {
  const h = setup(t);
  for (const caller of ["owner", "ada", "cyd"] as const) {
    assert.equal(h.sessions.open(caller, { agent: "ada", kind: "chat", brief: "hi" }).state, "starting");
  }
  for (const caller of ["bea", "dee"] as const) {
    assert.throws(
      () => h.sessions.open(caller, { agent: "ada", kind: "chat", brief: "hi" }),
      { code: "forbidden" },
    );
  }
  assert.equal(h.count("SELECT COUNT(*) AS n FROM sessions"), 3);
});

test("sessions: disabled agent and work kind leave no row", (t) => {
  const h = setup(t);
  assert.throws(
    () => h.sessions.open("owner", { agent: "bea", kind: "chat", brief: "hi" }),
    { code: "forbidden", message: "bea is disabled" },
  );
  for (const caller of SEED_CALLERS) {
    assert.throws(
      () => h.sessions.open(caller, { agent: "ada", kind: "work", brief: "hi" }),
      { code: "unsupported" },
    );
  }
  assert.throws(
    () => h.sessions.open("owner", { agent: "nobody", kind: "chat", brief: "hi" }),
    { code: "unknown_agent" },
  );
  assert.equal(h.count("SELECT COUNT(*) AS n FROM sessions"), 0);
});

test("sessions: a bad brief leaves no row and no room", (t) => {
  const h = setup(t);
  for (const brief of ["", "x".repeat(8001)]) {
    assert.throws(
      () => h.sessions.open("owner", { agent: "ada", kind: "chat", brief }),
      { code: "bad_text" },
    );
  }
  assert.equal(h.count("SELECT COUNT(*) AS n FROM sessions"), 0);
  assert.equal(h.count("SELECT COUNT(*) AS n FROM rooms WHERE id LIKE 'session-%'"), 0);
});

test("sessions: a fourth turn waits for a free slot", async (t) => {
  const h = setup(t);
  const ids = [1, 2, 3, 4].map(
    (n) => h.sessions.open("owner", { agent: "ada", kind: "chat", brief: `b${n}` }).id,
  );
  await waitFor(() => h.adapter.turns.length === 3, "three turns");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.adapter.turns.length, 3);
  h.adapter.turns[0]!.resolve({ kind: "pass" });
  await waitFor(() => h.adapter.turns.length === 4, "the fourth turn");
  assert.equal(h.adapter.turns[3]!.input.brief, "b4");
  assert.equal(h.sessions.status(ids[0]!).state, "idle");
});

test("sessions: a queued turn past the timeout fails", async (t) => {
  const timers = new FakeTimers();
  const h = setup(t, { timers });
  const ids = [1, 2, 3, 4].map(
    (n) => h.sessions.open("owner", { agent: "ada", kind: "chat", brief: `b${n}` }).id,
  );
  await waitFor(() => h.adapter.turns.length === 3 && timers.pending.size === 1, "a queued turn");
  timers.fireAll();
  await waitFor(() => h.sessions.status(ids[3]!).state === "failed", "the failed state");
  assert.equal(h.sessions.status(ids[3]!).reason, "queue timeout");
});

test("sessions: an adapter rejection fails the session with its message", async (t) => {
  const h = setup(t);
  const { id } = h.sessions.open("owner", { agent: "ada", kind: "chat", brief: "hi" });
  await waitFor(() => h.adapter.turns.length === 1, "the turn");
  h.adapter.turns[0]!.reject(new Error("claude exited 2: boom"));
  await waitFor(() => h.sessions.status(id).state === "failed", "the failed state");
  assert.match(h.sessions.status(id).reason ?? "", /claude exited 2: boom/);
});

test("sessions: starting and running rows become detached on a new start", async (t) => {
  const h = setup(t);
  const a = h.sessions.open("owner", { agent: "ada", kind: "chat", brief: "a" });
  const b = h.sessions.open("owner", { agent: "ada", kind: "chat", brief: "b" });
  await waitFor(() => h.adapter.turns.length === 2, "two turns");
  h.adapter.turns[1]!.resolve({ kind: "pass" });
  await waitFor(() => h.sessions.status(b.id).state === "idle", "idle");
  void h.sessions.message("owner", b.id, "again");
  await waitFor(() => h.adapter.turns.length === 3, "the second turn");
  assert.equal(h.sessions.status(b.id).state, "running");
  await h.sessions.shutdown();
  assert.equal(h.sessions.status(a.id).state, "starting");
  assert.equal(h.sessions.status(b.id).state, "running");
  const next = h.make();
  assert.equal(next.status(a.id).state, "detached");
  assert.equal(next.status(b.id).state, "detached");
});

test("sessions: no turn starts after shutdown begins", async (t) => {
  const h = setup(t);
  const { id } = h.sessions.open("owner", { agent: "ada", kind: "chat", brief: "a" });
  await waitFor(() => h.adapter.turns.length === 1, "the turn");
  h.adapter.turns[0]!.resolve({ kind: "pass" });
  await waitFor(() => h.sessions.status(id).state === "idle", "idle");
  await h.sessions.shutdown();
  assert.throws(
    () => h.sessions.open("owner", { agent: "ada", kind: "chat", brief: "b" }),
    { code: "unsupported" },
  );
  await assert.rejects(h.sessions.message("owner", id, "x"), { code: "unsupported" });
  assert.equal(h.adapter.turns.length, 1);
});

test("sessions: a turn reply posts, and message returns it", async (t) => {
  const h = setup(t);
  const { id, roomId } = h.sessions.open("ada", { agent: "ada", kind: "chat", brief: "hi" });
  await waitFor(() => h.adapter.turns.length === 1, "the first turn");
  const first = h.adapter.turns[0]!;
  assert.equal(first.input.agent, "ada");
  assert.equal(first.input.context.at(-1)?.text, "hi");
  assert.notEqual(h.restricted.lookup(first.input.mcpToken), null);
  assert.equal(h.restricted.lookup(first.input.mcpToken)?.roomId, roomId, "the turn token names the turn room");
  first.resolve({ kind: "post", text: "hello" });
  await waitFor(() => h.sessions.status(id).state === "idle", "idle");
  assert.equal(h.restricted.lookup(first.input.mcpToken), null);
  assert.equal(h.room.read(roomId).at(-1)?.text, "hello");

  const pending = h.sessions.message("ada", id, "again");
  await waitFor(() => h.adapter.turns.length === 2, "the second turn");
  h.adapter.turns[1]!.resolve({ kind: "post", text: "reply two" });
  const result = await pending;
  assert.equal(result.reply?.text, "reply two");
  assert.equal(result.reply?.author, "ada");
  assert.equal(result.session.state, "idle");
});

test("sessions: closed, failed, and busy sessions refuse messages", async (t) => {
  const h = setup(t);
  const a = h.sessions.open("owner", { agent: "ada", kind: "chat", brief: "a" });
  await waitFor(() => h.adapter.turns.length === 1, "the turn");
  h.adapter.turns[0]!.resolve({ kind: "pass" });
  await waitFor(() => h.sessions.status(a.id).state === "idle", "idle");

  const first = h.sessions.message("owner", a.id, "one");
  await assert.rejects(h.sessions.message("owner", a.id, "two"), { code: "session_busy" });
  await waitFor(() => h.adapter.turns.length === 2, "the second turn");
  h.adapter.turns[1]!.resolve({ kind: "pass" });
  await first;

  h.sessions.close("owner", a.id);
  await assert.rejects(h.sessions.message("owner", a.id, "x"), { code: "session_closed" });

  const b = h.sessions.open("owner", { agent: "ada", kind: "chat", brief: "b" });
  await waitFor(() => h.adapter.turns.length === 3, "the third turn");
  h.adapter.turns[2]!.reject(new Error("broken"));
  await waitFor(() => h.sessions.status(b.id).state === "failed", "failed");
  await assert.rejects(h.sessions.message("owner", b.id, "x"), { code: "session_closed" });
  await assert.rejects(h.sessions.message("owner", "nope", "x"), { code: "unknown_session" });
});

test("sessions: only the opener or owner drives a session", async (t) => {
  const h = setup(t);
  const { id } = h.sessions.open("ada", { agent: "ada", kind: "chat", brief: "hi" });
  await waitFor(() => h.adapter.turns.length === 1, "the turn");
  h.adapter.turns[0]!.resolve({ kind: "pass" });
  await waitFor(() => h.sessions.status(id).state === "idle", "idle");
  await assert.rejects(h.sessions.message("bea", id, "x"), { code: "forbidden" });
  assert.throws(() => h.sessions.close("bea", id), { code: "forbidden" });
  assert.equal(h.sessions.status(id).state, "idle");
  assert.equal(h.sessions.close("owner", id).state, "closed");
});

test("sessions: close during a turn aborts it and stays closed", async (t) => {
  const h = setup(t);
  const { id } = h.sessions.open("owner", { agent: "ada", kind: "chat", brief: "hi" });
  await waitFor(() => h.adapter.turns.length === 1, "the turn");
  const turn = h.adapter.turns[0]!;
  assert.equal(h.sessions.close("owner", id).state, "closed");
  assert.equal(turn.signal.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.sessions.status(id).state, "closed");
  assert.equal(h.restricted.size, 0);
});

test("sessions: slow marks the agent until the turn ends", async (t) => {
  const h = setup(t);
  h.sessions.open("owner", { agent: "ada", kind: "chat", brief: "hi" });
  await waitFor(() => h.adapter.turns.length === 1, "the turn");
  const turn = h.adapter.turns[0]!;
  turn.input.onSlow();
  turn.input.onSlow();
  assert.deepEqual([...h.sessions.slow()], ["ada"]);
  turn.resolve({ kind: "pass" });
  await waitFor(() => h.sessions.slow().size === 0, "slow to clear");
});

test("sessions: list filters by state", async (t) => {
  const h = setup(t);
  const a = h.sessions.open("owner", { agent: "ada", kind: "chat", brief: "a" });
  h.sessions.open("owner", { agent: "cyd", kind: "chat", brief: "b" });
  h.sessions.close("owner", a.id);
  assert.equal(h.sessions.list().length, 2);
  assert.deepEqual(
    h.sessions.list("closed").map((s) => s.id),
    [a.id],
  );
});

test("sessions: a room turn shows typing and passes the channel topic", async (t) => {
  const h = setup(t);
  h.room.setTopic("lounge", "snacks", "owner");
  const events: string[] = [];
  h.room.onTyping((e) => events.push(`${e.caller}@${e.roomId}:${e.active}`));
  const outcome = h.sessions.roomTurn("ada", "lounge", "Reply to him.");
  await waitFor(() => h.adapter.turns.length === 1, "turn start");
  assert.deepEqual(h.adapter.turns[0]!.input.channel, { id: "lounge", name: "Lounge", topic: "snacks" });
  assert.deepEqual(h.room.typing(), [{ roomId: "lounge", caller: "ada", active: true }]);
  h.adapter.turns[0]!.resolve({ kind: "post", text: "hi" });
  await outcome;
  assert.deepEqual(events, ["ada@lounge:true", "ada@lounge:false"]);
});

test("sessions: a turn of an added agent gets her own runtime facts and the other enabled members", async (t) => {
  let h!: ReturnType<typeof setup>;
  h = setup(t, {
    sessions: {
      runtimeInfo: (entry) => ({ label: h.roster.kind(entry.runtime)!.label, model: entry.model || "default model" }),
    },
  });
  h.roster.add({ id: "nana", runtime: "stub", effort: "" });
  h.roster.update("cyd", { enabled: false });
  h.room.setNickname("nana", "Nana-chan");
  void h.sessions.roomTurn("nana", "lounge", "hi").catch(() => {});
  await waitFor(() => h.adapter.turns.length === 1, "chat turn");
  const input = h.adapter.turns[0]!.input;
  assert.deepEqual(input.self, {
    id: "nana",
    name: "Nana-chan",
    runtime: "Stub (fixed reply)",
    model: "default model",
    effort: "",
  });
  const expected = h.roster
    .active()
    .filter((e) => e.enabled && e.id !== "nana")
    .map((e) => e.id);
  assert.ok(expected.includes("ada") && !expected.includes("cyd"));
  assert.deepEqual(input.members?.map((m) => m.id), expected);
  assert.equal(input.members?.find((m) => m.id === "ada")?.name, "Ada");
  assert.equal(input.members?.find((m) => m.id === "ada")?.runtime, "claude-code");
});

test("sessions: a work turn gets the facts too", async (t) => {
  const h = setup(t, { sessions: { loungeRules: () => "Answer in haiku." } });
  void h.sessions
    .workTurn({ agent: "ada", roomId: "lounge", cwd: h.homeDir, brief: "work", onActivity: () => {} })
    .catch(() => {});
  await waitFor(() => h.adapter.turns.length === 1, "work turn");
  const work = h.adapter.turns[0]!.input;
  assert.equal(work.self?.id, "ada");
  assert.ok(work.members && work.members.length > 0 && work.members.every((m) => m.id !== "ada"));
  assert.equal(work.loungeRules, "Answer in haiku.");
});

test("sessions: each turn reads the lounge rules again, so a saved change reaches the next turn", async (t) => {
  let rules = "Answer in haiku.";
  const h = setup(t, { sessions: { loungeRules: () => rules } });
  void h.sessions.roomTurn("ada", "lounge", "one").catch(() => {});
  await waitFor(() => h.adapter.turns.length === 1, "first turn");
  assert.equal(h.adapter.turns[0]!.input.loungeRules, "Answer in haiku.");
  h.adapter.turns[0]!.resolve({ kind: "pass" });
  rules = "End every message with a cat face.";
  void h.sessions.roomTurn("ada", "lounge", "two").catch(() => {});
  await waitFor(() => h.adapter.turns.length === 2, "second turn");
  assert.equal(h.adapter.turns[1]!.input.loungeRules, "End every message with a cat face.");
});

test("sessions: a chat turn sees the newest messages up to the context limit", async (t) => {
  const h = setup(t, { config: (c) => (c.sessions.contextMessages = 3) });
  for (let i = 0; i < 4; i++) h.room.post("owner", "lounge", `old${i}`);
  h.room.post("owner", "lounge", "new1");
  void h.sessions.roomTurn("ada", "lounge", "hi").catch(() => {});
  await waitFor(() => h.adapter.turns.length === 1, "chat turn");
  const input = h.adapter.turns[0]!.input;
  assert.equal(input.context.length, 3);
  assert.ok(!input.context.some((m) => m.text === "old0"));
  assert.ok(input.context.some((m) => m.text === "new1"));
});

test("sessions: a file in context gets a local path with its extension", async (t) => {
  const h = setup(t);
  const { Attachments } = await import("../src/lounge/attachments.ts");
  const store = new Attachments({ db: h.db, home: h.homeDir });
  new Grants(h.db).set("ada", { pc: false });
  const att = store.save("owner", "cat.PNG", Buffer.from("png-bytes"), "image/png");
  store.markPosted([att]);
  h.room.post("owner", "lounge", "look", "text", [att]);
  void h.sessions.roomTurn("ada", "lounge", "hi").catch(() => {});
  await waitFor(() => h.adapter.turns.length === 1, "chat turn");
  const input = h.adapter.turns[0]!.input;
  const seen = input.context.find((m) => m.text === "look")!.attachments![0]!;
  assert.ok(seen.path!.endsWith(`${att.id}.png`));
  assert.equal(readFileSync(seen.path!, "utf8"), "png-bytes");
  assert.deepEqual(input.readDirs, [join(h.homeDir, "attachments")]);
});

test("sessions: a turn with no files still reads the attachments folder", async (t) => {
  const h = setup(t);
  new Grants(h.db).set("ada", { pc: false });
  h.room.post("owner", "lounge", "plain text");
  void h.sessions.roomTurn("ada", "lounge", "hi").catch(() => {});
  await waitFor(() => h.adapter.turns.length === 1, "chat turn");
  assert.deepEqual(h.adapter.turns[0]!.input.readDirs, [join(h.homeDir, "attachments")]);
});

test("sessions: the pc grant adds every drive root and the attachments folder", async (t) => {
  const h = setup(t);
  void h.sessions.roomTurn("ada", "lounge", "hi").catch(() => {});
  await waitFor(() => h.adapter.turns.length === 1, "chat turn");
  const input = h.adapter.turns[0]!.input;
  assert.deepEqual(input.readDirs, [...driveRoots(), join(h.homeDir, "attachments")]);
  assert.ok(input.allowedTools!.includes("Bash") && input.allowedTools!.includes("Write"));
});

test("sessions: a reply over the limit goes back to her with the limit, and the short one posts whole", async (t) => {
  const h = setup(t);
  const long = "a".repeat(2001);
  const outcome = h.sessions.roomTurn("ada", "lounge", "Reply to him.");
  await waitFor(() => h.adapter.turns.length === 1, "turn start");
  h.adapter.turns[0]!.resolve({ kind: "post", text: long });
  await waitFor(() => h.adapter.turns.length === 2, "the redo");
  const note = h.adapter.turns[1]!.input.brief;
  assert.ok(note.startsWith("Reply to him.\n"), "the brief stays first");
  assert.match(note, /not posted\. It has 2001 characters\. A post here has at most 2000 characters\./);
  assert.ok(note.includes(long), "she sees her draft");
  const short = "b".repeat(2000);
  h.adapter.turns[1]!.resolve({ kind: "post", text: short });
  const result = await outcome;
  assert.equal(result.message?.text, short);
  const texts = h.room.read("lounge").map((m) => m.text);
  assert.equal(texts.includes(long), false);
  assert.equal(texts.some((x) => x.endsWith("…")), false, "nothing is cut");
});

test("sessions: a reply still over the limit after two redos posts only an event", async (t) => {
  const h = setup(t);
  const before = h.room.read("lounge").length;
  const outcome = h.sessions.roomTurn("ada", "lounge", "Reply to him.");
  for (let i = 0; i < 3; i++) {
    await waitFor(() => h.adapter.turns.length === i + 1, `turn ${i + 1}`);
    h.adapter.turns[i]!.resolve({ kind: "post", text: "c".repeat(2500) });
  }
  const result = await outcome;
  assert.equal(result.message, undefined);
  const added = h.room.read("lounge").slice(before);
  assert.equal(added.length, 1);
  assert.equal(added[0]!.kind, "event");
  assert.match(added[0]!.text, /reply not posted: 2500 characters, the limit here is 2000/);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.adapter.turns.length, 3, "no fourth try");
});

test("sessions: a turn that already posted here with lounge_post does not post its final text again", async (t) => {
  const h = setup(t);
  const outcome = h.sessions.roomTurn("ada", "lounge", "Reply to him.");
  await waitFor(() => h.adapter.turns.length === 1, "turn start");
  h.room.post("ada", "lounge", "the real answer");
  h.adapter.turns[0]!.resolve({ kind: "post", text: "Posted to #lounge: the real answer" });
  const result = await outcome;
  assert.equal(result.message, undefined);
  assert.deepEqual(
    h.room.read("lounge").filter((m) => m.author === "ada").map((m) => m.text),
    ["the real answer"],
  );
});

// A file that a runtime made in the turn: an image of its image tool.
function turnFile(h: { homeDir: string }, name: string, bytes = "PNGDATA"): { name: string; path: string; mime: string } {
  const path = join(h.homeDir, `made-${name}`);
  writeFileSync(path, bytes);
  return { name, path, mime: "image/png" };
}

test("sessions: image files of a reply post as attachments of the reply and count as posted", async (t) => {
  const h = setup(t);
  const outcome = h.sessions.roomTurn("ada", "lounge", "Draw it.");
  await waitFor(() => h.adapter.turns.length === 1, "turn start");
  h.adapter.turns[0]!.resolve({ kind: "post", text: "here you go", files: [turnFile(h, "a.png", "ONE")] });
  const message = (await outcome).message!;
  assert.equal(message.text, "here you go");
  assert.equal(message.attachments?.length, 1);
  const att = message.attachments![0]!;
  assert.deepEqual([att.name, att.mime, att.size], ["a.png", "image/png", 3]);
  assert.equal(h.attachments.read(att.id).toString(), "ONE");
  assert.equal(h.attachments.get(att.id)?.id, att.id);
  assert.equal(h.attachments.rooms(att.id)[0], "lounge");
  assert.equal(h.db.prepare("SELECT posted FROM attachments WHERE id = ?").get(att.id)?.posted, 1, "the sweep keeps it");
  assert.equal(h.room.read("lounge").filter((m) => m.author === "ada").length, 1, "one message, not two");
});

test("sessions: a pass keeps its image files: they post with no text", async (t) => {
  const h = setup(t);
  const outcome = h.sessions.roomTurn("ada", "lounge", "Draw it.");
  await waitFor(() => h.adapter.turns.length === 1, "turn start");
  h.adapter.turns[0]!.resolve({ kind: "pass", files: [turnFile(h, "a.png")] });
  const message = (await outcome).message!;
  assert.equal(message.text, "");
  assert.equal(message.attachments?.length, 1);
});

test("sessions: an empty reply keeps its image files", async (t) => {
  const h = setup(t);
  const outcome = h.sessions.roomTurn("ada", "lounge", "Draw it.");
  await waitFor(() => h.adapter.turns.length === 1, "turn start");
  h.adapter.turns[0]!.resolve({ kind: "post", text: "  ", files: [turnFile(h, "a.png")] });
  assert.equal((await outcome).message?.attachments?.length, 1);
});

test("sessions: a turn that posted with lounge_post still posts its image files, and not its final text", async (t) => {
  const h = setup(t);
  const outcome = h.sessions.roomTurn("ada", "lounge", "Draw it.");
  await waitFor(() => h.adapter.turns.length === 1, "turn start");
  h.room.post("ada", "lounge", "the real answer");
  h.adapter.turns[0]!.resolve({ kind: "post", text: "Posted to #lounge: the real answer", files: [turnFile(h, "a.png")] });
  const message = (await outcome).message!;
  assert.equal(message.attachments?.length, 1);
  assert.deepEqual(
    h.room.read("lounge").filter((m) => m.author === "ada").map((m) => m.text),
    ["the real answer", ""],
  );
});

test("sessions: a redo keeps the image files of the first run and posts them once", async (t) => {
  const h = setup(t);
  const outcome = h.sessions.roomTurn("ada", "lounge", "Draw it.");
  await waitFor(() => h.adapter.turns.length === 1, "turn start");
  h.adapter.turns[0]!.resolve({ kind: "post", text: "a".repeat(2001), files: [turnFile(h, "a.png")] });
  await waitFor(() => h.adapter.turns.length === 2, "the redo");
  h.adapter.turns[1]!.resolve({ kind: "post", text: "short", files: [turnFile(h, "b.png")] });
  const message = (await outcome).message!;
  assert.equal(message.text, "short");
  assert.deepEqual(message.attachments?.map((a) => a.name), ["a.png", "b.png"]);
  assert.equal(h.room.read("lounge").filter((m) => m.author === "ada").length, 1);
});

test("sessions: a reply that stays over the limit still posts its image files with the event", async (t) => {
  const h = setup(t);
  const outcome = h.sessions.roomTurn("ada", "lounge", "Draw it.");
  for (let i = 0; i < 3; i++) {
    await waitFor(() => h.adapter.turns.length === i + 1, `turn ${i + 1}`);
    h.adapter.turns[i]!.resolve({ kind: "post", text: "c".repeat(2500), files: i === 0 ? [turnFile(h, "a.png")] : [] });
  }
  const result = await outcome;
  assert.equal(result.message?.attachments?.length, 1);
  const added = h.room.read("lounge").filter((m) => m.author === "ada");
  assert.deepEqual(added.map((m) => m.kind ?? "text"), ["event", "text"]);
});

test("sessions: a file that cannot be saved is skipped and the reply still posts", async (t) => {
  const h = setup(t);
  const outcome = h.sessions.roomTurn("ada", "lounge", "Draw it.");
  await waitFor(() => h.adapter.turns.length === 1, "turn start");
  const missing = { name: "gone.png", path: join(h.homeDir, "nowhere.png"), mime: "image/png" };
  const empty = turnFile(h, "empty.png", "");
  h.adapter.turns[0]!.resolve({ kind: "post", text: "text stays", files: [missing, empty, turnFile(h, "ok.png")] });
  const message = (await outcome).message!;
  assert.equal(message.text, "text stays");
  assert.deepEqual(message.attachments?.map((a) => a.name), ["ok.png"]);
});

test("sessions: a turn with only unsaveable files and no text posts nothing and does not fail", async (t) => {
  const h = setup(t);
  const outcome = h.sessions.roomTurn("ada", "lounge", "Draw it.");
  await waitFor(() => h.adapter.turns.length === 1, "turn start");
  h.adapter.turns[0]!.resolve({ kind: "pass", files: [{ name: "gone.png", path: join(h.homeDir, "nowhere.png"), mime: "image/png" }] });
  assert.equal((await outcome).message, undefined);
});

test("sessions: a work thread reply posts its image files too", async (t) => {
  const h = setup(t);
  const outcome = h.sessions.workTurn({
    agent: "ada",
    roomId: "lounge",
    cwd: h.homeDir,
    brief: "work",
    onActivity: () => {},
  });
  await waitFor(() => h.adapter.turns.length === 1, "work turn");
  h.adapter.turns[0]!.resolve({ kind: "post", text: "drawn", files: [turnFile(h, "a.png")] });
  await outcome;
  assert.equal(h.room.read("lounge").find((m) => m.text === "drawn")?.attachments?.length, 1);
});

test("sessions: a post in another room or by another agent keeps the final text", async (t) => {
  const h = setup(t);
  const outcome = h.sessions.roomTurn("ada", "lounge", "Reply to him.");
  await waitFor(() => h.adapter.turns.length === 1, "turn start");
  h.room.createRoom("games", "Games");
  h.room.post("ada", "games", "elsewhere");
  h.room.post("cyd", "lounge", "cyd here");
  h.room.post("ada", "lounge", "topic changed", "event");
  h.adapter.turns[0]!.resolve({ kind: "post", text: "my reply" });
  const result = await outcome;
  assert.equal(result.message?.text, "my reply");
});

test("sessions: a work turn keeps its final text after a progress post, so a hand-off still lands", async (t) => {
  const h = setup(t);
  const outcome = h.sessions.workTurn({
    agent: "ada",
    roomId: "lounge",
    cwd: h.homeDir,
    brief: "work",
    onActivity: () => {},
  });
  await waitFor(() => h.adapter.turns.length === 1, "work turn");
  h.room.post("ada", "lounge", "starting now");
  h.adapter.turns[0]!.resolve({ kind: "post", text: "done, @cyd take the tests" });
  await outcome;
  assert.ok(h.room.read("lounge").some((m) => m.text === "done, @cyd take the tests"));
});

test("sessions: a work thread reply still over the limit after two redos posts cut with a marker", async (t) => {
  const h = setup(t);
  const thread = h.room.createThread("lounge", "Scout", "owner");
  const outcome = h.sessions.workTurn({
    agent: "ada",
    roomId: thread.id,
    cwd: h.homeDir,
    brief: "work",
    onActivity: () => {},
  });
  for (let i = 0; i < 3; i++) {
    await waitFor(() => h.adapter.turns.length === i + 1, `turn ${i + 1}`);
    h.adapter.turns[i]!.resolve({ kind: "post", text: "c".repeat(1259) });
  }
  const result = await outcome;
  const posted = result.message;
  assert.ok(posted, "the reply is not lost");
  assert.equal(posted.text.length <= 1000, true);
  assert.match(posted.text, /^c+\n\[cut: 1259 characters, the limit here is 1000\]$/);
  assert.equal(h.room.read(thread.id).some((m) => m.kind === "event" && /not posted/.test(m.text)), false);
});
