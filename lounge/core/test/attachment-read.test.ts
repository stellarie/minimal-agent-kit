import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Grants } from "../src/auth/grants.ts";
import { ensureTokens } from "../src/auth/tokens.ts";
import { openDb } from "../src/db/db.ts";
import type { Attachment } from "../src/lounge/attachments.ts";
import { Room } from "../src/lounge/room.ts";
import { createMcpHandler } from "../src/mcp/server.ts";
import { SEED_CALLERS, TINY_PNG, sessionDeps, tempHome } from "./helpers.ts";

type Item = { type: string; text?: string; data?: string; mimeType?: string };

async function setup(t: TestContext) {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  const room = new Room(db);
  const tokens = ensureTokens(home.dir, SEED_CALLERS);
  const deps = sessionDeps({ db, room, home: home.dir });
  const grants = new Grants(db);
  const handler = createMcpHandler({ room, tokens, ...deps, grants });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    await handler.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    home.cleanup();
  });
  const connect = async (token: string): Promise<Client> => {
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    const client = new Client({ name: "test-reader", version: "0.0.0" });
    await client.connect(transport);
    clients.push(client);
    return client;
  };
  // A file that a message in the room holds.
  const post = (roomId: string, name: string, data: Buffer, given?: string): Attachment => {
    const att = deps.attachments.save("ada", name, data, given);
    room.post("ada", roomId, "a file", "text", [att]);
    deps.attachments.markPosted([att]);
    return att;
  };
  const read = async (client: Client, id: string) => {
    const result = (await client.callTool({ name: "lounge_attachment_read", arguments: { id } })) as {
      isError?: boolean;
      content: Item[];
    };
    return result;
  };
  return { home: home.dir, room, tokens, deps, grants, connect, post, read };
}

const meta = (att: Attachment) => ({ id: att.id, name: att.name, mime: att.mime, size: att.size });

test("a posted PNG returns the facts and one image item", async (t) => {
  const h = await setup(t);
  const att = h.post("lounge", "pic.png", TINY_PNG);
  const result = await h.read(await h.connect(h.tokens.cyd), att.id);
  assert.notEqual(result.isError, true);
  assert.equal(result.content.length, 2);
  assert.equal(result.content[0]!.type, "text");
  assert.deepEqual(JSON.parse(result.content[0]!.text!), meta(att));
  assert.equal(result.content[1]!.type, "image");
  assert.equal(result.content[1]!.mimeType, "image/png");
  assert.equal(result.content[1]!.data, TINY_PNG.toString("base64"));
});

test("a posted text file returns the text; a text over 64 KiB is cut", async (t) => {
  const h = await setup(t);
  const client = await h.connect(h.tokens.ada);
  const small = h.post("lounge", "notes.txt", Buffer.from("hello notes"));
  const got = await h.read(client, small.id);
  assert.deepEqual(got.content.map((c) => c.type), ["text", "text"]);
  assert.deepEqual(JSON.parse(got.content[0]!.text!), meta(small));
  assert.equal(got.content[1]!.text, "hello notes");

  const exact = h.post("lounge", "exact.txt", Buffer.alloc(64 * 1024, "a"));
  const whole = await h.read(client, exact.id);
  assert.equal(whole.content[1]!.text, "a".repeat(64 * 1024));

  const big = h.post("lounge", "big.json", Buffer.alloc(64 * 1024 + 10, "b"));
  const cut = await h.read(client, big.id);
  assert.equal(cut.content.length, 2);
  assert.equal(cut.content[1]!.text, `${"b".repeat(64 * 1024)}\n[cut]`);
});

test("another type returns the name, MIME type, and size only", async (t) => {
  const h = await setup(t);
  const client = await h.connect(h.tokens.ada);
  const zip = h.post("lounge", "bundle.zip", Buffer.from("PK-not-really"));
  const got = await h.read(client, zip.id);
  assert.equal(got.content.length, 1);
  assert.deepEqual(JSON.parse(got.content[0]!.text!), { id: zip.id, name: "bundle.zip", mime: "application/zip", size: 13 });
});

test("an image over 3 MiB returns the facts only", async (t) => {
  const h = await setup(t);
  const client = await h.connect(h.tokens.ada);
  const edge = h.post("lounge", "edge.png", Buffer.alloc(3 * 1024 * 1024, 1));
  assert.equal((await h.read(client, edge.id)).content.length, 2);
  const huge = h.post("lounge", "huge.png", Buffer.alloc(3 * 1024 * 1024 + 1, 1));
  const got = await h.read(client, huge.id);
  assert.equal(got.content.length, 1);
  assert.equal(JSON.parse(got.content[0]!.text!).size, 3 * 1024 * 1024 + 1);
});

test("an id that no message holds gets unknown_attachment", async (t) => {
  const h = await setup(t);
  const client = await h.connect(h.tokens.ada);
  const staged = h.deps.attachments.save("ada", "draft.txt", Buffer.from("not posted"));
  for (const id of [staged.id, "0".repeat(32), "nope", ""]) {
    const got = await h.read(client, id);
    assert.equal(got.isError, true, id);
    assert.match(got.content[0]!.text!, /^unknown_attachment: /, id);
  }
});

test("a missing stored file gets unknown_attachment", async (t) => {
  const h = await setup(t);
  const client = await h.connect(h.tokens.ada);
  const att = h.post("lounge", "gone.txt", Buffer.from("soon gone"));
  rmSync(h.deps.attachments.file(att.id));
  const got = await h.read(client, att.id);
  assert.equal(got.isError, true);
  assert.match(got.content[0]!.text!, /^unknown_attachment: /);
});

test("an agent reads a thread file and a channel file", async (t) => {
  const h = await setup(t);
  const thread = h.room.createThread("lounge", "work", "ada");
  const inThread = h.post(thread.id, "secret.txt", Buffer.from("thread only"));
  const inChannel = h.post("lounge", "open.txt", Buffer.from("channel file"));

  const member = await h.connect(h.tokens.cyd);
  assert.equal((await h.read(member, inThread.id)).content[1]!.text, "thread only");
  assert.equal((await h.read(member, inChannel.id)).content[1]!.text, "channel file");
});

test("a file that both a thread and a channel hold lists both rooms", async (t) => {
  const h = await setup(t);
  const thread = h.room.createThread("lounge", "work", "ada");
  const att = h.post(thread.id, "shared.txt", Buffer.from("both"));
  h.room.post("ada", "lounge", "again", "text", [att]);
  assert.deepEqual(h.deps.attachments.rooms(att.id).sort(), ["lounge", thread.id].sort());
});

test("rooms lists each room once and ignores other ids", async (t) => {
  const h = await setup(t);
  const a = h.post("lounge", "a.txt", Buffer.from("a"));
  const b = h.post("lounge", "b.txt", Buffer.from("b"));
  h.room.post("ada", "lounge", "a again", "text", [a]);
  assert.deepEqual(h.deps.attachments.rooms(a.id), ["lounge"]);
  assert.deepEqual(h.deps.attachments.rooms(b.id), ["lounge"]);
  assert.deepEqual(h.deps.attachments.rooms("0".repeat(32)), []);
  assert.deepEqual(h.deps.attachments.rooms("%"), []);
});

test("an agent without the chat grant gets forbidden", async (t) => {
  const h = await setup(t);
  const att = h.post("lounge", "open.txt", Buffer.from("channel file"));
  h.grants.set("cyd", { chat: false });
  const denied = await h.read(await h.connect(h.tokens.cyd), att.id);
  assert.equal(denied.isError, true);
  assert.match(denied.content[0]!.text!, /^forbidden: /);
  assert.equal((await h.read(await h.connect(h.tokens.ada), att.id)).isError, undefined);
});
