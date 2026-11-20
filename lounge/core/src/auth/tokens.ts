import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Caller } from "../config.ts";

export function tokensFile(home: string): string {
  return join(home, "tokens.json");
}

export const MAX_HEALTH_CHALLENGE = 128;

// The app checks this before it trusts a core.
export function healthProof(token: string, challenge: string): string {
  return createHmac("sha256", token).update(`agent-lounge-health:${challenge}`).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

// Temp file, then rename:
// a crash keeps the old file.
function saveTokens(home: string, tokens: Record<string, string>): void {
  const file = tokensFile(home);
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, JSON.stringify(tokens, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, file);
  // Windows ignores the file mode.
  if (process.platform !== "win32") chmodSync(file, 0o600);
}

// Keeps saved tokens and creates missing ones.
// Drops tokens of other ids.
export function ensureTokens(home: string, callers: readonly Caller[]): Record<string, string> {
  mkdirSync(home, { recursive: true });
  const file = tokensFile(home);
  const saved: Record<string, unknown> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const tokens: Record<string, string> = {};
  let changed = !existsSync(file);
  for (const caller of callers) {
    const value = Object.hasOwn(saved, caller) ? saved[caller] : undefined;
    if (typeof value === "string" && value.length > 0) {
      tokens[caller] = value;
    } else {
      tokens[caller] = newToken();
      changed = true;
    }
  }
  if (Object.keys(saved).some((key) => !Object.hasOwn(tokens, key))) changed = true;
  if (changed) saveTokens(home, tokens);
  // Windows ignores the file mode.
  else if (process.platform !== "win32") chmodSync(file, 0o600);
  return tokens;
}

// The guard, MCP, and auth share this map.
// Mutate it in place. Never replace it.
export function addToken(tokens: Record<string, string>, home: string, id: Caller): string {
  const token = Object.hasOwn(tokens, id) ? tokens[id]! : newToken();
  tokens[id] = token;
  saveTokens(home, tokens);
  return token;
}

export function revokeToken(tokens: Record<string, string>, home: string, id: Caller): void {
  if (!Object.hasOwn(tokens, id)) return;
  delete tokens[id];
  saveTokens(home, tokens);
}

export function callerForToken(tokens: Record<string, string>, token: string | undefined): Caller | null {
  if (!token) return null;
  const given = Buffer.from(token, "utf8");
  let found: Caller | null = null;
  for (const [caller, value] of Object.entries(tokens)) {
    const expected = Buffer.from(value, "utf8");
    if (expected.length === given.length && timingSafeEqual(expected, given)) {
      found = caller;
    }
  }
  return found;
}
