import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startCore } from "../src/api/http.ts";
import { ensureTokens } from "../src/auth/tokens.ts";
import { openDb } from "../src/db/db.ts";
import { unavailableAdapter } from "../src/adapters/stub.ts";
import { revealDefault } from "../src/lounge/reveal.ts";
import { fakeKinds, tempHome, SEED_CALLERS } from "./helpers.ts";

interface RoomFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  author: string;
  messageId: number;
  createdAt: string;
}

interface Page {
  files: RoomFile[];
  next: number | null;
}

async function setup(t: TestContext, reveal?: (path: string) => Promise<void>) {
  const home = tempHome();
  const core = await startCore({
    home: home.dir,
    port: 0,
    schedule: false,
    reveal,
    runtimes: fakeKinds(() => unavailableAdapter("claude", "test stub")),
  });
  t.after(async () => {
    await core.close();
    home.cleanup();
  });
  const tokens = ensureTokens(home.dir, SEED_CALLERS);
  const auth = { authorization: `Bearer ${tokens.owner}` };
  const json = { ...auth, "content-type": "application/json" };
  const api = (path: string, init: RequestInit = {}) => fetch(core.url + path, { headers: auth, ...init });
  const upload = async (name: string, body = "data"): Promise<string> => {
    const res = await fetch(`${core.url}/api/attachments?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/octet-stream" },
      body,
    });
    assert.equal(res.status, 201);
    return ((await res.json()) as { id: string }).id;
  };
  const post = async (room: string, ids: string[]): Promise<number> => {
    const res = await fetch(`${core.url}/api/rooms/${room}/messages`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ text: "", attachments: ids }),
    });
    assert.equal(res.status, 201);
    return ((await res.json()) as { id: number }).id;
  };
  const files = async (room: string, query = ""): Promise<Page> => {
    const res = await api(`/api/rooms/${room}/files${query}`);
    assert.equal(res.status, 200);
    return (await res.json()) as Page;
  };
  return { home: home.dir, url: core.url, tokens, api, upload, post, files, json };
}

test("room files: items, order, and one message with three files", async (t) => {
  const h = await setup(t);
  const a = await h.upload("a.png", "aaa");
  const b = await h.upload("b.md", "# b");
  const c = await h.upload("c.ts", "let c");
  const d = await h.upload("d.zip", "dddd");
  const first = await h.post("lounge", [a]);
  const second = await h.post("lounge", [b, c, d]);
  const { files, next } = await h.files("lounge");
  assert.equal(next, null);
  assert.deepEqual(files.map((f) => f.name), ["b.md", "c.ts", "d.zip", "a.png"]);
  assert.deepEqual(files.map((f) => f.messageId), [second, second, second, first]);
  const md = files[0]!;
  assert.deepEqual(Object.keys(md).sort(), ["author", "createdAt", "id", "messageId", "mime", "name", "size"]);
  assert.equal(md.id, b);
  assert.equal(md.mime, "text/markdown");
  assert.equal(md.size, 3);
  assert.equal(md.author, "owner");
  assert.ok(!Number.isNaN(Date.parse(md.createdAt)));
});

test("room files: another room and a thread are not listed", async (t) => {
  const h = await setup(t);
  const made = await h.api("/api/rooms", { method: "POST", headers: h.json, body: JSON.stringify({ name: "other" }) });
  assert.equal(made.status, 201);
  const thread = await h.api("/api/threads", {
    method: "POST",
    headers: h.json,
    body: JSON.stringify({ channel: "lounge", title: "Work", brief: "go", lead: "ada" }),
  });
  assert.equal(thread.status, 201);
  const threadId = ((await thread.json()) as { id: string }).id;
  const mine = await h.upload("mine.txt");
  const theirs = await h.upload("theirs.txt");
  const inThread = await h.upload("thread.txt");
  await h.post("lounge", [mine]);
  await h.post("other", [theirs]);
  await h.post(threadId, [inThread]);
  assert.deepEqual((await h.files("lounge")).files.map((f) => f.name), ["mine.txt"]);
  assert.deepEqual((await h.files("other")).files.map((f) => f.name), ["theirs.txt"]);
  assert.deepEqual((await h.files(threadId)).files.map((f) => f.name), ["thread.txt"]);
});

test("room files: pages hold whole messages and the cursor walks back", async (t) => {
  const h = await setup(t);
  const ids = [await h.upload("x.txt", "1"), await h.upload("y.txt", "2"), await h.upload("z.txt", "3")];
  // 20 messages of 3 files: 48 files fit a page, 51 do not.
  const messages: number[] = [];
  for (let i = 0; i < 20; i++) messages.push(await h.post("lounge", ids));
  const page1 = await h.files("lounge");
  assert.equal(page1.files.length, 48);
  assert.ok(page1.files.length <= 50);
  assert.equal(new Set(page1.files.map((f) => f.messageId)).size, 16);
  assert.deepEqual(page1.files.map((f) => f.messageId).slice(0, 3), Array(3).fill(messages[19]));
  assert.equal(page1.next, messages[4]);
  const page2 = await h.files("lounge", `?before=${page1.next}`);
  assert.deepEqual([...new Set(page2.files.map((f) => f.messageId))], messages.slice(0, 4).reverse());
  assert.equal(page2.files.length, 12);
  assert.equal(page2.next, null);
  const none = await h.files("lounge", `?before=${messages[0]}`);
  assert.deepEqual(none, { files: [], next: null });
});

test("room files: a full read of 60 messages gives a next cursor", async (t) => {
  const h = await setup(t);
  const one = await h.upload("one.txt");
  const messages: number[] = [];
  for (let i = 0; i < 61; i++) messages.push(await h.post("lounge", [one]));
  const page1 = await h.files("lounge");
  assert.equal(page1.files.length, 50);
  assert.equal(page1.next, messages[11]);
  const page2 = await h.files("lounge", `?before=${page1.next}`);
  assert.equal(page2.files.length, 11);
  assert.equal(page2.next, null);
});

test("room files: bad rows are skipped and still give a next cursor", async (t) => {
  const h = await setup(t);
  const real = await h.upload("real.txt");
  const old = await h.post("lounge", [real]);
  const db = openDb(join(h.home, "lounge.db"));
  const insert = db.prepare(
    "INSERT INTO messages (room_id, author, text, created_at, kind, attachments) VALUES ('lounge', 'ada', 'x', ?, 'text', ?)",
  );
  const bad = ["{not json", '{"id":"x"}', "42", '"text"', "[1,2]", "[null]"];
  for (let i = 0; i < 60; i++) insert.run(new Date().toISOString(), bad[i % bad.length]!);
  db.close();
  const page1 = await h.api("/api/rooms/lounge/files");
  assert.equal(page1.status, 200);
  const first = (await page1.json()) as Page;
  assert.deepEqual(first.files, []);
  assert.ok(first.next !== null && first.next > old);
  const second = await h.files("lounge", `?before=${first.next}`);
  assert.deepEqual(second.files.map((f) => f.id), [real]);
  assert.equal(second.next, null);
});

test("room files: unknown room, bad cursor, and auth", async (t) => {
  const h = await setup(t);
  const missing = await h.api("/api/rooms/no-such-room/files");
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { error: string }).error, "unknown_room");
  assert.equal((await h.api("/api/rooms/lounge/files?before=abc")).status, 400);
  assert.equal((await fetch(`${h.url}/api/rooms/lounge/files`)).status, 401);
  const agent = await fetch(`${h.url}/api/rooms/lounge/files`, {
    headers: { authorization: `Bearer ${h.tokens.ada}` },
  });
  assert.equal(agent.status, 403);
  assert.equal((await h.api("/api/rooms/lounge/files", { method: "POST" })).status, 405);
});

test("reveal: the stored path goes to reveal and the route answers 204", async (t) => {
  const calls: string[] = [];
  const h = await setup(t, async (path) => {
    calls.push(path);
  });
  const id = await h.upload("my notes.md", "# hi");
  const res = await h.api(`/api/attachments/${id}/reveal`, { method: "POST" });
  assert.equal(res.status, 204);
  assert.equal(calls.length, 1);
  const dir = join(h.home, "attachments");
  assert.ok(calls[0]!.toLowerCase().startsWith(dir.toLowerCase()), calls[0]);
  assert.ok(calls[0]!.startsWith(dir));
  assert.ok(existsSync(calls[0]!));
  assert.equal(calls[0], join(dir, `${id}.md`));
});

test("reveal: unknown id, gone file, and missing token", async (t) => {
  const calls: string[] = [];
  const h = await setup(t, async (path) => {
    calls.push(path);
  });
  assert.equal((await h.api(`/api/attachments/${"0".repeat(32)}/reveal`, { method: "POST" })).status, 404);
  const id = await h.upload("gone.txt");
  rmSync(join(h.home, "attachments", id));
  assert.equal((await h.api(`/api/attachments/${id}/reveal`, { method: "POST" })).status, 404);
  const other = await h.upload("here.txt");
  assert.equal((await fetch(`${h.url}/api/attachments/${other}/reveal`, { method: "POST" })).status, 401);
  const agent = await fetch(`${h.url}/api/attachments/${other}/reveal`, {
    method: "POST",
    headers: { authorization: `Bearer ${h.tokens.ada}` },
  });
  assert.equal(agent.status, 403);
  assert.deepEqual(calls, []);
});

test("reveal: the route reads no path from the request", async (t) => {
  const calls: string[] = [];
  const h = await setup(t, async (path) => {
    calls.push(path);
  });
  const id = await h.upload("a.txt");
  const res = await h.api(`/api/attachments/${id}/reveal?path=C:%5CWindows&name=..%5C..`, {
    method: "POST",
    headers: { ...h.json },
    body: JSON.stringify({ path: "C:\\Windows\\System32\\cmd.exe" }),
  });
  assert.equal(res.status, 204);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0]!.includes("Windows"));
  assert.ok(calls[0]!.includes(id));
});

test("reveal: GET still downloads a file named reveal", async (t) => {
  const calls: string[] = [];
  const h = await setup(t, async (path) => {
    calls.push(path);
  });
  const id = await h.upload("reveal", "payload");
  const res = await fetch(`${h.url}/api/attachments/${id}/reveal`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "payload");
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment/);
  assert.equal((await fetch(`${h.url}/api/attachments/${id}/reveal`, { method: "HEAD" })).status, 200);
  assert.deepEqual(calls, []);
});

test("reveal: a platform other than win32 gets 501 and other routes keep their status", async (t) => {
  const h = await setup(t, revealDefault("linux", (() => {
    throw new Error("must not spawn");
  }) as never));
  const id = await h.upload("a.txt");
  const res = await h.api(`/api/attachments/${id}/reveal`, { method: "POST" });
  assert.equal(res.status, 501);
  assert.equal(((await res.json()) as { error: string }).error, "unsupported");
  assert.equal((await h.api("/api/rooms/no-such-room/files")).status, 404);
  assert.equal((await h.api(`/api/attachments/${"0".repeat(32)}/reveal`, { method: "POST" })).status, 404);
  const empty = await h.api("/api/threads", { method: "POST", headers: h.json, body: "{}" });
  assert.equal(empty.status, 400);
});

class FakeChild {
  #listeners = new Map<string, () => void>();
  unrefs = 0;
  once(event: string, fn: () => void): this {
    this.#listeners.set(event, fn);
    return this;
  }
  unref(): void {
    this.unrefs++;
  }
  emit(event: string, arg?: unknown): void {
    (this.#listeners.get(event) as ((a?: unknown) => void) | undefined)?.(arg);
  }
}

test("default reveal: one verbatim argument, no shell, resolve on spawn", async () => {
  const seen: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const child = new FakeChild();
  const run = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
    seen.push({ cmd, args, opts });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as never;
  await revealDefault("win32", run)("C:\\Users\\A B\\lounge\\attachments\\abc.png");
  assert.equal(seen.length, 1);
  const explorer = join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe");
  assert.equal(seen[0]!.cmd, explorer);
  assert.notEqual(seen[0]!.cmd, "explorer.exe");
  assert.deepEqual(seen[0]!.args, ['/select,"C:\\Users\\A B\\lounge\\attachments\\abc.png"']);
  assert.equal(seen[0]!.opts.shell, false);
  assert.equal(seen[0]!.opts.windowsVerbatimArguments, true);
  assert.equal(child.unrefs, 1);
});

test("default reveal: rejects on error and reads no exit code", async () => {
  const failing = new FakeChild();
  const fail = (() => {
    queueMicrotask(() => failing.emit("error", new Error("ENOENT")));
    return failing;
  }) as never;
  await assert.rejects(revealDefault("win32", fail)("C:\\x\\y.txt"), /ENOENT/);
  const exiting = new FakeChild();
  const run = (() => {
    queueMicrotask(() => {
      exiting.emit("spawn");
      exiting.emit("exit", 1);
    });
    return exiting;
  }) as never;
  await revealDefault("win32", run)("C:\\x\\y.txt");
});

test("default reveal: another platform rejects before it spawns", async () => {
  let spawned = 0;
  const run = (() => {
    spawned++;
    return new FakeChild();
  }) as never;
  await assert.rejects(revealDefault("darwin", run)("/x/y"), (err: unknown) => {
    const e = err as { status?: number; code?: string };
    return e.status === 501 && e.code === "unsupported";
  });
  assert.equal(spawned, 0);
});
