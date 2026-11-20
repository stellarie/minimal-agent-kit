import { test } from "node:test";
import assert from "node:assert/strict";
import { readSideTab, writeSideTab, type SideTab } from "./sidetabs.ts";

function store(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

test("the stored tab reads back", () => {
  for (const tab of ["members", "events", "files", "board"] as SideTab[]) {
    const s = store();
    writeSideTab(s, tab);
    assert.equal(readSideTab(s), tab);
  }
});

test("a missing or bad stored value gives members", () => {
  assert.equal(readSideTab(store()), "members");
  for (const bad of ["", "Files", "FILES", "chat", " files", "__proto__", "constructor", "null"]) {
    assert.equal(readSideTab(store({ "lounge.sideTab": bad })), "members", bad);
  }
});

test("a store that throws does not break the side bar", () => {
  const broken = {
    getItem(): string | null {
      throw new Error("blocked");
    },
    setItem(): void {
      throw new Error("blocked");
    },
  };
  assert.equal(readSideTab(broken), "members");
  assert.doesNotThrow(() => writeSideTab(broken, "files"));
});

test("the tab uses the key lounge.sideTab", () => {
  const s = store();
  writeSideTab(s, "events");
  assert.deepEqual([...s.data], [["lounge.sideTab", "events"]]);
});
