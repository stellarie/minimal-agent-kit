import { execFile } from "node:child_process";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Fetch, ReleaseAsset } from "./check.ts";
import { verifyMinisign } from "./minisign.ts";

const TAR = "C:/Windows/System32/tar.exe";
const run = promisify(execFile);

export type StageResult = { state: "ready"; version: string } | { state: "error"; reason: string };

// Removes every entry under <home>/updates except the version being staged.
async function pruneUpdates(home: string, keep: string): Promise<void> {
  const updates = resolve(home, "updates");
  let names: string[];
  try {
    names = await readdir(updates);
  } catch {
    return;
  }
  for (const name of names) {
    const target = resolve(updates, name);
    if (name === keep || dirname(target) !== updates) continue;
    await rm(target, { recursive: true, force: true });
  }
}

export async function stageRelease(opts: {
  release: { version: string; assets: ReleaseAsset[] };
  fetch: Fetch;
  home: string;
  installRoot: string;
}): Promise<StageResult> {
  const { version, assets } = opts.release;
  if (!/^\d+\.\d+\.\d+$/.test(version)) return { state: "error", reason: "version" };
  const zipName = `minimal-agent-kit-lounge-${version}-windows.zip`;
  const zip = assets.find((a) => a.name === zipName);
  const sig = assets.find((a) => a.name === `${zipName}.minisig`);
  if (!zip || !sig) return { state: "error", reason: "asset" };

  const dir = join(opts.home, "updates", version);
  const root = join(dir, "root");
  const fail = async (reason: string): Promise<StageResult> => {
    await rm(dir, { recursive: true, force: true });
    return { state: "error", reason };
  };
  const get = async (url: string): Promise<Buffer> => {
    const res = await opts.fetch(url);
    if (!res.ok) throw new Error(`http ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };

  await pruneUpdates(opts.home, version);
  await rm(dir, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  let zipBytes: Buffer;
  let sigText: string;
  try {
    zipBytes = await get(zip.url);
    sigText = (await get(sig.url)).toString("utf8");
  } catch {
    return fail("download");
  }
  await writeFile(join(dir, zipName), zipBytes);
  await writeFile(join(dir, sig.name), sigText);

  let pub: string;
  try {
    pub = await readFile(join(opts.installRoot, "lounge", "update.pub"), "utf8");
  } catch {
    return fail("public key");
  }
  if (!verifyMinisign(zipBytes, sigText, pub).ok) return fail("signature");

  try {
    await run(TAR, ["-xf", join(dir, zipName), "-C", root]);
  } catch {
    return fail("extract");
  }

  const lounge = join(root, "lounge");
  try {
    for (const part of ["agent-lounge.exe", "core/src/main.ts", "update.pub"]) await access(join(lounge, part));
    const staged = JSON.parse(await readFile(join(lounge, "core", "package.json"), "utf8")) as { version?: unknown };
    if (staged.version !== version) return fail("staged tree");
  } catch {
    return fail("staged tree");
  }

  await writeFile(join(dir, "ready.json"), JSON.stringify({ version, root }));
  return { state: "ready", version };
}
