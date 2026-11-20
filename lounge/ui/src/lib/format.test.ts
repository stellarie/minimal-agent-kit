import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GROUP_MS,
  HERE_MS,
  continues,
  displayName,
  quoteExcerpt,
  formatLastSeen,
  isHere,
  localTimes,
  toolName,
  typingText,
} from "./format.ts";

const now = Date.parse("2026-11-06T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

test("isHere: a reachable agent is here after days away", () => {
  assert.equal(isHere({ lastSeen: ago(3 * 86_400_000), reachable: true }, now), true);
  assert.equal(isHere({ lastSeen: null, reachable: true }, now), true);
});

test("isHere: without reachability, only recent activity counts", () => {
  assert.equal(isHere({ lastSeen: ago(HERE_MS - 1000), reachable: false }, now), true);
  assert.equal(isHere({ lastSeen: ago(HERE_MS + 1000) }, now), false);
  assert.equal(isHere({ lastSeen: null }, now), false);
});

test("continues: same author within the window, no events", () => {
  const a = { author: "nana", createdAt: ago(GROUP_MS) };
  assert.equal(continues(a, { author: "nana", createdAt: ago(1000) }), true);
  assert.equal(continues(a, { author: "mika", createdAt: ago(1000) }), false);
  assert.equal(continues({ author: "nana", createdAt: ago(GROUP_MS + 5000) }, { author: "nana", createdAt: ago(0) }), false);
  assert.equal(continues({ ...a, kind: "event" }, { author: "nana", createdAt: ago(1000) }), false);
  assert.equal(continues(undefined, a), false);
});

test("typingText names one or two, then counts", () => {
  assert.equal(typingText([]), "");
  assert.equal(typingText(["nana"]), "Nana is typing…");
  assert.equal(typingText(["nana", "mika"]), "Nana and Mika are typing…");
  assert.equal(typingText(["nana", "mika", "rina"]), "Several agents are typing…");
});

test("localTimes rewrites ISO times and keeps other text", () => {
  const out = localTimes("scheduled an event for 2026-11-06T12:14:00.000Z: Snack break");
  assert.doesNotMatch(out, /2026-11-06T/);
  assert.match(out, /^scheduled an event for .+: Snack break$/);
  assert.equal(localTimes("no times here"), "no times here");
});

test("toolName takes the tool from an activity line", () => {
  assert.equal(toolName("Bash: npm test"), "Bash");
  assert.equal(toolName("mcp__lounge__lounge_post: hi: there"), "mcp__lounge__lounge_post");
  assert.equal(toolName("WebSearch"), "WebSearch");
  assert.equal(toolName(""), "a tool");
});

test("displayName capitalizes an id, the owner too", () => {
  assert.equal(displayName("nana-b"), "Nana-b");
  assert.equal(displayName("owner"), "Owner");
});

test("continues: a reply always starts a new header", () => {
  const now = Date.now();
  const at = new Date(now).toISOString();
  assert.equal(continues({ author: "nana", createdAt: at }, { author: "nana", createdAt: at, replyTo: 3 }), false);
});

test("quoteExcerpt: one line, cut with an ellipsis", () => {
  assert.equal(quoteExcerpt("hi\n  there"), "hi there");
  assert.equal(quoteExcerpt("abcdefghij", 5), "abcd…");
  assert.equal(quoteExcerpt("abcde", 5), "abcde");
  assert.equal(quoteExcerpt("あいうえおか", 4), "あいう…");
});

test("formatLastSeen: a stretch of time reads in words", () => {
  assert.equal(formatLastSeen(ago(30_000), now), "just now");
  assert.equal(formatLastSeen(ago(60_000), now), "1 minute ago");
  assert.equal(formatLastSeen(ago(3 * 60_000), now), "3 minutes ago");
  assert.equal(formatLastSeen(ago(3_600_000), now), "1 hour ago");
  assert.equal(formatLastSeen(ago(5 * 3_600_000), now), "5 hours ago");
  assert.equal(formatLastSeen(ago(86_400_000), now), "1 day ago");
  assert.equal(formatLastSeen(ago(3 * 86_400_000), now), "3 days ago");
  assert.equal(formatLastSeen(ago(14 * 86_400_000), now), "2 weeks ago");
  assert.equal(formatLastSeen(ago(60 * 86_400_000), now), "2 months ago");
  assert.equal(formatLastSeen(ago(400 * 86_400_000), now), "1 year ago");
});

test("formatLastSeen: a future time clamps to now, never negative", () => {
  assert.equal(formatLastSeen(new Date(now + 5 * 60_000).toISOString(), now), "just now");
  assert.equal(formatLastSeen(new Date(now + 2 * 86_400_000).toISOString(), now), "just now");
  assert.doesNotMatch(formatLastSeen(new Date(now + 3 * 86_400_000).toISOString(), now), /-/);
});

test("formatLastSeen: no time and a bad time read the same", () => {
  assert.equal(formatLastSeen(null, now), "not seen yet");
  assert.equal(formatLastSeen("not a time", now), "not seen yet");
});
