import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkLatest, type Fetch, type ReleaseAsset } from "./check.ts";
import { stageRelease } from "./stage.ts";

export const UPDATE_EXIT_CODE = 86;

export interface UpdateStatus {
  state: "off" | "none" | "available" | "downloading" | "ready" | "error";
  current: string;
  version?: string;
  reason?: string;
}

export interface IntervalApi {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realIntervals: IntervalApi = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface UpdateOptions {
  installRoot: string;
  everyMs: number;
  onApply: () => void;
  fetch?: Fetch;
  stage?: typeof stageRelease;
  timers?: IntervalApi;
}

export class UpdateService {
  #status: UpdateStatus;
  #assets: ReleaseAsset[] = [];
  #timer: unknown;
  #listeners = new Set<(status: UpdateStatus) => void>();
  #opts: UpdateOptions | undefined;
  #home: string;
  #current: string;
  #enabled: boolean;

  constructor(opts: { home: string; current: string; enabled: boolean; update?: UpdateOptions }) {
    this.#home = opts.home;
    this.#current = opts.current;
    this.#opts = opts.update;
    this.#enabled = opts.enabled && opts.update !== undefined;
    this.#status = { state: this.#enabled ? "none" : "off", current: opts.current };
  }

  status(): UpdateStatus {
    return this.#status;
  }

  onChange(fn: (status: UpdateStatus) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  start(): void {
    if (!this.#enabled || !this.#opts) return;
    void this.#check();
    this.#timer = (this.#opts.timers ?? realIntervals).setInterval(() => void this.#check(), this.#opts.everyMs);
  }

  stop(): void {
    if (this.#timer === undefined || !this.#opts) return;
    (this.#opts.timers ?? realIntervals).clearInterval(this.#timer);
    this.#timer = undefined;
  }

  download(): boolean {
    const opts = this.#opts;
    if (!opts || this.#status.state !== "available" || !this.#status.version) return false;
    const release = { version: this.#status.version, assets: this.#assets };
    this.#set({ state: "downloading", version: release.version });
    const stage = opts.stage ?? stageRelease;
    stage({ release, fetch: opts.fetch ?? fetch, home: this.#home, installRoot: opts.installRoot }).then(
      (done) => this.#set(done.state === "ready" ? { state: "ready", version: done.version } : { state: "error", reason: done.reason }),
      (err: unknown) => this.#set({ state: "error", reason: (err as Error).message }),
    );
    return true;
  }

  async apply(): Promise<boolean> {
    const { state, version } = this.#status;
    if (state !== "ready" || !version) return false;
    let ready: { version: string; root: string };
    try {
      ready = JSON.parse(readFileSync(join(this.#home, "updates", version, "ready.json"), "utf8"));
    } catch {
      return false;
    }
    await writeFile(join(this.#home, "updates", "apply.json"), JSON.stringify({ version: ready.version, root: ready.root }));
    return true;
  }

  exit(): void {
    this.#opts?.onApply();
  }

  async #check(): Promise<void> {
    const busy = () => this.#status.state === "downloading" || this.#status.state === "ready";
    if (busy()) return;
    const result = await checkLatest({
      fetch: this.#opts?.fetch ?? fetch,
      current: this.#current,
      enabled: this.#enabled,
    });
    if (busy()) return;
    if (result.state === "available") {
      this.#assets = result.assets;
      this.#set({ state: "available", version: result.version });
    } else if (result.state === "error") {
      this.#set({ state: "error", reason: result.reason });
    } else {
      this.#set({ state: result.state });
    }
  }

  #set(next: Omit<UpdateStatus, "current">): void {
    this.#status = { current: this.#current, ...next };
    for (const fn of this.#listeners) fn(this.#status);
  }
}
