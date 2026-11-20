export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Waiter {
  grant(release: () => void): void;
}

// A FIFO limit on running turns. Waiters expire.
export class Slots {
  #limit: number;
  #timeoutMs: number;
  #timers: TimerApi;
  #held = 0;
  #queue: Waiter[] = [];

  constructor(limit: number, timeoutMs: number, timers: TimerApi = realTimers) {
    this.#limit = limit;
    this.#timeoutMs = timeoutMs;
    this.#timers = timers;
  }

  get running(): number {
    return this.#held;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  #release(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.#queue.shift();
      // The slot passes straight to the oldest waiter.
      if (next) next.grant(this.#release());
      else this.#held -= 1;
    };
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("aborted"));
    if (this.#held < this.#limit) {
      this.#held += 1;
      return Promise.resolve(this.#release());
    }
    return new Promise((resolve, reject) => {
      const leave = (): void => {
        const index = this.#queue.indexOf(waiter);
        if (index >= 0) this.#queue.splice(index, 1);
        this.#timers.clearTimeout(handle);
        signal?.removeEventListener("abort", onAbort);
      };
      const waiter: Waiter = {
        grant: (release) => {
          leave();
          resolve(release);
        },
      };
      const onAbort = (): void => {
        leave();
        reject(new Error("aborted"));
      };
      const handle = this.#timers.setTimeout(() => {
        leave();
        reject(new Error("queue timeout"));
      }, this.#timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(waiter);
    });
  }
}
