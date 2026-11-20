import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// The sign-in lives in a file of the codex home, so the lounge can see it.
export const CODEX_STORE_ARGS: readonly string[] = ["-c", 'cli_auth_credentials_store="file"'];

const STATUS_MS = 15_000;
// A sign-in waits for the browser: stop it after ten minutes.
const LOGIN_MS = 10 * 60 * 1000;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

export interface CodexCommand {
  command: string;
  // Put before the CLI flags.
  commandArgs?: readonly string[];
}

export interface LoginView {
  state: "signed-in" | "signed-out" | "running";
  // The page to open, while a sign-in runs.
  url?: string;
  error?: string;
}

// The lounge owns this folder: its own sign-in, never a copy of the user's.
export function codexHomeOf(home: string): string {
  return join(home, "codex-home");
}

// The command as the app finds it: codex.exe sits in a folder with a hash name.
// A command with a path, or any other name, stays as it is.
export function findCodex(command: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!/^codex(\.exe)?$/i.test(command)) return command;
  const local = env.LOCALAPPDATA;
  if (!local) return command;
  const bin = join(local, "OpenAI", "Codex", "bin");
  let best: { exe: string; at: number } | undefined;
  try {
    for (const entry of readdirSync(bin, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const exe = join(bin, entry.name, "codex.exe");
      try {
        const at = statSync(exe).mtimeMs;
        if (best === undefined || at > best.at) best = { exe, at };
      } catch {
        // A folder without codex.exe, such as the one that holds rg.exe.
      }
    }
  } catch {
    // No install folder.
  }
  return best?.exe ?? command;
}

function codexSpawn(home: string, cli: CodexCommand, tail: readonly string[], stdio: "ignore" | "pipe"): ChildProcess {
  return spawn(findCodex(cli.command), [...(cli.commandArgs ?? []), ...CODEX_STORE_ARGS, ...tail], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", stdio, stdio],
    env: { ...process.env, CODEX_HOME: codexHomeOf(home) },
  });
}

// True when `codex login status` says the lounge codex home holds a login.
export function codexLoginStatus(home: string, cli: CodexCommand): Promise<boolean> {
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = codexSpawn(home, cli, ["login", "status"], "ignore");
    } catch {
      done(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done(false);
    }, STATUS_MS);
    child.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
}

function pageUrl(line: string): string | undefined {
  for (const m of line.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    try {
      if (!LOCAL_HOST.test(new URL(m[0]).hostname)) return m[0];
    } catch {
      // Not a URL: look at the next one.
    }
  }
  return undefined;
}

// The Sign in to Codex action: runs `codex login` with CODEX_HOME in the lounge home.
export class CodexLogin {
  readonly #home: string;
  readonly #cli: () => CodexCommand;
  #child: ChildProcess | undefined;
  #closed: Promise<void> = Promise.resolve();
  // Ends the running sign-in. A stopped one shows no error.
  #stop: () => void = () => {};
  #url: string | undefined;
  #error: string | undefined;

  constructor(opts: { home: string; cli: () => CodexCommand }) {
    this.#home = opts.home;
    this.#cli = opts.cli;
  }

  async status(): Promise<LoginView> {
    if (this.#child) return { state: "running", ...(this.#url ? { url: this.#url } : {}) };
    if (await codexLoginStatus(this.#home, this.#cli())) return { state: "signed-in" };
    return { state: "signed-out", ...(this.#error ? { error: this.#error } : {}) };
  }

  // One sign-in at a time: a second press shows the first.
  async start(): Promise<LoginView> {
    if (this.#child) return this.status();
    this.#url = undefined;
    this.#error = undefined;
    mkdirSync(codexHomeOf(this.#home), { recursive: true });
    let child: ChildProcess;
    try {
      child = codexSpawn(this.#home, this.#cli(), ["login"], "pipe");
    } catch (err) {
      this.#error = (err as Error).message;
      return this.status();
    }
    this.#child = child;
    let last = "";
    let stopped = false;
    const feed = (stream: NodeJS.ReadableStream | null): void => {
      let rest = "";
      const line = (text: string): void => {
        const trimmed = text.trim();
        if (trimmed === "") return;
        last = trimmed;
        this.#url ??= pageUrl(trimmed);
      };
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        const parts = (rest + chunk).split(/\r?\n/);
        rest = parts.pop() ?? "";
        parts.forEach(line);
      });
      stream?.on("end", () => line(rest));
    };
    feed(child.stdout);
    feed(child.stderr);
    const timer = setTimeout(() => {
      stopped = true;
      child.kill();
    }, LOGIN_MS);
    this.#closed = new Promise<void>((done) => {
      child.on("error", (err: NodeJS.ErrnoException) => {
        this.#error = err.code === "ENOENT" ? "codex not found" : err.message;
        clearTimeout(timer);
        this.#child = undefined;
        done();
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (this.#child === child) this.#child = undefined;
        if (code !== 0 && !stopped) this.#error = last || `codex login exited ${code}`;
        done();
      });
    });
    this.#stop = () => {
      stopped = true;
      child.kill();
    };
    return this.status();
  }

  // Ends a running sign-in. The error stays empty.
  async cancel(): Promise<LoginView> {
    if (this.#child) {
      this.#stop();
      await this.#closed;
    }
    this.#error = undefined;
    return this.status();
  }

  async close(): Promise<void> {
    if (this.#child) {
      this.#stop();
      await this.#closed;
    }
  }
}
