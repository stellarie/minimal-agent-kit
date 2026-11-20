import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCore } from "../src/api/http.ts";
import { HttpError } from "../src/api/http-error.ts";
import { Wiki, wikiDir } from "../src/wiki/wiki.ts";
import { fakeKinds, tempHome } from "./helpers.ts";
import { unavailableAdapter } from "../src/adapters/stub.ts";

const PAGE =
  "---\ntitle: Alpha\nupdated: 2026-02-14\nsource_commit: abc1234\ntags: [standards, gotcha]\n---\n\n" +
  "## Summary\nAlpha does one thing.\n\n## Facts\n- It reads a file (`a.py:1`)\n\n" +
  "## Decisions\n- Keep it flat: simple (2026-02-14)\n\n## Gotchas\n- Trap: fix\n";
const INDEX = "# Wiki index\n- [Alpha](alpha.md): the alpha page\n";

interface Fixture {
  dir: string;
  project: string;
  root: string;
  folder: string;
}

// Every test works in its own temp tree. No test reads the real wiki root.
function fixture(t: TestContext): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "wiki-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const project = join(dir, "proj");
  const root = join(dir, "notes");
  mkdirSync(project);
  mkdirSync(root);
  return { dir, project, root, folder: join(root, "proj") };
}

function seeded(fx: Fixture): Wiki {
  mkdirSync(fx.folder);
  writeFileSync(join(fx.folder, "index.md"), INDEX);
  writeFileSync(join(fx.folder, "alpha.md"), PAGE);
  return new Wiki({ project: fx.project, root: fx.root });
}

function refused(code: string, status: number) {
  return (err: unknown) => {
    assert.ok(err instanceof HttpError, String(err));
    assert.deepEqual([err.status, err.code], [status, code]);
    return true;
  };
}

test("c6_1_root_unset", () => {
  const project = join(tmpdir(), "p");
  assert.equal(wikiDir(project, undefined, undefined), join(project, "docs", "wiki"));
  assert.equal(wikiDir(project, "", "named"), join(project, "docs", "wiki"));
  assert.equal(wikiDir(project, "  \t", undefined), join(project, "docs", "wiki"));
});

test("c6_1_root_name", () => {
  const project = join(tmpdir(), "p", "proj");
  const root = join(tmpdir(), "notes");
  assert.equal(wikiDir(project, root, "shared"), join(root, "shared"));
  assert.equal(wikiDir(project, root, undefined), join(root, "proj"));
  assert.equal(wikiDir(project, ` ${root} `, "  "), join(root, "proj"));
  assert.equal(wikiDir(project, "~/notes", "shared"), join(process.env.USERPROFILE ?? process.env.HOME ?? "~", "notes", "shared"));
});

test("c6_1_bad_name", () => {
  const project = join(tmpdir(), "proj");
  const root = join(tmpdir(), "notes");
  for (const name of ["..", ".", "a/b", "a\\b", "C:x", "C:", "../x"]) {
    assert.equal(wikiDir(project, root, name), null, name);
  }
});

test("c6_2_exit0", (t) => {
  const fx = fixture(t);
  const wiki = seeded(fx);
  const done = wiki.write("alpha.md", PAGE);
  assert.deepEqual(done, { name: "alpha.md", findings: [], fail: false });
  assert.equal(readFileSync(join(fx.folder, "alpha.md"), "utf8"), PAGE);
});

test("c6_2_exit1", (t) => {
  const fx = fixture(t);
  const wiki = seeded(fx);
  const done = wiki.write("Bad_Name.md", "no frontmatter");
  assert.equal(done.fail, true);
  for (const key of ["id", "check", "level", "file", "line", "detail"]) {
    assert.ok(done.findings.every((f) => key in f), key);
  }
  assert.ok(done.findings.some((f) => f.level === "fail" && f.check === "name"));
  // The page is saved: the findings tell the owner what to fix.
  assert.equal(readFileSync(join(fx.folder, "Bad_Name.md"), "utf8"), "no frontmatter");
});

test("c6_2_not_run", (t) => {
  const fx = fixture(t);
  const wiki = seeded(fx);
  writeFileSync(join(fx.folder, "index.md"), `${INDEX}- [Odd](odd.md): not utf-8\n`);
  writeFileSync(join(fx.folder, "odd.md"), Buffer.from([0xff, 0xfe, 0x80, 0x81]));
  const done = wiki.write("alpha.md", PAGE);
  assert.deepEqual(
    done.findings.map((f) => [f.id, f.level]),
    [["unread:odd.md", "not-run"]],
  );
  assert.equal(done.fail, false);
});

test("c6_2_spawn_error", (t) => {
  const fx = fixture(t);
  seeded(fx);
  const wiki = new Wiki({ project: fx.project, root: fx.root, python: "no-such-python-for-the-wiki-test" });
  const done = wiki.write("alpha.md", PAGE);
  assert.equal(done.findings.length, 1);
  assert.equal(done.findings[0]?.level, "not-run");
  assert.equal(done.findings[0]?.check, "wiki_check");
  assert.equal(done.fail, false);
  assert.equal(readFileSync(join(fx.folder, "alpha.md"), "utf8"), PAGE);
});

test("c6_2_other_exit_is_not_run", (t) => {
  const fx = fixture(t);
  seeded(fx);
  // A missing script gives exit 2, and a bare stub gives no JSON. Neither reads as a pass.
  const wiki = new Wiki({ project: fx.project, root: fx.root, script: join(fx.dir, "missing.py") });
  const done = wiki.write("alpha.md", PAGE);
  assert.deepEqual(
    done.findings.map((f) => f.level),
    ["not-run"],
  );
  assert.equal(done.fail, false);
});

test("wiki write rejects a page name that is not one plain .md file name", (t) => {
  const fx = fixture(t);
  const wiki = seeded(fx);
  const names = [
    "../x.md", "..\\x.md", "a/b.md", "a\\b.md", "/abs.md", "C:x.md", "C:\\x.md", "x.md:stream",
    "x.txt", "x", ".md", "..md", "con.md", "NUL.md", "x\0.md", "",
  ];
  for (const name of names) {
    assert.throws(() => wiki.write(name, PAGE), refused("bad_page", 400), JSON.stringify(name));
    assert.throws(() => wiki.read(name), refused("bad_page", 400), JSON.stringify(name));
  }
  assert.equal(existsSync(join(fx.dir, "x.md")), false);
  assert.equal(existsSync(join(fx.root, "x.md")), false);
});

test("wiki write refuses a folder that is a link out of the wiki root", (t) => {
  const fx = fixture(t);
  const outside = join(fx.dir, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.md"), "outside");
  try {
    symlinkSync(outside, fx.folder, "junction");
  } catch (err) {
    t.skip(`cannot link a folder: ${String(err)}`);
    return;
  }
  const wiki = new Wiki({ project: fx.project, root: fx.root });
  assert.throws(() => wiki.write("new.md", PAGE), refused("forbidden", 403));
  assert.throws(() => wiki.read("secret.md"), refused("forbidden", 403));
  assert.throws(() => wiki.list(), refused("forbidden", 403));
  assert.equal(existsSync(join(outside, "new.md")), false);
});

test("wiki write refuses a page that is a link out of the wiki folder", (t) => {
  const fx = fixture(t);
  const wiki = seeded(fx);
  const target = join(fx.dir, "target.md");
  writeFileSync(target, "outside");
  try {
    symlinkSync(target, join(fx.folder, "leak.md"), "file");
  } catch (err) {
    t.skip(`cannot link a file: ${String(err)}`);
    return;
  }
  assert.throws(() => wiki.write("leak.md", PAGE), refused("forbidden", 403));
  assert.throws(() => wiki.read("leak.md"), refused("forbidden", 403));
  assert.equal(readFileSync(target, "utf8"), "outside");
  assert.equal(wiki.list().pages.includes("leak.md"), false);
});

test("wiki list and read: a missing folder lists nothing, a missing page is unknown_page", (t) => {
  const fx = fixture(t);
  const wiki = new Wiki({ project: fx.project, root: fx.root });
  assert.deepEqual(wiki.list(), { folder: fx.folder, pages: [] });
  assert.throws(() => wiki.read("alpha.md"), refused("unknown_page", 404));
});

test("wiki write creates the folder under the root and lists only md files", (t) => {
  const fx = fixture(t);
  const wiki = new Wiki({ project: fx.project, root: fx.root });
  wiki.write("alpha.md", PAGE);
  writeFileSync(join(fx.folder, "notes.txt"), "x");
  mkdirSync(join(fx.folder, "sub.md"));
  assert.deepEqual(wiki.list().pages, ["alpha.md"]);
  assert.equal(wiki.read("alpha.md"), PAGE);
});

test("wiki with a name that is a path has no folder", (t) => {
  const fx = fixture(t);
  const wiki = new Wiki({ project: fx.project, root: fx.root, name: "../escape" });
  assert.throws(() => wiki.list(), refused("no_wiki", 400));
  assert.throws(() => wiki.write("alpha.md", PAGE), refused("no_wiki", 400));
});

interface Harness {
  api(path: string, init?: RequestInit & { as?: "owner" | null }): Promise<Response>;
}

async function boot(t: TestContext, wiki: ConstructorParameters<typeof Wiki>[0]): Promise<Harness> {
  const home = tempHome();
  const runtimes = fakeKinds(() => unavailableAdapter("claude", "test stub")).filter((k) => k.id === "claude-code");
  const core = await startCore({ home: home.dir, port: 0, runtimes, wiki });
  t.after(async () => {
    await core.close();
    home.cleanup();
  });
  const tokens = JSON.parse(readFileSync(join(home.dir, "tokens.json"), "utf8")) as Record<string, string>;
  return {
    api(path, init = {}) {
      const { as = "owner", ...rest } = init;
      const headers = new Headers(rest.headers);
      if (rest.body !== undefined) headers.set("content-type", "application/json");
      if (as) headers.set("authorization", `Bearer ${tokens[as]}`);
      return fetch(core.url + path, { ...rest, headers });
    },
  };
}

test("sc10: with WIKI_ROOT unset the pages come from the project docs/wiki folder", async (t) => {
  const fx = fixture(t);
  const folder = join(fx.project, "docs", "wiki");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "alpha.md"), PAGE);
  const h = await boot(t, { project: fx.project });
  const listed = await h.api("/api/wiki/pages");
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), { folder, pages: ["alpha.md"] });
  const page = await h.api("/api/wiki/pages/alpha.md");
  assert.deepEqual(await page.json(), { name: "alpha.md", text: PAGE });
});

test("sc11: with python missing a saved page returns a not-run finding", async (t) => {
  const fx = fixture(t);
  const h = await boot(t, { project: fx.project, root: fx.root, python: "no-such-python-for-the-wiki-test" });
  const put = await h.api("/api/wiki/pages/alpha.md", { method: "PUT", body: JSON.stringify({ text: PAGE }) });
  assert.equal(put.status, 200);
  const body = (await put.json()) as { name: string; findings: { level: string }[]; fail: boolean };
  assert.equal(body.name, "alpha.md");
  assert.deepEqual(body.findings.map((f) => f.level), ["not-run"]);
  assert.equal(body.fail, false);
  assert.equal(readFileSync(join(fx.folder, "alpha.md"), "utf8"), PAGE);
});

test("wiki routes need the owner token, and refuse a bad name, a bad body, and a wrong method", async (t) => {
  const fx = fixture(t);
  const h = await boot(t, { project: fx.project, root: fx.root });
  assert.equal((await h.api("/api/wiki/pages", { as: null })).status, 401);
  assert.equal((await h.api("/api/wiki/pages", { method: "POST", body: "{}" })).status, 405);
  assert.equal((await h.api("/api/wiki/pages/missing.md")).status, 404);
  const slash = await h.api("/api/wiki/pages/a%2Fb.md", { method: "PUT", body: JSON.stringify({ text: PAGE }) });
  assert.equal(slash.status, 400);
  assert.equal(((await slash.json()) as { error: string }).error, "bad_page");
  const noText = await h.api("/api/wiki/pages/alpha.md", { method: "PUT", body: JSON.stringify({ text: 3 }) });
  assert.equal(noText.status, 400);
  assert.equal(existsSync(join(fx.folder, "alpha.md")), false);
});
