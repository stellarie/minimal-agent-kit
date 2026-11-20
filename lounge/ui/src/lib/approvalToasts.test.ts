import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Approval } from "./api.ts";
import { DANGER_WORD, isDanger, MAX_LINE_REASON, MAX_TOAST_WIDTH, MAX_TOASTS, toastBottom, toastLine, toastSpan, visibleToasts } from "./approvalToasts.ts";

function approval(id: string, reason = "delete"): Approval {
  return {
    id,
    agent: "nana",
    tool: "Bash",
    summary: "rm -rf x",
    reason,
    createdAt: "2026-11-06T00:00:00Z",
    expiresAt: "2026-11-06T00:09:00Z",
  };
}

function many(n: number): Approval[] {
  return Array.from({ length: n }, (_, i) => approval(`a${i}`));
}

test("visibleToasts shows every approval up to the limit", () => {
  for (const n of [0, 1, MAX_TOASTS]) {
    const { shown, more } = visibleToasts(many(n));
    assert.equal(shown.length, n);
    assert.equal(more, 0);
  }
});

test("visibleToasts keeps the oldest three and counts the rest", () => {
  const { shown, more } = visibleToasts(many(5));
  assert.deepEqual(
    shown.map((a) => a.id),
    ["a0", "a1", "a2"],
  );
  assert.equal(more, 2);
});

test("toastLine holds the agent name, the tool, and the reason", () => {
  const line = toastLine(approval("a", "delete the build folder"), "Nana");
  assert.ok(line.includes("Nana"));
  assert.ok(line.includes("Bash"));
  assert.ok(line.includes("delete the build folder"));
  assert.ok(!line.includes("\n"));
});

test("toastLine ends a long reason with an ellipsis", () => {
  const long = "x".repeat(MAX_LINE_REASON + 1);
  const line = toastLine(approval("a", long), "Nana");
  assert.ok(line.endsWith("…"));
  assert.ok(!line.includes(long));
  const exact = "y".repeat(MAX_LINE_REASON);
  assert.ok(toastLine(approval("a", exact), "Nana").endsWith(exact));
});

test("toastLine folds line breaks in the reason", () => {
  assert.ok(toastLine(approval("a", "one\n  two"), "Nana").endsWith("one two"));
});

test("toastBottom sits above the composer, or at the floor without one", () => {
  assert.equal(toastBottom({ top: 700, bottom: 780 }, 800), 108);
  assert.equal(toastBottom(null, 800), 12);
  assert.equal(toastBottom({ top: 900, bottom: 980 }, 800), 12);
  assert.equal(toastBottom({ top: -90, bottom: -10 }, 800), 12);
});

test("toastSpan centers on the composer, not on the window", () => {
  const view = { width: 1400, height: 900 };
  assert.deepEqual(toastSpan({ left: 300, width: 700, top: 820, bottom: 880 }, view), { center: 650, width: 640 });
  assert.deepEqual(toastSpan({ left: 300, width: 400, top: 820, bottom: 880 }, view), { center: 500, width: 400 });
  assert.deepEqual(toastSpan(null, view), { center: 700, width: MAX_TOAST_WIDTH });
  assert.deepEqual(toastSpan({ left: 300, width: 700, top: 950, bottom: 1010 }, view), { center: 700, width: MAX_TOAST_WIDTH });
});

test("toastLine marks a danger approval with the word dangerous", () => {
  const plain = approval("a", "write in skills");
  const danger = { ...plain, danger: true };
  assert.equal(isDanger(plain), false);
  assert.equal(isDanger({ ...plain, danger: false }), false);
  assert.equal(isDanger(danger), true);
  assert.ok(toastLine(danger, "Nana").includes(DANGER_WORD));
  assert.ok(!toastLine(plain, "Nana").includes(DANGER_WORD));
  assert.ok(toastLine(danger, "Nana").endsWith("write in skills"));
});

test("a danger approval keeps its mark when the reason is cut", () => {
  const line = toastLine({ ...approval("a", "x".repeat(MAX_LINE_REASON + 50)), danger: true }, "Nana");
  assert.ok(line.startsWith(`Nana · ${DANGER_WORD} · `));
});

test("danger cards use theme tokens and offer no always-allow control", () => {
  const read = (name: string) => readFileSync(new URL(`../components/${name}`, import.meta.url), "utf8");
  const theme = readFileSync(new URL("../theme.css", import.meta.url), "utf8");
  assert.equal(theme.match(/--danger:/g)?.length, 3);
  for (const name of ["ApprovalStack.svelte", "ApprovalDetails.svelte"]) {
    const src = read(name);
    assert.ok(src.includes("isDanger("), name);
    assert.ok(src.includes("var(--danger"), name);
    assert.ok(!/#[0-9a-f]{3,8}/i.test(src.slice(src.indexOf("<style>"))), `${name} has a raw colour`);
    assert.ok(!/always/i.test(src), name);
  }
  assert.ok(read("ApprovalDetails.svelte").includes("DANGER_WORD"));
});
