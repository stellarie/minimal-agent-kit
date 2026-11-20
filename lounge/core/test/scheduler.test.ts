import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { defaultConfig, SEED_AGENTS, type Agent, type LoungeConfig } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import { Room } from "../src/lounge/room.ts";
import { mentions, Scheduler } from "../src/scheduler/scheduler.ts";
import type { TurnOutcome } from "../src/sessions/sessions.ts";
import type { Roster } from "../src/roster/roster.ts";
import { FakeTimers, tempHome, testRoster } from "./helpers.ts";

const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

type Action = "post" | "pass" | "fail" | "timeout" | "queue";
type Script = (agent: Agent, brief: string) => Action | Promise<Action>;

interface Harness {
  room: Room;
  roster: Roster;
  scheduler: Scheduler;
  timers: FakeTimers;
  turns: { agent: Agent; brief: string; roomId: string; signal?: AbortSignal }[];
  busy: Set<Agent>;
  clock: { ms: number };
  // Fire only the timer with this delay.
  fire(ms: number): void;
  restart(): Scheduler;
}

function setup(
  t: TestContext,
  script: Script,
  edit: (config: LoungeConfig) => void = () => {},
  random: () => number = () => 0,
): Harness {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  const room = new Room(db);
  const config = defaultConfig();
  config.scheduler.idleMs = 1_000_000;
  config.scheduler.jitterMs = 0;
  // Older tests expect one turn at a time.
  config.scheduler.maxConcurrent = 1;
  edit(config);
  const roster = testRoster(db, config);
  const timers = new FakeTimers();
  const clock = { ms: Date.parse("2026-11-06T12:00:00Z") };
  const turns: { agent: Agent; brief: string; roomId: string; signal?: AbortSignal }[] = [];
  const busy = new Set<Agent>();
  const fake = {
    busy: () => busy,
    async roomTurn(agent: Agent, roomId: string, brief: string, signal?: AbortSignal): Promise<TurnOutcome> {
      turns.push({ agent, brief, roomId, signal });
      const action = await script(agent, brief);
      if (action === "fail") throw new Error("claude exited 1");
      if (action === "queue") throw new Error("queue timeout");
      if (action === "timeout") throw new Error("dsh turn timed out");
      if (action === "pass") return {};
      return { message: room.post(agent, roomId, `${agent} says hi`) };
    },
  };
  const make = () =>
    new Scheduler({ db, room, turns: fake, config, roster, timers, now: () => new Date(clock.ms), random });
  let scheduler = make();
  scheduler.start();
  t.after(() => {
    scheduler.stop();
    db.close();
    home.cleanup();
  });
  return {
    room,
    roster,
    get scheduler() {
      return scheduler;
    },
    timers,
    turns,
    busy,
    clock,
    fire(ms) {
      for (const [id, entry] of timers.pending) {
        if (entry.ms !== ms) continue;
        timers.pending.delete(id);
        entry.fn();
        return;
      }
      assert.fail(`no timer with ${ms} ms`);
    },
    restart() {
      scheduler.stop();
      scheduler = make();
      return scheduler;
    },
  };
}

const passAll: Script = () => "pass";

test("mentions: finds each agent once, any case", () => {
  assert.deepEqual(mentions("hi @Cyd and @ada, @cyd!", SEED_AGENTS), ["cyd", "ada"]);
  assert.deepEqual(mentions("mail me@cyd.dev", SEED_AGENTS), ["cyd"]);
  assert.deepEqual(mentions("no names", SEED_AGENTS), []);
  assert.deepEqual(mentions("@cyd_x @cyd-x @cyd2", SEED_AGENTS), []);
});

test("scheduler: a retired agent gets no lead, follow-up, or ping", async (t) => {
  const h = setup(t, () => "post");
  h.roster.retire("cyd");
  h.room.post("owner", "lounge", "@cyd hey");
  h.fire(3_000);
  await tick();
  h.scheduler.announce("lounge", "movie night");
  await tick();
  assert.ok(h.turns.length > 0, "someone else answers");
  assert.equal(h.turns.some((x) => x.agent === "cyd"), false);
});

test("scheduler: owner's message starts one lead after the reply delay", async (t) => {
  const h = setup(t, passAll);
  h.room.post("owner", "lounge", "hey");
  assert.equal(h.turns.length, 0);
  h.fire(3_000);
  await tick();
  assert.equal(h.turns[0]?.agent, "ada");
  assert.match(h.turns[0]!.brief, /Reply to the owner/);
});

test("scheduler: a mention picks the lead", async (t) => {
  const h = setup(t, (agent) => (agent === "cyd" ? "post" : "pass"));
  h.room.post("owner", "lounge", "@cyd hey");
  h.fire(3_000);
  await tick();
  assert.equal(h.turns[0]?.agent, "cyd");
  assert.match(h.turns[0]!.brief, /mentioned you/);
  // Cyd posted, so Ada gets a follow-up.
  assert.equal(h.turns[1]?.agent, "ada");
  assert.match(h.turns[1]!.brief, /Post only if/);
  assert.equal(h.turns.length, 2);
});

test("scheduler: a lead that passes hands the reply to the next agent", async (t) => {
  const h = setup(t, (agent) => (agent === "ada" ? "pass" : "post"));
  h.room.post("owner", "lounge", "hey");
  h.fire(3_000);
  await tick();
  assert.deepEqual(
    h.turns.map((turn) => turn.agent),
    ["ada", "cyd", "ada"],
    "Ada passes, Cyd answers, Ada may follow up",
  );
  assert.match(h.turns[1]!.brief, /Reply to the owner/);
});

test("scheduler: follow-ups stop when everyone passes", async (t) => {
  let posts = 0;
  const h = setup(t, () => (posts++ < 2 ? "post" : "pass"));
  h.room.post("owner", "lounge", "hey");
  h.fire(3_000);
  await tick();
  // ada posts, cyd posts, ada passes.
  assert.deepEqual(
    h.turns.map((turn) => turn.agent),
    ["ada", "cyd", "ada"],
  );
});

test("scheduler: disabled, busy, and backoff agents are skipped", async (t) => {
  const h = setup(t, (agent) => (agent === "ada" ? "fail" : "pass"));
  h.room.post("owner", "lounge", "hey");
  h.fire(3_000);
  await tick();
  assert.deepEqual(
    h.turns.map((turn) => turn.agent),
    ["ada", "cyd"],
    "bea and dee are disabled",
  );
  h.room.post("owner", "lounge", "again");
  h.fire(3_000);
  await tick();
  assert.equal(h.turns.at(-1)?.agent, "cyd", "ada is in backoff");

  h.clock.ms += 31 * 60_000;
  h.busy.add("ada");
  h.room.post("owner", "lounge", "once more");
  h.fire(3_000);
  await tick();
  assert.equal(h.turns.at(-1)?.agent, "cyd", "ada is busy in a session");
});

test("scheduler: a timeout backs off for 10 minutes", async (t) => {
  const h = setup(t, (agent) => (agent === "ada" ? "timeout" : "pass"));
  h.room.post("owner", "lounge", "hey");
  h.fire(3_000);
  await tick();
  h.clock.ms += 11 * 60_000;
  h.room.post("owner", "lounge", "again");
  h.fire(3_000);
  await tick();
  assert.deepEqual(
    h.turns.map((turn) => turn.agent),
    ["ada", "cyd", "ada", "cyd"],
  );
});

test("scheduler: budgets cap turns per hour and per day", async (t) => {
  const h = setup(t, passAll, (config) => {
    config.scheduler.turnsPerHour = 3;
  });
  for (let i = 0; i < 3; i++) {
    h.room.post("owner", "lounge", `hey ${i}`);
    h.fire(3_000);
    await tick();
  }
  const before = h.turns.length;
  h.room.post("owner", "lounge", "over budget");
  h.fire(3_000);
  await tick();
  assert.equal(h.turns.length, before);
  h.clock.ms += 61 * 60_000;
  h.room.post("owner", "lounge", "next hour");
  h.fire(3_000);
  await tick();
  assert.ok(h.turns.length > before);

  const d = setup(t, passAll, (config) => {
    config.scheduler.turnsPerAgentPerDay = 1;
    config.adapters.cyd.enabled = false;
  });
  d.room.post("owner", "lounge", "one");
  d.fire(3_000);
  await tick();
  d.room.post("owner", "lounge", "two");
  d.fire(3_000);
  await tick();
  assert.equal(d.turns.length, 1);
});

test("scheduler: agent-only posts pause until owner speaks", async (t) => {
  const h = setup(t, () => "post", (config) => {
    config.scheduler.agentOnlyBeforePause = 3;
  });
  h.room.post("owner", "lounge", "talk");
  h.fire(3_000);
  await tick();
  assert.equal(h.turns.length, 3);
  assert.equal(h.scheduler.status().paused, true);
  h.room.post("owner", "lounge", "more");
  assert.equal(h.scheduler.status().paused, false);
});

const idleTimers = (h: Harness) => [...h.timers.pending].filter(([, p]) => p.ms === 1_000_000);

test("scheduler: idle wake runs one turn and moves with owner's messages", async (t) => {
  const h = setup(t, passAll);
  h.room.post("owner", "lounge", "anyone?");
  h.fire(3_000);
  await tick();
  const [first] = idleTimers(h);
  assert.equal(idleTimers(h).length, 1);
  h.room.post("owner", "lounge", "still here");
  assert.equal(idleTimers(h).length, 1);
  assert.notEqual(idleTimers(h)[0]![0], first![0], "owner's post moves the timer");
  h.fire(3_000);
  await tick();
  const before = h.turns.length;
  h.fire(1_000_000);
  await tick();
  assert.equal(h.turns.length, before + 1);
  assert.match(h.turns.at(-1)!.brief, /quiet/);
  assert.equal(idleTimers(h).length, 1, "the wake reschedules itself");
});

test("scheduler: an agent post does not move the idle timer", async (t) => {
  const h = setup(t, passAll);
  h.room.post("owner", "lounge", "hello");
  const [before] = idleTimers(h);
  h.room.post("ada", "lounge", "talking to myself");
  await tick();
  const after = idleTimers(h);
  assert.equal(after.length, 1);
  assert.equal(after[0]![0], before![0], "the timer is the one owner's post set");
});

test("scheduler: an idle wake still runs after the agent-only pause", async (t) => {
  const h = setup(t, () => "post", (config) => {
    config.scheduler.agentOnlyBeforePause = 3;
  });
  h.room.post("owner", "lounge", "talk");
  h.fire(3_000);
  await tick();
  assert.equal(h.turns.length, 3);
  assert.equal(h.scheduler.status().paused, true);
  h.fire(1_000_000);
  await tick();
  assert.equal(h.turns.length, 4);
  assert.match(h.turns.at(-1)!.brief, /quiet/);
});

test("scheduler: a skipped idle wake logs the reason", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  let release!: () => void;
  const held = new Promise<"pass">((resolve) => (release = () => resolve("pass")));
  const h = setup(t, () => held);
  h.busy.add("ada");
  h.busy.add("cyd");
  h.fire(1_000_000);
  await tick();
  assert.deepEqual(log.mock.calls.map((c) => c.arguments[0]), ["idle wake skipped: no candidate"]);
  h.busy.clear();
  h.room.post("owner", "lounge", "hey");
  h.fire(3_000);
  await tick();
  h.fire(1_000_000);
  assert.equal(log.mock.calls.at(-1)!.arguments[0], "idle wake skipped: busy");
  release();
  await tick();
});

test("scheduler: the toggle stops turns and survives a restart", async (t) => {
  const h = setup(t, () => "post");
  assert.equal(h.scheduler.status().enabled, true);
  h.scheduler.setEnabled(false);
  h.room.post("owner", "lounge", "hey");
  assert.equal(h.timers.pending.size, 0);
  const next = h.restart();
  next.start();
  assert.equal(next.status().enabled, false);
  next.setEnabled(true);
  h.room.post("owner", "lounge", "hey");
  h.fire(3_000);
  await tick();
  assert.equal(h.turns[0]?.agent, "ada");
});

test("scheduler: a lead dropped as busy hands over to the next agent", async (t) => {
  const h = setup(t, () => "post");
  h.room.post("owner", "lounge", "hey");
  // Ada is picked, then starts a session turn.
  h.busy.add("ada");
  h.fire(3_000);
  await tick();
  assert.equal(h.turns[0]?.agent, "cyd");
});

test("scheduler: a late reply to an older message does not count as an answer", async (t) => {
  let release!: () => void;
  const held = new Promise<"post">((resolve) => (release = () => resolve("post")));
  let adaTurns = 0;
  const h = setup(t, (agent) => {
    if (agent !== "ada") return "pass";
    adaTurns++;
    return adaTurns === 1 ? held : "pass";
  });
  h.room.post("owner", "lounge", "one");
  h.fire(3_000);
  await tick();
  h.room.post("owner", "lounge", "two");
  release();
  await tick();
  h.fire(3_000);
  await tick();
  const last = h.turns.at(-1)!;
  assert.equal(last.agent, "cyd");
  assert.match(last.brief, /Reply to the owner/,"ada's late post did not answer message two");
});

test("scheduler: a queue timeout gives no backoff", async (t) => {
  let calls = 0;
  const h = setup(t, (agent) => {
    calls++;
    return agent === "ada" && calls === 1 ? "queue" : "pass";
  });
  h.room.post("owner", "lounge", "hey");
  h.fire(3_000);
  await tick();
  h.room.post("owner", "lounge", "again");
  h.fire(3_000);
  await tick();
  assert.equal(h.turns.filter((turn) => turn.agent === "ada").length, 2);
});

test("scheduler: the toggle without start arms no idle timer", async (t) => {
  const h = setup(t, passAll);
  const lone = h.restart();
  lone.setEnabled(false);
  lone.setEnabled(true);
  assert.equal(h.timers.pending.size, 0);
});

test("scheduler: a message in another channel gets its reply there", async (t) => {
  const h = setup(t, (agent) => (agent === "ada" ? "post" : "pass"));
  h.room.createChannel("games", "owner");
  h.room.post("owner", "games", "hey");
  h.fire(3_000);
  await tick();
  assert.deepEqual(
    h.turns.map((turn) => [turn.agent, turn.roomId]),
    [
      ["ada", "games"],
      ["cyd", "games"],
    ],
  );
  assert.match(h.turns[0]!.brief, /#games/);
  assert.equal(h.room.read("games").at(-1)?.author, "ada");
});

test("scheduler: channel events and session rooms start no turn", async (t) => {
  const h = setup(t, passAll);
  h.room.setTopic("lounge", "snacks", "owner");
  h.room.createRoom("session-x", "work");
  h.room.post("owner", "session-x", "do the thing");
  await tick();
  assert.ok(![...h.timers.pending.values()].some((entry) => entry.ms === 3_000), "no reply timer");
  assert.equal(h.turns.length, 0);
});

test("scheduler: an announce pings every candidate, even the last speaker", async (t) => {
  const h = setup(t, passAll);
  h.room.post("ada", "lounge", "hi");
  await tick();
  h.turns.length = 0;
  h.scheduler.announce("lounge", "Movie night: bring snacks");
  await tick();
  assert.deepEqual(h.turns.map((turn) => turn.agent).sort(), ["ada", "cyd"]);
  for (const turn of h.turns) assert.match(turn.brief, /scheduled event starts now in channel #lounge: Movie night: bring snacks/);
});

const withBea = (config: LoungeConfig) => {
  config.adapters.bea.enabled = true;
};

test("scheduler: an agent post does answer owner's message", async (t) => {
  const h = setup(t, passAll, withBea);
  h.room.post("owner", "lounge", "hey");
  h.room.post("cyd", "lounge", "me too");
  await tick();
  h.turns.length = 0;
  h.fire(3_000);
  await tick();
  const leads = h.turns.filter((x) => /Reply to the owner/.test(x.brief));
  assert.equal(leads.length, 1, "the lead stops after the first pass");
});

test("scheduler: a ping plain text names the event", async (t) => {
  const h = setup(t, passAll);
  h.scheduler.announce("lounge", "Movie night: bring snacks");
  await tick();
  assert.ok(h.turns.length > 0);
  for (const turn of h.turns) {
    assert.match(turn.brief, /^A scheduled event starts now in channel #lounge: Movie night: bring snacks\. Everyone is pinged\./);
  }
});

test("scheduler: a post in a thread or session room starts no turn", async (t) => {
  const h = setup(t, passAll);
  h.room.createRoom("thread-x", "x");
  h.room.createRoom("session-x", "x");
  h.room.post("ada", "thread-x", "hi");
  h.room.post("ada", "session-x", "hi");
  await tick();
  assert.equal(h.turns.length, 0);
});

// A turn that waits until the test releases it.
function gate() {
  let open: () => void = () => {};
  const done = new Promise<void>((resolve) => (open = resolve));
  return { done, open: () => open() };
}

test("scheduler: turns in one channel run at the same time", async (t) => {
  const g = gate();
  const h = setup(t, async () => {
    await g.done;
    return "pass" as const;
  }, (c) => (c.scheduler.maxConcurrent = 3));
  const active = h.roster.active().map((e) => e.id).filter((id) => h.roster.ready(id));
  assert.ok(active.length >= 2);
  h.scheduler.announce("lounge", "movie night");
  await tick();
  const started = new Set(h.turns.map((x) => x.agent));
  assert.equal(started.size, Math.min(3, active.length), "pings start before any turn ends");
  assert.deepEqual([...h.scheduler.status().active].sort(), [...started].sort());
  g.open();
  await tick();
  assert.equal(new Set(h.turns.map((x) => x.agent)).size, active.length, "the rest start when a slot frees");
});

test("scheduler: an agent never runs two channel turns at once", async (t) => {
  const g = gate();
  const h = setup(t, async (agent, brief) => {
    if (agent === "ada" && /scheduled event/.test(brief)) await g.done;
    return agent === "ada" ? "pass" : "post";
  }, (c) => (c.scheduler.maxConcurrent = 4));
  h.scheduler.announce("lounge", "movie night");
  await tick();
  // The others posted, so Ada has a follow-up queued while her ping runs.
  assert.equal(h.turns.filter((x) => x.agent === "ada").length, 1);
  assert.ok(h.scheduler.status().queued.includes("ada"), "her follow-up waits, not dropped");
  g.open();
  await tick();
  const ada = h.turns.filter((x) => x.agent === "ada");
  assert.equal(ada.length, 2);
  assert.match(ada[1]!.brief, /Post only if/);
});

test("scheduler: maxConcurrent 1 runs one turn at a time", async (t) => {
  const g = gate();
  const h = setup(t, async () => {
    await g.done;
    return "pass" as const;
  });
  h.scheduler.announce("lounge", "movie night");
  await tick();
  assert.equal(h.turns.length, 1);
  g.open();
  await tick();
  assert.ok(h.turns.length > 1);
});

test("scheduler: a sequential channel runs one turn at a time", async (t) => {
  const g = gate();
  let now = 0;
  let most = 0;
  const h = setup(t, async () => {
    now += 1;
    most = Math.max(most, now);
    await g.done;
    now -= 1;
    return "pass" as const;
  }, (c) => (c.scheduler.maxConcurrent = 3));
  h.room.createChannel("quiet", "owner");
  h.room.setChannelSettings("quiet", { mode: "sequential" }, "owner");
  h.scheduler.announce("quiet", "movie night");
  await tick();
  assert.equal(h.turns.length, 1, "one turn starts");
  assert.ok(h.scheduler.status().queued.length >= 1, "the others wait in the queue");
  g.open();
  await tick();
  assert.ok(h.turns.length > 1, "the next turn starts when the first ends");
  assert.equal(most, 1, "never two turns at once in the channel");
});

test("scheduler: slow mode is a cooldown per agent; a lead does not wait", async (t) => {
  const h = setup(t, (_agent, brief) => (/scheduled event/.test(brief) ? "post" : "pass"), (c) => (c.scheduler.maxConcurrent = 4));
  h.room.createChannel("calm", "owner");
  h.room.setChannelSettings("calm", { slowSec: 120 }, "owner");
  const ready = h.roster.active().map((e) => e.id).filter((id) => h.roster.ready(id));
  h.scheduler.announce("calm", "movie night");
  await tick();
  assert.equal(h.turns.length, ready.length, "no one is on cooldown before the pings");
  assert.ok(h.scheduler.status().queued.length >= 1, "follow-ups wait for the cooldown");
  h.clock.ms += 120_000;
  h.fire(120_000);
  await tick();
  assert.ok(h.turns.length > ready.length, "follow-ups start after the cooldown");
  h.room.post(ready[0]!, "calm", "me first");
  await tick();
  const before = h.turns.length;
  h.room.post("owner", "calm", "hello?");
  h.fire(defaultConfig().scheduler.replyDelayMs);
  await tick();
  const lead = h.turns.slice(before);
  assert.ok(lead.length >= 1);
  assert.equal(lead[0]!.agent, ready[0], "the lead is the agent on cooldown");
  assert.match(lead[0]!.brief, /The owner wrote/, "the lead skips the cooldown");
});

test("scheduler: slow mode holds only the agent that posted", async (t) => {
  const h = setup(t, passAll, (c) => (c.scheduler.maxConcurrent = 4));
  h.room.createChannel("calm", "owner");
  h.room.setChannelSettings("calm", { slowSec: 120 }, "owner");
  const ready = h.roster.active().map((e) => e.id).filter((id) => h.roster.ready(id));
  h.room.post(ready[0]!, "calm", "hi");
  h.scheduler.announce("calm", "movie night");
  await tick();
  const started = new Set(h.turns.map((x) => x.agent));
  assert.ok(!started.has(ready[0]!), "the poster waits");
  assert.equal(started.size, ready.length - 1, "the others still talk");
});

test("scheduler: deleting a channel drops its queue and aborts its turns", async (t) => {
  const g = gate();
  const h = setup(t, async () => {
    await g.done;
    return "pass" as const;
  });
  h.room.createChannel("doomed", "owner");
  h.scheduler.announce("doomed", "movie night");
  await tick();
  assert.equal(h.turns.length, 1);
  assert.ok(h.scheduler.status().queued.length >= 1);
  h.room.deleteRoom("doomed");
  assert.deepEqual(h.scheduler.status().queued, [], "queued items of the room are gone");
  assert.ok(h.turns.every((x) => x.signal?.aborted === true), "running turns are aborted");
  g.open();
  await tick();
  assert.equal(h.turns.length, 1, "no new turn starts for the deleted room");
});
