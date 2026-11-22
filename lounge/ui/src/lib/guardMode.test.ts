import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHttpClient } from "./api.ts";
import { modeView } from "./guardMode.ts";
import { outcomeLabel, sourceLabel } from "./guard.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("c6_1: normal shows no bar and no badge", () => {
  const view = modeView("normal");
  assert.deepEqual([view.bar, view.badge, view.label], [false, false, "Normal"]);
});

test("c6_1: auto shows the soft badge and no bar", () => {
  const view = modeView("auto");
  assert.deepEqual([view.bar, view.badge, view.label], [false, true, "Auto"]);
});

test("c6_1: bypass shows the warning bar", () => {
  const view = modeView("bypass");
  assert.deepEqual([view.bar, view.badge, view.label], [true, false, "Bypass"]);
  assert.match(view.help, /Hard blocks still deny/);
});

test("c6_1: the guard log names bypass-allowed and judge rows", () => {
  assert.equal(outcomeLabel("bypass-allowed"), "Bypass-allowed");
  assert.equal(outcomeLabel("auto-allowed"), "Auto-allowed");
  assert.equal(sourceLabel("judge"), "judge");
  assert.equal(sourceLabel("guard-mode"), "guard mode");
});

test("c6_1: the live client reads and writes the guard mode and the judge", async (t) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ mode: "auto" }), { status: 200 });
  }) as typeof fetch;
  const client = createHttpClient("tok");
  assert.deepEqual(await client.guardMode(), { mode: "auto" });
  assert.equal(calls[0]!.url, "/api/guard/mode");
  assert.equal(calls[0]!.init?.method, undefined);
  await client.setGuardMode("bypass");
  assert.equal(calls[1]!.init!.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[1]!.init!.body)), { mode: "bypass" });
  await client.guardJudge();
  assert.equal(calls[2]!.url, "/api/guard/judge");
  const draft = { runtime: "claude-code" as const, model: "opus", effort: "low", policy: "SAFE: ls" };
  await client.setGuardJudge(draft);
  assert.equal(calls[3]!.url, "/api/guard/judge");
  assert.equal(calls[3]!.init!.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[3]!.init!.body)), draft);
  assert.equal((calls[3]!.init!.headers as Record<string, string>).Authorization, "Bearer tok");
});

test("c6_1: the header holds the switch, the bypass bar, and the judge panel is in Permissions", () => {
  const app = read("../App.svelte");
  const header = app.slice(app.indexOf('<header class="topbar">'), app.indexOf("</header>"));
  assert.ok(header.includes("<GuardModeSwitch"));
  assert.ok(app.includes("modeView(guardMode).bar"));
  assert.ok(app.indexOf("{#if modeView(guardMode).bar}") > app.indexOf("</header>"));
  const panel = read("../components/PermissionsPanel.svelte");
  assert.ok(panel.indexOf("<GuardBlockAsks") < panel.indexOf("<GuardJudge") && panel.indexOf("<GuardJudge") < panel.indexOf("<GuardLog"));
  const sw = read("../components/GuardModeSwitch.svelte");
  for (const mode of ["normal", "auto", "bypass"]) assert.ok(sw.includes(mode), mode);
  assert.ok(sw.includes("aria-pressed"));
  const judge = read("../components/GuardJudge.svelte");
  for (const part of ["client.guardJudge()", "client.setGuardJudge(", "Custom…", "defaultPolicy", 'maxlength="4096"']) {
    assert.ok(judge.includes(part), part);
  }
});
