import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexLogin, codexHomeOf, findCodex } from "../src/api/codex-login.ts";
import { startCore } from "../src/api/http.ts";
import {
  CODEX_NOT_SIGNED_IN,
  codexIsolationArgs,
  codexSignInReason,
} from "../../plugins/codex/isolate.ts";
import { tempHome } from "./helpers.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-codex.mjs");

interface LogEntry {
  argv: string[];
  codexHome: string;
  pid: number;
}

function rig(t: TestContext, mode: string) {
  const home = tempHome();
  const log = join(home.dir, "fake-codex.log");
  const prev = { mode: process.env.FAKE_CODEX_MODE, log: process.env.FAKE_CODEX_LOG };
  process.env.FAKE_CODEX_MODE = mode;
  process.env.FAKE_CODEX_LOG = log;
  const login = new CodexLogin({ home: home.dir, cli: () => ({ command: process.execPath, commandArgs: [fixture] }) });
  t.after(async () => {
    await login.close();
    if (prev.mode === undefined) delete process.env.FAKE_CODEX_MODE;
    else process.env.FAKE_CODEX_MODE = prev.mode;
    if (prev.log === undefined) delete process.env.FAKE_CODEX_LOG;
    else process.env.FAKE_CODEX_LOG = prev.log;
    home.cleanup();
  });
  const entries = (): LogEntry[] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as LogEntry)
      : [];
  return { home: home.dir, login, entries };
}

async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out: ${what}`);
}

test("c11_3_codex_isolation_args: CODEX_HOME is the codex-home folder of the lounge home, and the user config is not ignored", () => {
  const iso = codexIsolationArgs("X:\\lounge-home");
  assert.deepEqual(iso.env, { CODEX_HOME: join("X:\\lounge-home", "codex-home") });
  assert.equal(codexHomeOf("X:\\lounge-home"), join("X:\\lounge-home", "codex-home"));
  // --ignore-user-config alone left the user's AGENTS.md and skills in place.
  assert.ok(!iso.args.includes("--ignore-user-config"));
  // The sign-in lives in a file of that folder, so the lounge can see it.
  assert.deepEqual(iso.args, ["-c", 'cli_auth_credentials_store="file"']);
});

test("c11_3_never_copies_auth: no code of the lounge copies an auth file", () => {
  const sources = [
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "api", "codex-login.ts"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "codex", "isolate.ts"),
  ];
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /copyFile|cpSync|\.codex["'/\\]/, file);
    assert.doesNotMatch(text, /readFileSync[^\n]*auth/, file);
  }
});

test("c11_3_sign_in: the action runs codex login with CODEX_HOME in the lounge home, and shows the sign-in URL", async (t) => {
  const r = rig(t, "hang");
  assert.deepEqual(await r.login.status(), { state: "signed-out" });
  const started = await r.login.start();
  assert.equal(started.state, "running");
  await until(async () => (await r.login.status()).url !== undefined, "the URL");
  const view = await r.login.status();
  assert.equal(view.state, "running");
  assert.equal(view.url, "https://auth.example.test/oauth/authorize?state=abc");
  const login = r.entries().find((e) => e.argv.includes("login") && !e.argv.includes("status"))!;
  assert.equal(login.codexHome, join(r.home, "codex-home"));
  assert.deepEqual(login.argv, ["-c", 'cli_auth_credentials_store="file"', "login"]);
  // A second press starts no second process.
  assert.equal((await r.login.start()).state, "running");
  assert.equal(r.entries().filter((e) => e.argv.includes("login") && !e.argv.includes("status")).length, 1);
});

test("c11_3_sign_in: a finished login shows signed in, and the running state ends", async (t) => {
  const r = rig(t, "ok");
  await r.login.start();
  await until(async () => (await r.login.status()).state === "signed-in", "signed in");
  assert.deepEqual(await r.login.status(), { state: "signed-in" });
  assert.ok(existsSync(join(r.home, "codex-home", "auth.json")));
});

test("c11_3_sign_in: a failed login shows signed out with the last error line", async (t) => {
  const r = rig(t, "fail");
  await r.login.start();
  await until(async () => (await r.login.status()).error !== undefined, "the error");
  assert.deepEqual(await r.login.status(), { state: "signed-out", error: "login failed: access denied" });
});

test("c11_3_sign_in: cancel stops the login process", async (t) => {
  const r = rig(t, "hang");
  await r.login.start();
  await until(() => r.entries().length > 0, "the process");
  const pid = r.entries()[0]!.pid;
  assert.equal((await r.login.cancel()).state, "signed-out");
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ESRCH";
    }
  }, "the process is gone");
});

test("c11_3_not_signed_in: a Codex turn with no login gets the sign-in message and runs nothing", async (t) => {
  const r = rig(t, "ok");
  const reason = await codexSignInReason(r.home, { command: process.execPath, commandArgs: [fixture] });
  assert.equal(reason, "Codex not signed in: use Sign in to Codex");
  assert.equal(reason, CODEX_NOT_SIGNED_IN);
  // Only the status call ran: no turn.
  assert.ok(r.entries().every((e) => e.argv.includes("status")));
  mkdirSync(join(r.home, "codex-home"), { recursive: true });
  writeFileSync(join(r.home, "codex-home", "auth.json"), '{"test": true}');
  assert.equal(await codexSignInReason(r.home, { command: process.execPath, commandArgs: [fixture] }), undefined);
});

test("c11_3_not_signed_in: a command that cannot start gives the sign-in message too", async (t) => {
  const r = rig(t, "ok");
  assert.equal(await codexSignInReason(r.home, { command: "definitely-not-a-command-xyz" }), CODEX_NOT_SIGNED_IN);
});

test("findCodex picks the folder that holds codex.exe, and keeps a given path", (t) => {
  const home = tempHome();
  t.after(() => home.cleanup());
  const bin = join(home.dir, "OpenAI", "Codex", "bin");
  mkdirSync(join(bin, "aaaa"), { recursive: true });
  mkdirSync(join(bin, "bbbb"), { recursive: true });
  writeFileSync(join(bin, "aaaa", "rg.exe"), "");
  writeFileSync(join(bin, "bbbb", "codex.exe"), "");
  const env = { LOCALAPPDATA: home.dir };
  assert.equal(findCodex("codex", env), join(bin, "bbbb", "codex.exe"));
  assert.equal(findCodex("codex.exe", env), join(bin, "bbbb", "codex.exe"));
  assert.equal(findCodex("D:\\tools\\codex.exe", env), "D:\\tools\\codex.exe");
  assert.equal(findCodex("codex", { LOCALAPPDATA: join(home.dir, "none") }), "codex");
  assert.equal(findCodex("codex", {}), "codex");
});

test("codex login routes: the owner reads the state and starts a sign-in with the codex agent command", async (t) => {
  const home = tempHome();
  writeFileSync(
    join(home.dir, "config.json"),
    JSON.stringify({ adapters: { bea: { enabled: false, command: process.execPath, commandArgs: [fixture] } } }),
  );
  const log = join(home.dir, "fake-codex.log");
  const prev = { mode: process.env.FAKE_CODEX_MODE, log: process.env.FAKE_CODEX_LOG };
  process.env.FAKE_CODEX_MODE = "hang";
  process.env.FAKE_CODEX_LOG = log;
  const core = await startCore({ home: home.dir, port: 0, schedule: false });
  t.after(async () => {
    await core.close();
    if (prev.mode === undefined) delete process.env.FAKE_CODEX_MODE;
    else process.env.FAKE_CODEX_MODE = prev.mode;
    if (prev.log === undefined) delete process.env.FAKE_CODEX_LOG;
    else process.env.FAKE_CODEX_LOG = prev.log;
    home.cleanup();
  });
  const tokens = JSON.parse(readFileSync(join(home.dir, "tokens.json"), "utf8")) as Record<string, string>;
  const api = (method: string, as: string | null = "owner") =>
    fetch(`${core.url}/api/codex/login`, { method, headers: as ? { authorization: `Bearer ${tokens[as]}` } : {} });
  for (const as of [null, "ada"]) {
    for (const method of ["GET", "POST", "DELETE"]) {
      assert.equal((await api(method, as)).status, as === null ? 401 : 403, `${method} as ${as}`);
    }
  }
  assert.deepEqual(await (await api("GET")).json(), { state: "signed-out" });
  const started = await api("POST");
  assert.equal(started.status, 200);
  assert.equal(((await started.json()) as { state: string }).state, "running");
  await until(() => existsSync(log) && readFileSync(log, "utf8").includes('"login"'), "the login process");
  assert.equal(((await (await api("GET")).json()) as { state: string }).state, "running");
  assert.equal(((await (await api("DELETE")).json()) as { state: string }).state, "signed-out");
  assert.equal((await api("PUT")).status, 405);
});
