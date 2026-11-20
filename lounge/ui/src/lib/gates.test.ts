import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Approval } from "./api.ts";
import { changeReady, isGate, toastLine } from "./approvalToasts.ts";

const guard: Approval = {
  id: "g1",
  agent: "ada",
  tool: "Bash",
  summary: "rm -rf x",
  reason: "delete",
  createdAt: "2026-11-06T00:00:00Z",
  expiresAt: "2026-11-06T00:09:00Z",
};

const gate: Approval = {
  id: "gate1",
  agent: "ada",
  tool: "lounge_gate",
  summary: "The design is ready.",
  reason: "design: The design is ready.",
  createdAt: "2026-11-06T00:01:00Z",
  expiresAt: "",
  gate: { phase: "design", file: "design.md", roomId: "thread-1" },
};

test("SC27: a gate card is told from a guard card, and its line names the gate and the phase", () => {
  assert.equal(isGate(guard), false);
  assert.equal(isGate(gate), true);
  assert.equal(toastLine(gate, "Ada"), "Ada · gate · design: The design is ready.");
  assert.equal(toastLine(guard, "Ada"), "Ada · Bash · delete");
});

test("SC27: the Change button needs a note, and Approve needs none", () => {
  assert.equal(changeReady(""), false);
  assert.equal(changeReady("  \n "), false);
  assert.equal(changeReady("split slice 3"), true);
});

test("SC27: the client sends the decision to POST /api/gates/:id/decide, and the thread type carries the phase", () => {
  const api = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
  assert.match(api, /\/api\/gates\/\$\{encodeURIComponent\(id\)\}\/decide/);
  assert.match(api, /phase\?: string/);
});

test("SC27: the approval stack shows Approve and Change for a gate, and the header shows the phase of the thread", () => {
  const stack = readFileSync(new URL("../components/ApprovalStack.svelte", import.meta.url), "utf8");
  assert.match(stack, /isGate\(a\)/);
  assert.match(stack, />\s*Approve\s*</);
  assert.match(stack, />\s*Change\s*</);
  const app = readFileSync(new URL("../App.svelte", import.meta.url), "utf8");
  assert.match(app, /<PhaseHeader phase=\{thread\?\.phase\}/);
});
