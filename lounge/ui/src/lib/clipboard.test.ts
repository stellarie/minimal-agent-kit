import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "./api.ts";
import { copyMessage, copyText, type ClipboardApi } from "./clipboard.ts";

function message(text: string, names: string[] = []): Message {
  return {
    id: 7,
    roomId: "lounge",
    author: "nana",
    text,
    createdAt: "2026-11-12T00:21:42Z",
    attachments: names.map((name) => ({ id: name, name, mime: "text/plain", size: 3 })),
  };
}

const head = { name: "Nana ✓", time: "08:21" };

function fake(writes: string[], fail = false): ClipboardApi {
  return {
    writeText(text: string): Promise<void> {
      if (fail) return Promise.reject(new Error("denied"));
      writes.push(text);
      return Promise.resolve();
    },
  };
}

test("copyText puts the head, the body, and the file names on three lines", () => {
  assert.equal(copyText(message("hello\nworld", ["a.png", "b.log"]), head), "Nana ✓ · 08:21\nhello\nworld\n[file] a.png\n[file] b.log");
});

test("copyText keeps a message with no text as a head and its files", () => {
  assert.equal(copyText(message("   ", ["a.png"]), head), "Nana ✓ · 08:21\n[file] a.png");
});

test("copyText drops the missing parts of the head", () => {
  assert.equal(copyText(message("hi"), { name: "", time: "" }), "hi");
  assert.equal(copyText(message("hi"), { name: "Nana ✓", time: "" }), "Nana ✓\nhi");
});

test("copyMessage writes the text and returns true", async () => {
  const writes: string[] = [];
  assert.equal(await copyMessage(fake(writes), "hi"), true);
  assert.deepEqual(writes, ["hi"]);
});

test("copyMessage returns false with no api, no text, or a refused write", async () => {
  assert.equal(await copyMessage(undefined, "hi"), false);
  assert.equal(await copyMessage(fake([]), ""), false);
  assert.equal(await copyMessage(fake([], true), "hi"), false);
});
