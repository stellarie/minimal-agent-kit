import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db/db.ts";
import { Attachments, attachmentPath, attachmentDir } from "../src/lounge/attachments.ts";
import { tempHome } from "./helpers.ts";

function setup(t: TestContext) {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  t.after(() => {
    db.close();
    home.cleanup();
  });
  return { home: home.dir, db };
}

const SHORTCUTS = [".url", ".lnk", ".scf", ".library-ms", ".searchconnector-ms", ".desktop"];
const MORE_RISKY = [".theme", ".themepack", ".website"];
const PROGRAMS = [
  ".exe", ".com", ".bat", ".cmd", ".ps1", ".vbs", ".vbe", ".js", ".jse",
  ".wsf", ".wsh", ".hta", ".msi", ".scr", ".cpl", ".reg",
];
const RISKY = [...SHORTCUTS, ...MORE_RISKY, ...PROGRAMS];

test("a risky extension gets the bare id path and no named copy", (t) => {
  const h = setup(t);
  const atts = new Attachments({ db: h.db, home: h.home });
  for (const ext of [...RISKY, ...RISKY.map((e) => e.toUpperCase())]) {
    const att = atts.save("owner", `evil${ext}`, Buffer.from("[InternetShortcut]"));
    const path = attachmentPath(h.home, att);
    assert.equal(path, join(attachmentDir(h.home), att.id), ext);
    assert.deepEqual(
      readdirSync(attachmentDir(h.home)).filter((n) => n.startsWith(att.id)),
      [att.id],
      ext,
    );
  }
});

test("other extensions still get a named copy", (t) => {
  const h = setup(t);
  const atts = new Attachments({ db: h.db, home: h.home });
  const att = atts.save("owner", "notes.md", Buffer.from("# hi"));
  const path = attachmentPath(h.home, att);
  assert.equal(path, join(attachmentDir(h.home), `${att.id}.md`));
  assert.ok(existsSync(path));
});

test("sweep removes old named copies of risky files and keeps the rest", (t) => {
  const h = setup(t);
  const atts = new Attachments({ db: h.db, home: h.home });
  const dir = attachmentDir(h.home);
  const keep = atts.save("owner", "keep.md", Buffer.from("# keep"));
  atts.markPosted([keep]);
  const keepNamed = attachmentPath(h.home, keep);
  const old: string[] = [];
  for (const ext of RISKY) {
    const att = atts.save("owner", `old${ext}`, Buffer.from("x"));
    atts.markPosted([att]);
    const copy = join(dir, att.id + ext);
    writeFileSync(copy, "x");
    old.push(copy);
  }
  const bare = join(dir, atts.get(keep.id)!.id);
  const stray = join(dir, "notes.url");
  writeFileSync(stray, "x");
  assert.equal(atts.sweep(), 0);
  for (const copy of old) assert.ok(!existsSync(copy), copy);
  assert.ok(existsSync(keepNamed));
  assert.ok(existsSync(bare));
  assert.ok(existsSync(stray));
  // Their stored files stay: only the named copies go.
  for (const copy of old) assert.ok(existsSync(copy.replace(/\.[a-z0-9-]+$/, "")), copy);
});

test("a folder named like a named copy does not stop the sweep", (t) => {
  const h = setup(t);
  const atts = new Attachments({ db: h.db, home: h.home });
  const errors = t.mock.method(console, "error", () => {});
  const dir = attachmentDir(h.home);
  const a = atts.save("owner", "a.url", Buffer.from("x"));
  const b = atts.save("owner", "b.lnk", Buffer.from("x"));
  const folder = join(dir, `${a.id}.url`);
  mkdirSync(join(folder, "inside"), { recursive: true });
  const copy = join(dir, `${b.id}.lnk`);
  writeFileSync(copy, "x");
  assert.doesNotThrow(() => atts.sweep());
  assert.ok(existsSync(folder));
  assert.ok(!existsSync(copy));
  assert.equal(errors.mock.callCount(), 1);
});
