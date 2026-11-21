import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { parsePublicKey, verifyMinisign } from "../src/update/minisign.ts";

interface Pair {
  privateKey: KeyObject;
  keyId: Buffer;
  pub: string;
}

function pair(): Pair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = randomBytes(8);
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const body = Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64");
  return { privateKey, keyId, pub: `untrusted comment: minisign public key\n${body}\n` };
}

function signed(k: Pair, file: Buffer, opts: { legacy?: boolean } = {}): string {
  const trusted = "timestamp:1 file:lounge.zip";
  const digest = opts.legacy ? file : createHash("blake2b512").update(file).digest();
  const body = sign(null, digest, k.privateKey);
  const global = sign(null, Buffer.concat([body, Buffer.from(trusted)]), k.privateKey);
  const head = Buffer.concat([Buffer.from(opts.legacy ? "Ed" : "ED"), k.keyId, body]).toString("base64");
  return `untrusted comment: signature\n${head}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`;
}

const FILE = Buffer.from("the lounge zip bytes");

test("c2_1: good prehashed signature verifies", () => {
  const k = pair();
  assert.deepEqual(verifyMinisign(FILE, signed(k, FILE), k.pub), { ok: true });
});

test("c2_1: one flipped byte fails", () => {
  const k = pair();
  const flipped = Buffer.from(FILE);
  flipped[3] ^= 1;
  assert.deepEqual(verifyMinisign(flipped, signed(k, FILE), k.pub), { ok: false, reason: "signature" });
});

test("c2_1: other key fails", () => {
  const k = pair();
  assert.deepEqual(verifyMinisign(FILE, signed(k, FILE), pair().pub), { ok: false, reason: "key id" });
});

test("c2_1: legacy Ed signature fails", () => {
  const k = pair();
  assert.deepEqual(verifyMinisign(FILE, signed(k, FILE, { legacy: true }), k.pub), { ok: false, reason: "algorithm" });
});

test("c2_1: tampered trusted comment fails", () => {
  const k = pair();
  const text = signed(k, FILE).replace("timestamp:1", "timestamp:2");
  assert.deepEqual(verifyMinisign(FILE, text, k.pub), { ok: false, reason: "trusted comment" });
});

test("c2_1: malformed signature text fails", () => {
  const k = pair();
  assert.deepEqual(verifyMinisign(FILE, "not a signature", k.pub), { ok: false, reason: "format" });
  assert.deepEqual(verifyMinisign(FILE, "", k.pub), { ok: false, reason: "format" });
});

test("c2_1: malformed public key fails", () => {
  const k = pair();
  assert.deepEqual(verifyMinisign(FILE, signed(k, FILE), "garbage"), { ok: false, reason: "public key" });
  assert.equal(parsePublicKey("untrusted comment: x\nRWQ=\n"), null);
});
