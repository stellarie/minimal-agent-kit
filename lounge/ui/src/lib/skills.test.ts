import { test } from "node:test";
import assert from "node:assert/strict";
import { SKILL_NAME_HINT, loginBusy, loginSummary, skillState, validSkillName } from "./skills.ts";

test("validSkillName accepts a-z, 0-9, and hyphen, 1 to 64 characters", () => {
  for (const name of ["wiki", "lounge-workflow", "a", "x1-2", "a".repeat(64)]) assert.equal(validSkillName(name), true, name);
  for (const name of ["", "Wiki", "a b", "a_b", "a".repeat(65), "../x", "wiki.md"]) assert.equal(validSkillName(name), false, name);
});

test("skillState: a new skill needs a valid name and a description; an edit needs a changed text", () => {
  assert.deepEqual(skillState({ mode: "new", name: "wiki", description: "Rules.", body: "x" }), { canSave: true, hint: "" });
  assert.equal(skillState({ mode: "new", name: "Wiki", description: "Rules.", body: "x" }).canSave, false);
  assert.equal(skillState({ mode: "new", name: "Wiki", description: "Rules.", body: "x" }).hint, SKILL_NAME_HINT);
  assert.equal(skillState({ mode: "new", name: "wiki", description: "  ", body: "x" }).canSave, false);
  assert.equal(skillState({ mode: "edit", text: "same", saved: "same" }).canSave, false);
  assert.equal(skillState({ mode: "edit", text: "changed", saved: "same" }).canSave, true);
});

test("loginSummary tells each state; loginBusy is true only while a sign-in runs", () => {
  assert.equal(loginSummary({ state: "signed-in" }), "Signed in. Codex agents run with the lounge login.");
  assert.equal(loginSummary({ state: "signed-out" }), "Not signed in. A Codex agent cannot run until you sign in.");
  assert.equal(
    loginSummary({ state: "signed-out", error: "login failed" }),
    "Not signed in. A Codex agent cannot run until you sign in. Last error: login failed",
  );
  assert.equal(loginSummary({ state: "running" }), "Waiting for the sign-in in your browser.");
  assert.equal(loginBusy({ state: "running" }), true);
  assert.equal(loginBusy({ state: "signed-out" }), false);
  assert.equal(loginBusy({ state: "signed-in" }), false);
});
