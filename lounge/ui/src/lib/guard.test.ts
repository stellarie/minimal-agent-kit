import { test } from "node:test";
import assert from "node:assert/strict";
import type { Approval } from "./api.ts";
import { minutesLeft, newApprovals, outcomeLabel, panelSrc, sourceLabel } from "./guard.ts";

function approval(id: string): Approval {
  return {
    id,
    agent: "nana",
    tool: "Bash",
    summary: "rm -rf x",
    reason: "delete",
    createdAt: "2026-11-06T00:00:00Z",
    expiresAt: "2026-11-06T00:09:00Z",
  };
}

test("newApprovals returns only the cards the stack has not shown", () => {
  const next = [approval("a"), approval("b"), approval("c")];
  assert.deepEqual(
    newApprovals(["a"], next).map((a) => a.id),
    ["b", "c"],
  );
  assert.deepEqual(newApprovals(["a", "b", "c"], next), []);
  assert.equal(newApprovals([], next).length, 3);
});

test("minutesLeft rounds up and never goes below zero", () => {
  const now = Date.parse("2026-11-06T00:00:00Z");
  assert.equal(minutesLeft("2026-11-06T00:09:00Z", now), 9);
  assert.equal(minutesLeft("2026-11-06T00:00:10Z", now), 1);
  assert.equal(minutesLeft("2026-11-05T23:00:00Z", now), 0);
  assert.equal(minutesLeft("not a date", now), 0);
});

test("sourceLabel names the plugin behind a rule", () => {
  assert.equal(sourceLabel("rules"), "rules");
  assert.equal(sourceLabel("plugin:hello"), "plugin hello");
});

test("outcomeLabel gives a readable word", () => {
  assert.equal(outcomeLabel("timeout"), "Timed out");
  assert.equal(outcomeLabel("blocked"), "Blocked");
});

test("panelSrc accepts lounge paths and refuses everything else", () => {
  assert.equal(panelSrc("/plugins/hello/panel.html"), "/plugins/hello/panel.html");
  assert.equal(panelSrc("/plugins/../api/grants"), null);
  assert.equal(panelSrc("https://evil.example/x"), null);
  assert.equal(panelSrc("javascript:alert(1)"), null);
  assert.equal(panelSrc(undefined), null);
  assert.equal(panelSrc("data:text/html,<p>hi</p>"), null);
});
