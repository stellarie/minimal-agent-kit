import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startCore } from "../src/api/http.ts";
import { ensureTokens } from "../src/auth/tokens.ts";
import { openDb } from "../src/db/db.ts";
import { Attachments, cleanName, mimeOf } from "../src/lounge/attachments.ts";
import { isSecret, ProfileFiles } from "../src/lounge/files.ts";
import { LoungeError, Room } from "../src/lounge/room.ts";
import { createMcpHandler } from "../src/mcp/server.ts";
import { sessionDeps, tempHome, TINY_PNG, SEED_CALLERS } from "./helpers.ts";

function code(c: string) {
  return (err: unknown) => err instanceof LoungeError && err.code === c;
}

function db(t: TestContext) {
  const home = tempHome();
  const handle = openDb(join(home.dir, "lounge.db"));
  t.after(() => {
    handle.close();
    home.cleanup();
  });
  return { home: home.dir, db: handle, room: new Room(handle) };
}

test("attachments: save, resolve, post, and sweep", (t) => {
  const h = db(t);
  let ms = Date.parse("2026-11-06T12:00:00Z");
  const atts = new Attachments({ db: h.db, home: h.home, now: () => new Date(ms) });
  const pic = atts.save("owner", "C:\\x\\cat.png", TINY_PNG, "application/octet-stream");
  assert.equal(pic.name, "cat.png");
  assert.equal(pic.mime, "image/png");
  assert.equal(pic.size, TINY_PNG.length);
  assert.match(pic.id, /^[0-9a-f]{32}$/);
  assert.deepEqual(atts.read(pic.id), TINY_PNG);
  assert.throws(() => atts.save("owner", "e.txt", Buffer.alloc(0)), code("bad_attachment"));
  assert.throws(() => atts.resolve(["nope"]), code("bad_attachment"));
  assert.throws(() => atts.resolve("x"), code("bad_attachment"));
  const files = atts.resolve([pic.id, pic.id]);
  assert.equal(files.length, 1);
  // Text may be empty when a file comes with it.
  const m = h.room.post("owner", "lounge", "", "text", files);
  atts.markPosted(files);
  assert.deepEqual(h.room.read("lounge").at(-1)!.attachments, [pic]);
  assert.deepEqual(m.attachments, [pic]);
  assert.throws(() => h.room.post("owner", "lounge", " "), code("bad_text"));
  const loose = atts.save("ada", "a.txt", Buffer.from("hi"));
  ms += 25 * 3_600_000;
  assert.equal(atts.sweep(), 1);
  assert.equal(atts.get(loose.id), undefined);
  assert.ok(atts.get(pic.id));
});

test("attachments: names and types", () => {
  assert.equal(cleanName("../../etc/passwd"), "passwd");
  assert.equal(cleanName('a<b>:"c".txt'), "a_b___c_.txt");
  assert.equal(cleanName(""), "file");
  assert.equal(mimeOf("a.GIF"), "image/gif");
  assert.equal(mimeOf("a.bin"), "application/octet-stream");
  assert.equal(mimeOf("a.bin", "video/webm; codecs=vp9"), "video/webm");
});

test("files: browse and read stay inside the profile and skip secrets", (t) => {
  const h = db(t);
  const root = join(h.home, "profile");
  mkdirSync(join(root, "Pictures"), { recursive: true });
  mkdirSync(join(root, ".ssh"), { recursive: true });
  mkdirSync(join(root, "lounge"), { recursive: true });
  writeFileSync(join(root, "Pictures", "cat.png"), TINY_PNG);
  writeFileSync(join(root, ".ssh", "id_ed25519"), "secret");
  writeFileSync(join(root, ".env"), "TOKEN=x");
  writeFileSync(join(root, "notes.txt"), "hello");
  const files = new ProfileFiles({ root, hidden: [join(root, "lounge")] });
  const top = files.browse();
  assert.deepEqual(top.entries.map((e) => e.name), ["lounge", "Pictures", "notes.txt"]);
  assert.equal(files.browse("Pictures").entries[0]!.size, TINY_PNG.length);
  const pic = files.read(join(root, "Pictures", "cat.png"));
  assert.equal(pic.mime, "image/png");
  assert.throws(() => files.read(".ssh/id_ed25519"), code("forbidden"));
  assert.throws(() => files.read(".env"), code("forbidden"));
  assert.throws(() => files.browse("lounge"), code("forbidden"));
  assert.throws(() => files.read(join(h.home, "lounge.db")), code("forbidden"));
  assert.throws(() => files.read("../lounge.db"), code("forbidden"));
  assert.throws(() => files.read("missing.txt"), code("bad_path"));
  assert.throws(() => files.read("Pictures"), code("bad_path"));
  for (const name of ["tokens.json", "server.KEY", "aws_credentials", "Login Data", ".npmrc", "my-password.txt"]) {
    assert.ok(isSecret(name), name);
  }
  assert.ok(!isSecret("photo.png"));
});

test("mcp: an agent stages a file, then posts what it chose", async (t) => {
  const h = db(t);
  const tokens = ensureTokens(h.home, SEED_CALLERS);
  const deps = sessionDeps({ db: h.db, room: h.room, home: h.home });
  writeFileSync(join(deps.files.root(), "notes.txt"), "shopping: milk");
  writeFileSync(join(deps.files.root(), "cat.png"), TINY_PNG);
  const handler = createMcpHandler({ room: h.room, tokens, ...deps });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new Client({ name: "test", version: "0" });
  t.after(async () => {
    await client.close();
    await handler.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address() as AddressInfo;
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.ada}` } },
    }),
  );
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: { type: string; text?: string; mimeType?: string }[] }>;
  const listing = await call("lounge_browse");
  assert.deepEqual(
    (JSON.parse(listing.content[0]!.text!) as { entries: { name: string }[] }).entries.map((e) => e.name),
    ["cat.png", "notes.txt"],
  );
  const note = await call("lounge_attach", { path: "notes.txt" });
  assert.equal(note.content[1]!.text, "shopping: milk");
  const pic = await call("lounge_attach", { path: "cat.png" });
  assert.equal(pic.content[1]!.type, "image");
  const picId = (JSON.parse(pic.content[0]!.text!) as { attachment: { id: string } }).attachment.id;
  // Staging posts nothing.
  assert.equal(h.room.read("lounge").length, 0);
  const posted = await call("lounge_post", { room: "lounge", text: "look!", attachments: [picId] });
  assert.ok(!posted.isError);
  const last = h.room.read("lounge").at(-1)!;
  assert.equal(last.author, "ada");
  assert.equal(last.attachments![0]!.mime, "image/png");
  const outside = await call("lounge_attach", { path: join(h.home, "lounge.db") });
  assert.ok(outside.isError);
  // The screenshot tool is gone.
  assert.ok((await call("lounge_screenshot")).isError);
});

test("http: upload, post, and serve", async (t) => {
  const home = tempHome();
  const core = await startCore({ home: home.dir, port: 0 });
  t.after(async () => {
    await core.close();
    home.cleanup();
  });
  const tokens = ensureTokens(home.dir, SEED_CALLERS);
  const auth = { authorization: `Bearer ${tokens.owner}` };
  const up = await fetch(`${core.url}/api/attachments?name=cat.png`, {
    method: "POST",
    headers: { ...auth, "content-type": "image/png" },
    body: TINY_PNG,
  });
  assert.equal(up.status, 201);
  const att = (await up.json()) as { id: string; name: string };
  const svg = (await (
    await fetch(`${core.url}/api/attachments?name=x.svg`, { method: "POST", headers: { ...auth, "content-type": "image/svg+xml" }, body: "<svg/>" })
  ).json()) as { id: string };
  const post = await fetch(`${core.url}/api/rooms/lounge/messages`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ text: "", attachments: [att.id] }),
  });
  assert.equal(post.status, 201);
  const file = await fetch(`${core.url}/api/attachments/${att.id}/cat.png`);
  assert.equal(file.headers.get("content-type"), "image/png");
  assert.match(file.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), TINY_PNG);
  // SVG can run script: it downloads instead.
  const risky = await fetch(`${core.url}/api/attachments/${svg.id}`);
  assert.equal(risky.headers.get("content-type"), "application/octet-stream");
  assert.match(risky.headers.get("content-disposition") ?? "", /^attachment/);
  assert.equal((await fetch(`${core.url}/api/attachments/${"0".repeat(32)}`)).status, 404);
  assert.equal((await fetch(`${core.url}/api/attachments?name=x`, { method: "POST", body: "x" })).status, 401);
  const bad = await fetch(`${core.url}/api/rooms/lounge/messages`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ text: "x", attachments: ["nope"] }),
  });
  assert.equal(bad.status, 400);
});
