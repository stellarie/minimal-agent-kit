import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

export type Verdict = { ok: true } | { ok: false; reason: string };

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const UNTRUSTED = "untrusted comment:";
const TRUSTED = "trusted comment: ";

const fail = (reason: string): Verdict => ({ ok: false, reason });

function decode(line: string | undefined, size: number): Buffer | null {
  const bytes = Buffer.from(line ?? "", "base64");
  return bytes.length === size && bytes.toString("base64") === line ? bytes : null;
}

export function parsePublicKey(text: string): { keyId: Buffer; key: KeyObject } | null {
  const lines = text.split(/\r?\n/);
  const raw = lines[0]?.startsWith(UNTRUSTED) ? decode(lines[1], 42) : null;
  if (!raw || raw.subarray(0, 2).toString() !== "Ed") return null;
  try {
    const der = Buffer.concat([SPKI_ED25519, raw.subarray(10)]);
    return { keyId: raw.subarray(2, 10), key: createPublicKey({ key: der, format: "der", type: "spki" }) };
  } catch {
    return null;
  }
}

export function verifyMinisign(file: Uint8Array, sigText: string, pubText: string): Verdict {
  const pub = parsePublicKey(pubText);
  if (!pub) return fail("public key");
  const lines = sigText.split(/\r?\n/);
  const sig = lines[0]?.startsWith(UNTRUSTED) ? decode(lines[1], 74) : null;
  const trusted = lines[2]?.startsWith(TRUSTED) ? lines[2].slice(TRUSTED.length) : null;
  const global = decode(lines[3], 64);
  if (!sig || trusted === null || !global) return fail("format");
  if (sig.subarray(0, 2).toString() !== "ED") return fail("algorithm");
  if (!sig.subarray(2, 10).equals(pub.keyId)) return fail("key id");
  const body = sig.subarray(10);
  if (!verify(null, createHash("blake2b512").update(file).digest(), pub.key, body)) return fail("signature");
  if (!verify(null, Buffer.concat([body, Buffer.from(trusted)]), pub.key, global)) return fail("trusted comment");
  return { ok: true };
}
