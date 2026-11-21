import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Fetch } from "../src/update/check.ts";
import { stageRelease } from "../src/update/stage.ts";
import { tempHome } from "./helpers.ts";

const VERSION = "0.10.0";
const ZIP = `minimal-agent-kit-lounge-${VERSION}-windows.zip`;
const TAR = "C:/Windows/System32/tar.exe";

function signing() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = randomBytes(8);
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const pub = `untrusted comment: minisign public key\n${Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64")}\n`;
  return {
    pub,
    sign(file: Buffer): string {
      const body = sign(null, createHash("blake2b512").update(file).digest(), privateKey);
      const global = sign(null, Buffer.concat([body, Buffer.from("t")]), privateKey);
      const head = Buffer.concat([Buffer.from("ED"), keyId, body]).toString("base64");
      return `untrusted comment: signature\n${head}\ntrusted comment: t\n${global.toString("base64")}\n`;
    },
  };
}

function buildZip(dir: string, opts: { version?: string; exe?: boolean } = {}): Buffer {
  const tree = join(dir, "tree");
  const lounge = join(tree, "lounge");
  mkdirSync(join(lounge, "core", "src"), { recursive: true });
  writeFileSync(join(lounge, "core", "src", "main.ts"), "x");
  writeFileSync(join(lounge, "core", "package.json"), JSON.stringify({ version: opts.version ?? VERSION }));
  writeFileSync(join(lounge, "update.pub"), "pub");
  if (opts.exe !== false) writeFileSync(join(lounge, "agent-lounge.exe"), "x");
  const out = join(dir, "built.zip");
  execFileSync(TAR, ["-a", "-cf", out, "-C", tree, "lounge"]);
  const bytes = readFileSync(out);
  rmSync(tree, { recursive: true, force: true });
  return bytes;
}

interface Setup {
  home: string;
  installRoot: string;
  keys: ReturnType<typeof signing>;
  fetched: string[];
  run(zip: Buffer, opts?: { sigOf?: Buffer; skip?: "zip" | "sig"; status?: number }): ReturnType<typeof stageRelease>;
  scratch: string;
}

function setup(t: TestContext): Setup {
  const home = tempHome();
  const scratch = tempHome();
  t.after(() => {
    home.cleanup();
    scratch.cleanup();
  });
  const keys = signing();
  const installRoot = join(scratch.dir, "install");
  mkdirSync(join(installRoot, "lounge"), { recursive: true });
  writeFileSync(join(installRoot, "lounge", "update.pub"), keys.pub);
  const fetched: string[] = [];
  return {
    home: home.dir,
    installRoot,
    keys,
    fetched,
    scratch: scratch.dir,
    run(zip, opts = {}) {
      const files = new Map<string, Buffer>([
        [`https://example.test/${ZIP}`, zip],
        [`https://example.test/${ZIP}.minisig`, Buffer.from(keys.sign(opts.sigOf ?? zip))],
      ]);
      const fetch: Fetch = async (url) => {
        fetched.push(url);
        const body = files.get(url);
        return body ? new Response(body, { status: opts.status ?? 200 }) : new Response("", { status: 404 });
      };
      const assets = [
        { name: ZIP, url: `https://example.test/${ZIP}` },
        { name: `${ZIP}.minisig`, url: `https://example.test/${ZIP}.minisig` },
      ].filter((a) => !(opts.skip === "zip" && a.name === ZIP) && !(opts.skip === "sig" && a.name !== ZIP));
      return stageRelease({
        release: { version: VERSION, assets },
        fetch,
        home: this.home,
        installRoot: this.installRoot,
      });
    },
  };
}

const staged = (home: string) => join(home, "updates", VERSION);

test("c4_1: good release writes ready.json", async (t) => {
  const s = setup(t);
  const result = await s.run(buildZip(s.scratch));
  assert.deepEqual(result, { state: "ready", version: VERSION });
  const ready = JSON.parse(readFileSync(join(staged(s.home), "ready.json"), "utf8"));
  assert.deepEqual(ready, { version: VERSION, root: join(staged(s.home), "root") });
  assert.ok(existsSync(join(ready.root, "lounge", "agent-lounge.exe")));
});

test("c4_1: missing zip asset fails before download", async (t) => {
  const s = setup(t);
  assert.deepEqual(await s.run(buildZip(s.scratch), { skip: "zip" }), { state: "error", reason: "asset" });
  assert.deepEqual(s.fetched, []);
  assert.equal(existsSync(join(s.home, "updates")), false);
});

test("c4_1: missing minisig asset fails before download", async (t) => {
  const s = setup(t);
  assert.deepEqual(await s.run(buildZip(s.scratch), { skip: "sig" }), { state: "error", reason: "asset" });
  assert.deepEqual(s.fetched, []);
  assert.equal(existsSync(join(s.home, "updates")), false);
});

test("c4_1: bad signature leaves no staged tree", async (t) => {
  const s = setup(t);
  const result = await s.run(buildZip(s.scratch), { sigOf: Buffer.from("other bytes") });
  assert.deepEqual(result, { state: "error", reason: "signature" });
  assert.equal(existsSync(staged(s.home)), false);
});

test("c4_1: tar failure leaves no staged tree", async (t) => {
  const s = setup(t);
  const result = await s.run(Buffer.from("signed but not a zip"));
  assert.deepEqual(result, { state: "error", reason: "extract" });
  assert.equal(existsSync(staged(s.home)), false);
});

test("c4_1: staged tree without the exe fails sanity", async (t) => {
  const s = setup(t);
  const result = await s.run(buildZip(s.scratch, { exe: false }));
  assert.deepEqual(result, { state: "error", reason: "staged tree" });
  assert.equal(existsSync(staged(s.home)), false);
});

test("c4_1: staged version not equal to the tag fails", async (t) => {
  const s = setup(t);
  const result = await s.run(buildZip(s.scratch, { version: "0.9.5" }));
  assert.deepEqual(result, { state: "error", reason: "staged tree" });
  assert.equal(existsSync(staged(s.home)), false);
});

test("c4_1: a failed download leaves no staged tree", async (t) => {
  const s = setup(t);
  const result = await s.run(buildZip(s.scratch), { status: 500 });
  assert.deepEqual(result, { state: "error", reason: "download" });
  assert.equal(existsSync(staged(s.home)), false);
});

test("c4_1: a missing public key fails closed", async (t) => {
  const s = setup(t);
  rmSync(join(s.installRoot, "lounge", "update.pub"));
  const result = await s.run(buildZip(s.scratch));
  assert.deepEqual(result, { state: "error", reason: "public key" });
  assert.equal(existsSync(staged(s.home)), false);
});

test("c4_1: a version that is not semver stages nothing", async (t) => {
  const s = setup(t);
  const result = await stageRelease({
    release: { version: "..\\evil", assets: [] },
    fetch: async () => new Response(""),
    home: s.home,
    installRoot: s.installRoot,
  });
  assert.deepEqual(result, { state: "error", reason: "version" });
});

test("c4_2: staging writes only under <home>/updates/<version>", async (t) => {
  const s = setup(t);
  await s.run(buildZip(s.scratch));
  assert.deepEqual(readdirSync(s.home), ["updates"]);
  assert.deepEqual(readdirSync(join(s.home, "updates")), [VERSION]);
});
