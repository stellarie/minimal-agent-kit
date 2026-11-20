import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_FONT, FONTS, fontById, fontStack } from "./fonts.ts";

test("an unknown or missing font id gives the default", () => {
  assert.equal(fontById(null).id, DEFAULT_FONT);
  assert.equal(fontById("comic-sans").id, DEFAULT_FONT);
  assert.equal(fontById("ibm-plex-mono").name, "IBM Plex Mono");
});

test("each stack starts with its family and falls back to the system font", () => {
  assert.match(fontStack(fontById("ibm-plex-mono")), /^"IBM Plex Mono", system-ui/);
  assert.match(fontStack(fontById("system")), /^system-ui/);
  assert.equal(new Set(FONTS.map((f) => f.id)).size, FONTS.length);
});
