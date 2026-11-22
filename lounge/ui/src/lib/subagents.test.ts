import { test } from "node:test";
import assert from "node:assert/strict";
import type { Subagent } from "./api.ts";
import { byAgent, dropRooms, upsertSubagent } from "./subagents.ts";

function sub(over: Partial<Subagent>): Subagent {
  return {
    key: "native|t1|ada|x",
    roomId: "t1",
    agent: "ada",
    kind: "native",
    id: "x",
    title: "Find tests",
    state: "running",
    since: "2026-11-22T10:00:00.000Z",
    ...over,
  };
}

test("upsertSubagent adds a new key and replaces a known one", () => {
  let list: Subagent[] = [];
  list = upsertSubagent(list, sub({}));
  list = upsertSubagent(list, sub({ key: "child|c1", kind: "child", id: "c1", threadId: "c1", title: "Panel" }));
  list = upsertSubagent(list, sub({ state: "done" }));
  assert.deepEqual(list.map((s) => [s.key, s.state]), [
    ["native|t1|ada|x", "done"],
    ["child|c1", "running"],
  ]);
});

test("dropRooms removes rows of a deleted room or child thread", () => {
  const list = [
    sub({}),
    sub({ key: "child|c1", roomId: "t2", kind: "child", threadId: "c1" }),
    sub({ key: "native|t3|bea|y", roomId: "t3", agent: "bea" }),
  ];
  assert.deepEqual(dropRooms(list, ["t1", "c1"]).map((s) => s.key), ["native|t3|bea|y"]);
});

test("byAgent groups per agent, running rows first, then newest", () => {
  const list = [
    sub({ key: "a", since: "2026-11-22T10:00:00.000Z", state: "done" }),
    sub({ key: "b", agent: "bea", since: "2026-11-22T10:01:00.000Z" }),
    sub({ key: "c", since: "2026-11-22T10:02:00.000Z", state: "failed" }),
    sub({ key: "d", since: "2026-11-22T09:00:00.000Z" }),
  ];
  assert.deepEqual(
    byAgent(list).map((g) => [g.agent, g.items.map((s) => s.key), g.running]),
    [
      ["ada", ["d", "c", "a"], 1],
      ["bea", ["b"], 1],
    ],
  );
  assert.deepEqual(byAgent([]), []);
});
