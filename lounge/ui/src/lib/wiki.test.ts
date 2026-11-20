import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, createHttpClient } from "./api.ts";

interface Seen {
  url: string;
  method: string;
  body: string | undefined;
  auth: string | undefined;
}

function fakeFetch(t: { after(fn: () => void): void }, reply: (seen: Seen) => Response): Seen[] {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const entry = {
      url,
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : String(init.body),
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
    };
    seen.push(entry);
    return reply(entry);
  }) as typeof fetch;
  return seen;
}

test("the live client lists and reads wiki pages with the owner token", async (t) => {
  const seen = fakeFetch(t, ({ url }) =>
    url === "/api/wiki/pages"
      ? new Response(JSON.stringify({ folder: "w", pages: ["a.md"] }))
      : new Response(JSON.stringify({ name: "a b.md", text: "# x" })),
  );
  const client = createHttpClient("tok");
  assert.deepEqual(await client.wikiPages(), { folder: "w", pages: ["a.md"] });
  assert.deepEqual(await client.wikiPage("a b.md"), { name: "a b.md", text: "# x" });
  assert.deepEqual(
    seen.map((s) => [s.method, s.url, s.auth]),
    [
      ["GET", "/api/wiki/pages", "Bearer tok"],
      ["GET", "/api/wiki/pages/a%20b.md", "Bearer tok"],
    ],
  );
});

test("sc11: saving a page returns the findings, a not-run finding included", async (t) => {
  const finding = { id: "wiki_check:not-run", check: "wiki_check", level: "not-run", file: "", line: 0, detail: "python did not run" };
  const seen = fakeFetch(t, () => new Response(JSON.stringify({ name: "a.md", findings: [finding], fail: false })));
  const saved = await createHttpClient("tok").saveWikiPage("a.md", "text\n");
  assert.deepEqual(saved, { name: "a.md", findings: [finding], fail: false });
  assert.deepEqual([seen[0]?.method, seen[0]?.url, seen[0]?.body], ["PUT", "/api/wiki/pages/a.md", JSON.stringify({ text: "text\n" })]);
});

test("a refused wiki save shows the core message", async (t) => {
  fakeFetch(t, () => new Response(JSON.stringify({ error: "bad_page", message: "a page name is one file name" }), { status: 400 }));
  await assert.rejects(createHttpClient("tok").saveWikiPage("../x.md", ""), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.message, "a page name is one file name");
    return true;
  });
});
