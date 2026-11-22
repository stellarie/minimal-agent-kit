import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatedImageDir, imageNames, newImages } from "../../plugins/codex/images.ts";
import { tempHome } from "./helpers.ts";

const THREAD = "01a20360-5be8-78f3-bb77-7821170d1f30";

function put(home: string, thread: string, name: string, at?: number): string {
  const dir = join(home, "codex-home", "generated_images", thread);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, "x");
  if (at !== undefined) utimesSync(file, new Date(at), new Date(at));
  return file;
}

test("images: the folder is generated_images/<thread> in the codex home of the lounge", () => {
  assert.equal(generatedImageDir("/lounge", THREAD), join("/lounge", "codex-home", "generated_images", THREAD));
});

test("images: a thread id that is not a plain id gives no folder", () => {
  for (const bad of ["", "..", "../x", "a/b", "a\\b", "x y"]) assert.equal(generatedImageDir("/lounge", bad), undefined);
  assert.deepEqual(imageNames("/lounge", ".."), new Set());
  assert.deepEqual(newImages("/lounge", "..", new Set()), []);
});

test("images: a missing folder gives nothing", (t) => {
  const h = tempHome();
  t.after(() => h.cleanup());
  assert.deepEqual(imageNames(h.dir, THREAD), new Set());
  assert.deepEqual(newImages(h.dir, THREAD, new Set()), []);
});

test("images: only image files that the first listing did not hold come back, oldest first", (t) => {
  const h = tempHome();
  t.after(() => h.cleanup());
  put(h.dir, THREAD, "exec-old.png", 1_000);
  const before = imageNames(h.dir, THREAD);
  assert.deepEqual([...before], ["exec-old.png"]);
  const late = put(h.dir, THREAD, "exec-b.webp", 3_000);
  const early = put(h.dir, THREAD, "exec-a.png", 2_000);
  put(h.dir, THREAD, "notes.txt", 4_000);
  mkdirSync(join(h.dir, "codex-home", "generated_images", THREAD, "sub.png"));
  const found = newImages(h.dir, THREAD, before);
  assert.deepEqual(
    found.map((f) => [f.path, f.name, f.mime]),
    [
      [early, "exec-a.png", "image/png"],
      [late, "exec-b.webp", "image/webp"],
    ],
  );
});

test("images: a jpg is an image/jpeg and an upper-case extension counts", (t) => {
  const h = tempHome();
  t.after(() => h.cleanup());
  put(h.dir, THREAD, "a.jpg", 1_000);
  put(h.dir, THREAD, "b.JPEG", 2_000);
  assert.deepEqual(newImages(h.dir, THREAD, new Set()).map((f) => f.mime), ["image/jpeg", "image/jpeg"]);
});

test("images: at most ten files come back, the newest ten", (t) => {
  const h = tempHome();
  t.after(() => h.cleanup());
  for (let i = 0; i < 12; i++) put(h.dir, THREAD, `exec-${String(i).padStart(2, "0")}.png`, 1_000 + i);
  const found = newImages(h.dir, THREAD, new Set());
  assert.equal(found.length, 10);
  assert.equal(found[0]!.name, "exec-02.png");
  assert.equal(found[9]!.name, "exec-11.png");
});
