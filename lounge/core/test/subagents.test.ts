import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeSubagents } from "../src/adapters/activity.ts";
import { Subagents, type Subagent } from "../src/threads/subagents.ts";
import { collabEvents } from "../../plugins/codex/events.ts";

const NOW = () => new Date("2026-11-22T10:00:00Z");

function store(max?: number) {
  const s = new Subagents({ now: NOW, ...(max ? { max } : {}) });
  const seen: Subagent[] = [];
  s.onChange((e) => seen.push(e));
  return { s, seen };
}

test("subagents: a native subagent runs, then ends done or failed", () => {
  const { s, seen } = store();
  s.native("thread-1", "ada", { id: "toolu_1", title: "Find the tests", state: "running" });
  s.native("thread-1", "ada", { id: "toolu_2", title: "Read docs", state: "running" });
  s.native("thread-1", "ada", { id: "toolu_1", state: "done" });
  s.native("thread-1", "ada", { id: "toolu_2", state: "failed" });
  assert.deepEqual(
    s.list().map((e) => [e.kind, e.agent, e.title, e.state]),
    [
      ["native", "ada", "Find the tests", "done"],
      ["native", "ada", "Read docs", "failed"],
    ],
  );
  assert.equal(seen.length, 4);
  assert.equal(s.list()[0]!.roomId, "thread-1");
});

test("subagents: an end with no start and no title is ignored, and a repeat end sends nothing", () => {
  const { s, seen } = store();
  s.native("thread-1", "ada", { id: "toolu_x", state: "done" });
  assert.deepEqual(s.list(), []);
  s.native("thread-1", "ada", { id: "denied", title: "subagent", state: "failed" });
  assert.deepEqual(s.list().map((e) => [e.id, e.state]), [["denied", "failed"]]);
  s.removeRooms(["thread-1"]);
  seen.length = 0;
  s.native("thread-1", "ada", { id: "toolu_1", title: "a", state: "running" });
  s.native("thread-1", "ada", { id: "toolu_1", state: "done" });
  s.native("thread-1", "ada", { id: "toolu_1", state: "done" });
  assert.equal(seen.length, 2);
});

test("subagents: a turn end settles the native subagents still running", () => {
  const { s } = store();
  s.native("thread-1", "ada", { id: "a", title: "a", state: "running" });
  s.native("thread-1", "bea", { id: "b", title: "b", state: "running" });
  s.native("thread-2", "ada", { id: "c", title: "c", state: "running" });
  s.settle("thread-1", "ada", false);
  s.settle("thread-2", "ada", true);
  assert.deepEqual(
    s.list().map((e) => [e.id, e.state]),
    [
      ["a", "done"],
      ["b", "running"],
      ["c", "failed"],
    ],
  );
});

test("subagents: a child thread runs, then ends; a stop fails only a running child", () => {
  const { s } = store();
  s.child("thread-1", "ada", "thread-c1", "Write the parser");
  s.child("thread-1", "ada", "thread-c2", "Write the panel");
  s.childEnded("thread-c1", "done");
  s.childEnded("thread-c1", "failed");
  s.childEnded("thread-c2", "failed");
  assert.deepEqual(
    s.list().map((e) => [e.kind, e.threadId, e.title, e.state]),
    [
      ["child", "thread-c1", "Write the parser", "done"],
      ["child", "thread-c2", "Write the panel", "failed"],
    ],
  );
});

test("subagents: removed rooms drop their entries, and the list keeps the newest", () => {
  const { s } = store(3);
  s.child("thread-1", "ada", "thread-c1", "one");
  s.native("thread-2", "bea", { id: "n", title: "two", state: "running" });
  s.removeRooms(["thread-c1"]);
  assert.deepEqual(s.list().map((e) => e.title), ["two"]);
  s.removeRooms(["thread-2"]);
  assert.deepEqual(s.list(), []);
  for (const id of ["a", "b", "c", "d"]) s.native("thread-3", "ada", { id, title: id, state: "running" });
  assert.deepEqual(s.list().map((e) => e.id), ["b", "c", "d"]);
});

test("claudeSubagents: a Task or Agent tool_use starts one; its tool_result ends it", () => {
  assert.deepEqual(
    claudeSubagents({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "toolu_1", name: "Task", input: { description: "Find tests", prompt: "long text" } },
          { type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", id: "toolu_3", name: "Agent", input: { prompt: "Look at\nthe docs" } },
        ],
      },
    }),
    [
      { id: "toolu_1", title: "Find tests", state: "running" },
      { id: "toolu_3", title: "Look at", state: "running" },
    ],
  );
  assert.deepEqual(
    claudeSubagents({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
          { type: "tool_result", tool_use_id: "toolu_3", is_error: true, content: "no" },
        ],
      },
    }),
    [
      { id: "toolu_1", state: "done" },
      { id: "toolu_3", state: "failed" },
    ],
  );
  assert.deepEqual(claudeSubagents({ type: "result" }), []);
  assert.deepEqual(claudeSubagents(null), []);
});

test("collabEvents: a Codex spawn_agent item starts a subagent; agent states end it", () => {
  const started = JSON.stringify({
    type: "item.started",
    item: { id: "item_1", type: "collab_tool_call", tool: "spawn_agent", prompt: "Check the build\nnow", status: "in_progress" },
  });
  assert.deepEqual(collabEvents(started), [{ id: "item_1", title: "Check the build", state: "running" }]);
  const spawned = JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "collab_tool_call",
      tool: "spawn_agent",
      prompt: "Check the build",
      status: "completed",
      receiver_thread_ids: ["th_9"],
      agents_states: { th_9: { status: "running" } },
    },
  });
  // The spawn call ends, the agent still runs: the row takes its thread id.
  assert.deepEqual(collabEvents(spawned), [{ id: "item_1", title: "Check the build", alias: "th_9", state: "running" }]);
  const waited = JSON.stringify({
    type: "item.completed",
    item: { id: "item_2", type: "collab_tool_call", tool: "wait", status: "completed", agents_states: { th_9: { status: "completed" }, th_8: { status: "errored" } } },
  });
  assert.deepEqual(collabEvents(waited), [
    { id: "th_9", state: "done" },
    { id: "th_8", state: "failed" },
  ]);
  const denied = JSON.stringify({
    type: "item.completed",
    item: { id: "item_3", type: "collab_tool_call", tool: "spawn_agent", status: "failed" },
  });
  // A hook deny can end a spawn with no start: it still shows, as failed.
  assert.deepEqual(collabEvents(denied), [{ id: "item_3", title: "subagent", state: "failed" }]);
  assert.deepEqual(collabEvents('{"type":"item.completed","item":{"type":"command_execution"}}'), []);
  assert.deepEqual(collabEvents("not json"), []);
});

test("subagents: an alias lets a later event find a native subagent by a second id", () => {
  const { s } = store();
  s.native("thread-1", "cyd", { id: "item_1", title: "Check", state: "running" });
  s.native("thread-1", "cyd", { id: "item_1", alias: "th_9", state: "running" });
  s.native("thread-1", "cyd", { id: "th_9", state: "done" });
  assert.deepEqual(s.list().map((e) => [e.id, e.state]), [["item_1", "done"]]);
});
