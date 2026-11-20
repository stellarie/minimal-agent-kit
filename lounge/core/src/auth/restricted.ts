import { randomBytes } from "node:crypto";
import type { Agent } from "../config.ts";

export interface RestrictedGrant {
  caller: Agent;
  sessionId: string;
}

type RevokeListener = (token: string) => void;

// Per-turn tokens. Memory only; a restart drops them.
export class RestrictedTokens {
  #grants = new Map<string, RestrictedGrant>();
  #listeners = new Set<RevokeListener>();

  mint(agent: Agent, sessionId: string): string {
    const token = randomBytes(32).toString("base64url");
    this.#grants.set(token, { caller: agent, sessionId });
    return token;
  }

  lookup(token: string | undefined): RestrictedGrant | null {
    if (!token) return null;
    return this.#grants.get(token) ?? null;
  }

  revoke(token: string): void {
    if (!this.#grants.delete(token)) return;
    for (const listener of [...this.#listeners]) {
      try {
        listener(token);
      } catch (err) {
        console.error("revoke listener failed:", err);
      }
    }
  }

  // Retire: every open turn token of one agent.
  revokeFor(agent: Agent): void {
    for (const [token, grant] of [...this.#grants]) {
      if (grant.caller === agent) this.revoke(token);
    }
  }

  onRevoke(listener: RevokeListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get size(): number {
    return this.#grants.size;
  }
}
