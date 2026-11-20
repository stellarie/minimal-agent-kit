import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OUTCOMES, outcomeLabel, sourceLabel } from "./guard.ts";
import { MODE_HELP, MODE_LABELS, NO_MODES_NOTE, TOOL_MODES, defaultMode, modeChoices } from "./toolModes.ts";

test("each of the four modes has a label and help text", () => {
  assert.deepEqual([...TOOL_MODES], ["read-only", "ask", "auto", "full"]);
  for (const mode of TOOL_MODES) {
    assert.ok(MODE_LABELS[mode].length > 0, `label of ${mode}`);
    assert.ok(MODE_HELP[mode].length > 0, `help of ${mode}`);
  }
  assert.equal(new Set(TOOL_MODES.map((m) => MODE_LABELS[m])).size, 4);
  assert.equal(NO_MODES_NOTE, "This runtime ignores tool modes.");
});

test("modeChoices gives all four modes for a runtime with support, and only full without", () => {
  assert.deepEqual(modeChoices(true), ["read-only", "ask", "auto", "full"]);
  assert.deepEqual(modeChoices(false), ["full"]);
  const all = modeChoices(true);
  all.pop();
  assert.equal(modeChoices(true).length, 4, "a caller cannot change the list");
});

// The lounge has no global checker: each runtime checks its own calls.
test("the auto help text names the agent's own model and the ask fallback", () => {
  assert.equal(MODE_HELP.auto, "The agent's own model checks each change. Risky ones come to you. A runtime that cannot check asks, as in Ask mode.");
  assert.ok(!/guard checker/i.test(MODE_HELP.auto));
});

test("a new agent starts in ask on a runtime with support, and in full without", () => {
  assert.equal(defaultMode(true), "ask");
  assert.equal(defaultMode(false), "full");
});

test("OUTCOMES labels auto-allowed, and the label differs from allowed", () => {
  assert.ok(OUTCOMES["auto-allowed"].length > 0);
  assert.notEqual(outcomeLabel("auto-allowed"), outcomeLabel("allowed"));
  assert.equal(outcomeLabel("auto-allowed"), OUTCOMES["auto-allowed"]);
});

test("the log names the mode and classifier sources", () => {
  assert.equal(sourceLabel("mode"), "tool mode");
  assert.equal(sourceLabel("classifier"), "classifier");
});

// The core list, read from its source file, so a new mode cannot miss the UI.
test("the mode list matches the core list", () => {
  const file = new URL("../../../core/src/guard/modes.ts", import.meta.url);
  const match = /export const TOOL_MODES: readonly ToolMode\[\] = \[(.+)\];/.exec(readFileSync(file, "utf8"));
  assert.ok(match, "core TOOL_MODES not found");
  const core = match[1]!.split(",").map((s) => s.trim().replace(/"/g, ""));
  assert.deepEqual(core, [...TOOL_MODES]);
});
