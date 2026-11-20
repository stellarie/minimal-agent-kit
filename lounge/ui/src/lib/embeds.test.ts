import { test } from "node:test";
import assert from "node:assert/strict";
import { attachmentUrl, formatSize, kindOfMime } from "./embeds.ts";

test("embeds: knows media by type", () => {
  assert.equal(kindOfMime("image/gif"), "image");
  assert.equal(kindOfMime("image/svg+xml"), "file");
  assert.equal(kindOfMime("video/webm"), "video");
  assert.equal(kindOfMime("audio/ogg"), "audio");
  assert.equal(kindOfMime("application/zip"), "file");
});

test("embeds: builds file URLs and sizes", () => {
  assert.equal(attachmentUrl({ id: "ab", name: "a b.png", mime: "image/png", size: 1 }), "/api/attachments/ab/a%20b.png");
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(2048), "2.0 KB");
  assert.equal(formatSize(3 * 1024 * 1024), "3.0 MB");
});

test("embeds: a bad size never prints NaN", () => {
  assert.equal(formatSize(-1), "0 B");
  assert.equal(formatSize(Number.NaN), "0 B");
  assert.equal(formatSize(5 * 1024 ** 3), "5.0 GB");
});
