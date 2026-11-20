import { randomUUID } from "node:crypto";
import { MAX_CONTENT } from "./modes.ts";

export interface Approval {
  id: string;
  agent: string;
  tool: string;
  summary: string;
  reason: string;
  cwd?: string;
  // An askable block. The card is dangerous.
  danger?: boolean;
  createdAt: string;
  expiresAt: string;
}

export type ApprovalInput = Pick<Approval, "agent" | "tool" | "summary" | "reason" | "cwd" | "danger">;

// Under the 600 s hook limit, so the hook gets an answer.
export const APPROVAL_MS = 540_000;
// A card holds a whole checked write and its path.
const MAX_SUMMARY = MAX_CONTENT + 2000;
const MIN_LEFT_MS = 1_000;

// The owner must see that the text goes on.
function clip(text: string): string {
  if (text.length <= MAX_SUMMARY) return text;
  return `${text.slice(0, MAX_SUMMARY)}
[cut: ${text.length - MAX_SUMMARY} more characters]`;
}

interface Waiter {
  approval: Approval;
  settle(allow: boolean): void;
}

// Cards waiting for the owner. Unanswered cards deny.
export class Approvals {
  #waiting = new Map<string, Waiter>();
  #listeners = new Set<(pending: Approval[]) => void>();
  #now: () => Date;
  #timeoutMs: number;

  constructor(opts: { now?: () => Date; timeoutMs?: number } = {}) {
    this.#now = opts.now ?? (() => new Date());
    this.#timeoutMs = opts.timeoutMs ?? APPROVAL_MS;
  }

  // "timeout" when nobody answered in time.
  // spentMs: time a check used. The card gets the rest.
  request(input: ApprovalInput, signal?: AbortSignal, spentMs = 0): Promise<boolean | "timeout"> {
    const left = Math.max(Math.min(MIN_LEFT_MS, this.#timeoutMs), this.#timeoutMs - spentMs);
    const created = this.#now();
    const approval: Approval = {
      id: randomUUID(),
      agent: input.agent,
      tool: input.tool,
      summary: clip(input.summary),
      reason: input.reason,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.danger ? { danger: true } : {}),
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + left).toISOString(),
    };
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: boolean | "timeout") => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#waiting.delete(approval.id);
        this.#emit();
        resolve(value);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish("timeout"), left);
      this.#waiting.set(approval.id, { approval, settle: finish });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#emit();
      if (signal?.aborted) onAbort();
    });
  }

  decide(id: string, allow: boolean): boolean {
    const waiter = this.#waiting.get(id);
    if (!waiter) return false;
    waiter.settle(allow);
    return true;
  }

  pending(): Approval[] {
    return [...this.#waiting.values()].map((w) => w.approval);
  }

  onChange(listener: (pending: Approval[]) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // Shutdown denies every open card.
  close(): void {
    for (const w of [...this.#waiting.values()]) w.settle(false);
  }

  #emit(): void {
    const pending = this.pending();
    for (const listener of [...this.#listeners]) {
      try {
        listener(pending);
      } catch (err) {
        console.error("approval listener failed:", err);
      }
    }
  }
}
