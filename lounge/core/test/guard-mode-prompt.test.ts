import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { turnText } from "../src/adapters/prompt.ts";
import type { Adapter, ChatTurnInput, ChatTurnResult } from "../src/adapters/types.ts";
import { RestrictedTokens } from "../src/auth/restricted.ts";
import { defaultConfig } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import type { GuardMode } from "../src/guard/guardMode.ts";
import { Room } from "../src/lounge/room.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { tempHome, testRoster } from "./helpers.ts";

function input(patch: Partial<ChatTurnInput> = {}): ChatTurnInput {
  return { agent: "ada", brief: "Reply.", context: [], mcpToken: "t", onSlow: () => {}, ...patch };
}

test("c4_1: the turn text names the guard mode once for normal, auto, and bypass", () => {
  for (const mode of ["normal", "auto", "bypass"] as const) {
    const lines = turnText(input({ guardMode: mode, now: "2026-11-06T19:30:00+08:00" })).split("\n");
    const hits = lines.filter((l) => l.startsWith("Guard mode: "));
    assert.equal(hits.length, 1, mode);
    assert.match(hits[0]!, new RegExp(`^Guard mode: ${mode} \\(.+\\)$`));
    assert.ok(lines.indexOf(hits[0]!) < lines.indexOf("Now: 2026-11-06T19:30:00+08:00"), mode);
  }
  const lines = new Set(["normal", "auto", "bypass"].map((m) => turnText(input({ guardMode: m as GuardMode })).split("\n").find((l) => l.startsWith("Guard mode"))));
  assert.equal(lines.size, 3);
});

test("c4_1: no guard mode gives no guard line", () => {
  assert.doesNotMatch(turnText(input()), /Guard mode/);
});

class Recorder implements Adapter {
  readonly name = "claude" as const;
  inputs: ChatTurnInput[] = [];
  async available(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
  chatTurn(turn: ChatTurnInput): Promise<ChatTurnResult> {
    this.inputs.push(turn);
    return Promise.resolve({ kind: "pass" });
  }
}

async function turnWith(t: TestContext, guardMode: (() => GuardMode) | undefined, turns: number): Promise<ChatTurnInput[]> {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  const adapter = new Recorder();
  const config = defaultConfig();
  const sessions = new Sessions({
    db,
    room: new Room(db),
    home: home.dir,
    config,
    adapters: { get: () => adapter },
    roster: testRoster(db, config),
    restricted: new RestrictedTokens(),
    ...(guardMode ? { guardMode } : {}),
  });
  t.after(async () => {
    await sessions.shutdown();
    db.close();
    home.cleanup();
  });
  for (let i = 0; i < turns; i++) {
    await sessions.roomTurn("ada", "lounge", `turn ${i}`);
    for (let w = 0; w < 200 && adapter.inputs.length <= i; w++) await new Promise((r) => setImmediate(r));
  }
  return adapter.inputs;
}

test("c4_1: a session turn carries the guard mode read at the start of that turn", async (t) => {
  let mode: GuardMode = "auto";
  const inputs = await turnWith(t, () => mode, 1);
  assert.equal(inputs[0]!.guardMode, "auto");
  assert.match(turnText(inputs[0]!), /^Guard mode: auto \(/m);
  assert.equal((await turnWith(t, undefined, 1))[0]!.guardMode, undefined);
  mode = "bypass";
  assert.equal((await turnWith(t, () => mode, 1))[0]!.guardMode, "bypass");
});
