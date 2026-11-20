import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LoungeError } from "../src/lounge/room.ts";
import { Skills, parseSkill, skillRefs } from "../src/skills/skills.ts";
import { tempHome } from "./helpers.ts";

function skillText(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
}

function writeSkill(root: string, name: string, description: string, body: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), skillText(name, description, body));
}

const NAMES = ["wiki", "ste", "lounge-workflow"];

test("c11_1_known_ref", () => {
  assert.deepEqual(skillRefs("please use $wiki here", NAMES), ["wiki"]);
  assert.deepEqual(skillRefs("$ste then $wiki, and $wiki again", NAMES), ["ste", "wiki"]);
  assert.deepEqual(skillRefs("run $lounge-workflow.", NAMES), ["lounge-workflow"]);
  assert.deepEqual(skillRefs("$wiki", NAMES), ["wiki"]);
});

test("c11_1_unknown_ref", () => {
  assert.deepEqual(skillRefs("use $nothing here", NAMES), []);
  assert.deepEqual(skillRefs("use $wiki and $nothing", NAMES), ["wiki"]);
  assert.deepEqual(skillRefs("use $wiki", []), []);
});

test("c11_1_no_ref", () => {
  assert.deepEqual(skillRefs("hello there", NAMES), []);
  assert.deepEqual(skillRefs("", NAMES), []);
  assert.deepEqual(skillRefs("a price of 5$ or wiki", NAMES), []);
});

test("c11_1_bad_name", () => {
  // A name outside [a-z0-9-] never matches a skill, even when its prefix does.
  assert.deepEqual(skillRefs("$Wiki", NAMES), []);
  assert.deepEqual(skillRefs("$1wiki $-wiki", NAMES), []);
  assert.deepEqual(skillRefs("$wiki_x", NAMES), []);
  assert.deepEqual(skillRefs("$wiki-x", NAMES), []);
  assert.deepEqual(skillRefs("a$wiki $$wiki", NAMES), []);
  assert.deepEqual(skillRefs("$wIki", ["w"]), []);
});

test("c11_2: the store lists only <home>/skills, never a user folder of a harness", (t) => {
  const home = tempHome();
  const fakeProfile = tempHome();
  t.after(() => {
    home.cleanup();
    fakeProfile.cleanup();
  });
  // A user skill in a harness folder of the profile.
  writeSkill(join(fakeProfile.dir, ".claude", "skills"), "user-only", "A user skill.", "user body");
  writeSkill(join(fakeProfile.dir, ".codex", "skills"), "codex-only", "A codex skill.", "codex body");
  writeSkill(join(home.dir, "skills"), "wiki", "Wiki rules.", "wiki body");
  const store = new Skills({ home: home.dir });
  assert.equal(store.root, join(home.dir, "skills"));
  assert.deepEqual(store.index(), [{ name: "wiki", description: "Wiki rules." }]);
  assert.throws(() => store.body("user-only"), /unknown skill/);
  assert.throws(() => store.body("codex-only"), /unknown skill/);
});

test("skillIndex lists name and description only, sorted, and skips a bad folder", (t) => {
  const home = tempHome();
  t.after(() => home.cleanup());
  const root = join(home.dir, "skills");
  writeSkill(root, "ste", "Short English.", "ste body");
  writeSkill(root, "wiki", "Wiki rules.", "wiki body");
  mkdirSync(join(root, "no-file"), { recursive: true });
  mkdirSync(join(root, "mismatch"), { recursive: true });
  writeFileSync(join(root, "mismatch", "SKILL.md"), skillText("other", "Wrong name.", "x"));
  const store = new Skills({ home: home.dir });
  assert.deepEqual(store.index(), [
    { name: "ste", description: "Short English." },
    { name: "wiki", description: "Wiki rules." },
  ]);
  assert.deepEqual(store.scan().skipped, [{ name: "mismatch", reason: "name other does not match folder mismatch" }]);
});

test("body returns the text under the front matter; an unknown or bad name is unknown skill", (t) => {
  const home = tempHome();
  t.after(() => home.cleanup());
  writeSkill(join(home.dir, "skills"), "wiki", "Wiki rules.", "line one\nline two");
  const store = new Skills({ home: home.dir });
  assert.equal(store.body("wiki"), "line one\nline two\n");
  for (const bad of ["nope", "..", "../wiki", "Wiki", ""]) {
    assert.throws(
      () => store.body(bad),
      (err: unknown) => err instanceof LoungeError && err.code === "unknown_skill" && /unknown skill/.test(err.message),
      bad,
    );
  }
});

test("a folder that the scan skipped is unknown skill to the tool and to a $name", (t) => {
  const home = tempHome();
  t.after(() => home.cleanup());
  const root = join(home.dir, "skills");
  mkdirSync(join(root, "mismatch"), { recursive: true });
  writeFileSync(join(root, "mismatch", "SKILL.md"), skillText("other", "Wrong name.", "mismatch body"));
  mkdirSync(join(root, "nodesc"), { recursive: true });
  writeFileSync(join(root, "nodesc", "SKILL.md"), "---\nname: nodesc\n---\n\nnodesc body\n");
  const store = new Skills({ home: home.dir });
  assert.deepEqual(store.index(), []);
  for (const name of ["mismatch", "nodesc"]) {
    assert.throws(() => store.body(name), { code: "unknown_skill" }, name);
  }
});

test("create, replace, and remove keep the folder and the front matter true", (t) => {
  const home = tempHome();
  t.after(() => home.cleanup());
  const store = new Skills({ home: home.dir, now: () => new Date("2026-11-21T00:00:00.000Z") });
  const made = store.create({ name: "wiki", description: "Wiki rules.", body: "body one" });
  assert.equal(made.name, "wiki");
  assert.equal(store.body("wiki"), "body one\n");
  assert.throws(() => store.create({ name: "wiki", description: "d", body: "b" }), { code: "skill_exists" });
  assert.throws(() => store.create({ name: "Bad Name", description: "d", body: "b" }), { code: "bad_skill" });

  const text = skillText("wiki", "New description.", "body two");
  assert.deepEqual(store.replace("wiki", text), { name: "wiki", text });
  assert.deepEqual(store.index(), [{ name: "wiki", description: "New description." }]);
  assert.throws(() => store.replace("wiki", skillText("other", "d", "b")), { code: "bad_skill" });
  assert.throws(() => store.replace("nope", text), { code: "unknown_skill" });

  const aside = store.remove("wiki");
  assert.equal(existsSync(join(home.dir, "skills", "wiki")), false);
  assert.ok(readFileSync(join(aside, "SKILL.md"), "utf8").includes("body two"));
  assert.deepEqual(readdirSync(join(home.dir, "skills", ".removed")).length, 1);
  assert.deepEqual(store.index(), []);
});

test("parseSkill reads name, description, and body; a file with no front matter is refused", () => {
  const ok = parseSkill(skillText("wiki", "Wiki rules.", "body"));
  assert.deepEqual(ok, { ok: true, name: "wiki", description: "Wiki rules.", body: "body\n" });
  assert.deepEqual(parseSkill("no front matter"), { ok: false, reason: "no front matter" });
  assert.deepEqual(parseSkill("---\nname: wiki\n---\nbody"), { ok: false, reason: "no front matter description" });
});
