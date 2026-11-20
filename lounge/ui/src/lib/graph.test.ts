import { test } from "node:test";
import assert from "node:assert/strict";
import { graphRows } from "./graph.ts";
import type { ThreadTree } from "./api.ts";

const leaf = (id: string, lead: string, over: Partial<ThreadTree> = {}): ThreadTree => ({
  id,
  name: id,
  lead,
  stopped: false,
  working: [],
  children: [],
  ...over,
});

test("SC23: graphRows shows a spawned child under its parent, in tree order with depth", () => {
  const tree = leaf("root", "ada", { children: [leaf("a", "cyd", { children: [leaf("a1", "dee")] }), leaf("b", "dee")] });
  assert.deepEqual(
    graphRows(tree, []).map((r) => [r.id, r.lead, r.depth]),
    [["root", "ada", 0], ["a", "cyd", 1], ["a1", "dee", 2], ["b", "dee", 1]],
  );
});

test("SC23: graphRows takes live work over the fetched tree, and a stop over both", () => {
  const tree = leaf("root", "ada", {
    working: ["ada"],
    children: [leaf("a", "cyd"), leaf("b", "dee", { stopped: true, working: ["dee"] })],
  });
  const rows = graphRows(tree, [{ agent: "cyd", roomId: "a" }]);
  assert.deepEqual(rows.map((r) => [r.id, r.state, r.agents]), [
    ["root", "idle", []],
    ["a", "working", ["cyd"]],
    ["b", "stopped", []],
  ]);
  // Before live work arrives, the fetched tree counts.
  assert.equal(graphRows(tree, undefined)[0]!.state, "working");
});
