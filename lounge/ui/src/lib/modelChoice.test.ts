import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { modelMode } from "./modelChoice.ts";

const panel = readFileSync(new URL("../components/AgentsPanel.svelte", import.meta.url), "utf8");

test("c9_1: an empty model is the runtime default", () => {
  assert.equal(modelMode("", ["a", "b"]), "default");
  assert.equal(modelMode("", []), "default");
});

test("c9_1: a model in the list is a pick, and any other text is custom", () => {
  assert.equal(modelMode("a", ["a", "b"]), "pick");
  assert.equal(modelMode("typed-by-hand", ["a", "b"]), "custom");
  assert.equal(modelMode("a", []), "custom");
});

test("c9_1: the agent editor has a model select with Custom and a Refresh button that reloads the plugins", () => {
  assert.match(panel, /<option value="">Runtime default<\/option>/);
  assert.match(panel, /Custom…/);
  assert.match(panel, /client\.reloadPlugins\(\)/);
  assert.match(panel, />Refresh</);
});
