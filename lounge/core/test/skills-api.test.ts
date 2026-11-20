import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startCore } from "../src/api/http.ts";
import { tempHome } from "./helpers.ts";

async function boot(t: TestContext) {
  const home = tempHome();
  const core = await startCore({ home: home.dir, port: 0, schedule: false });
  t.after(async () => {
    await core.close();
    home.cleanup();
  });
  const tokens = JSON.parse(readFileSync(join(home.dir, "tokens.json"), "utf8")) as Record<string, string>;
  const api = (path: string, init: RequestInit & { as?: string | null } = {}) => {
    const { as = "owner", ...rest } = init;
    const headers = new Headers(rest.headers);
    if (rest.body !== undefined) headers.set("content-type", "application/json");
    if (as) headers.set("authorization", `Bearer ${tokens[as]}`);
    return fetch(core.url + path, { ...rest, headers });
  };
  return { home, api };
}

const json = (body: unknown) => JSON.stringify(body);

test("skills api: an empty home lists no skill and names the folder", async (t) => {
  const h = await boot(t);
  const res = await h.api("/api/skills");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { folder: join(h.home.dir, "skills"), skills: [], skipped: [] });
});

test("skills api: create, read, replace, and remove one skill", async (t) => {
  const h = await boot(t);
  const made = await h.api("/api/skills", {
    method: "POST",
    body: json({ name: "wiki", description: "Wiki rules.", body: "body one" }),
  });
  assert.equal(made.status, 201);
  assert.equal(((await made.json()) as { name: string }).name, "wiki");

  const listed = (await (await h.api("/api/skills")).json()) as { skills: { name: string; description: string }[] };
  assert.deepEqual(
    listed.skills.map((s) => [s.name, s.description]),
    [["wiki", "Wiki rules."]],
  );

  const one = (await (await h.api("/api/skills/wiki")).json()) as { name: string; text: string };
  assert.equal(one.name, "wiki");
  assert.match(one.text, /body one/);

  const text = `---\nname: wiki\ndescription: "New."\n---\n\nbody two\n`;
  const put = await h.api("/api/skills/wiki", { method: "PUT", body: json({ text }) });
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { name: "wiki", text });
  assert.equal(readFileSync(join(h.home.dir, "skills", "wiki", "SKILL.md"), "utf8"), text);

  const gone = await h.api("/api/skills/wiki", { method: "DELETE" });
  assert.equal(gone.status, 204);
  assert.equal(existsSync(join(h.home.dir, "skills", "wiki")), false);
  assert.deepEqual(((await (await h.api("/api/skills")).json()) as { skills: unknown[] }).skills, []);
});

test("skills api: an unknown skill is 404, a duplicate is 409, a bad body is 400", async (t) => {
  const h = await boot(t);
  assert.equal((await h.api("/api/skills/nothing")).status, 404);
  assert.equal((await h.api("/api/skills/nothing", { method: "PUT", body: json({ text: "x" }) })).status, 404);
  assert.equal((await h.api("/api/skills/nothing", { method: "DELETE" })).status, 404);
  const body = json({ name: "wiki", description: "d", body: "b" });
  assert.equal((await h.api("/api/skills", { method: "POST", body })).status, 201);
  assert.equal((await h.api("/api/skills", { method: "POST", body })).status, 409);
  assert.equal((await h.api("/api/skills", { method: "POST", body: json({ name: "Bad Name", description: "d", body: "b" }) })).status, 400);
  assert.equal((await h.api("/api/skills/wiki", { method: "PUT", body: json({ text: "no front matter" }) })).status, 400);
  assert.equal((await h.api("/api/skills", { method: "PATCH" })).status, 405);
});

test("skills api: every route needs the owner token", async (t) => {
  const h = await boot(t);
  for (const as of [null, "ada"]) {
    const expected = as === null ? 401 : 403;
    assert.equal((await h.api("/api/skills", { as })).status, expected, `GET list as ${as}`);
    assert.equal((await h.api("/api/skills/wiki", { as })).status, expected, `GET one as ${as}`);
    assert.equal(
      (await h.api("/api/skills", { as, method: "POST", body: json({ name: "x", description: "d", body: "b" }) })).status,
      expected,
      `POST as ${as}`,
    );
    assert.equal((await h.api("/api/skills/wiki", { as, method: "DELETE" })).status, expected, `DELETE as ${as}`);
  }
});
