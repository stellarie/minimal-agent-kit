// Fake codex CLI for the sign-in tests. FAKE_CODEX_MODE: ok | hang | fail.
// `login` prints a URL, then writes auth.json into CODEX_HOME, as the real CLI does after sign-in.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE ?? "ok";
const home = process.env.CODEX_HOME ?? "";
const logPath = process.env.FAKE_CODEX_LOG;

if (logPath) appendFileSync(logPath, JSON.stringify({ argv, codexHome: home, pid: process.pid }) + "\n");

const at = argv.indexOf("login");
if (at >= 0 && argv[at + 1] === "status") {
  const signedIn = existsSync(join(home, "auth.json"));
  console.log(signedIn ? "Logged in using ChatGPT" : "Not logged in");
  process.exit(signedIn ? 0 : 1);
} else if (at >= 0) {
  console.log("Starting local login server on http://localhost:1455.");
  console.log("If your browser did not open, navigate to this URL to authenticate:");
  console.log("");
  console.log("https://auth.example.test/oauth/authorize?state=abc");
  if (mode === "hang") {
    setInterval(() => {}, 1000);
  } else if (mode === "fail") {
    process.stderr.write("login failed: access denied\n");
    process.exit(1);
  } else {
    setTimeout(() => {
      writeFileSync(join(home, "auth.json"), '{"test": true}');
      process.exit(0);
    }, 50);
  }
} else if (argv.includes("exec")) {
  exec();
} else {
  process.exit(0);
}

// `exec --json` replays the event shapes of a real codex run (codex-cli 0.167).
// FAKE_CODEX_EXEC: ok | blocked | silent | fail | hang.
// FAKE_CODEX_IMAGES=n: the turn also saves n PNG files in $CODEX_HOME/generated_images/<thread>/.
// The real codex 0.167 does that and emits no event for it.
// FAKE_CODEX_REPLY: the text of the last agent_message.
function exec() {
  const execMode = process.env.FAKE_CODEX_EXEC ?? "ok";
  let stdin = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (stdin += d));
  process.stdin.on("end", () => {
    if (logPath) {
      appendFileSync(
        logPath,
        JSON.stringify({
          exec: true,
          argv,
          stdin,
          cwd: process.cwd(),
          exe: process.execPath,
          codexHome: home,
          guard: { url: process.env.LOUNGE_GUARD_URL, token: process.env.LOUNGE_GUARD_TOKEN },
        }) + "\n",
      );
    }
    const resumeAt = argv.indexOf("resume");
    const thread = resumeAt >= 0 ? argv[resumeAt + 1] : "01a1fa06-0000-7000-8000-000000000001";
    const out = (ev) => process.stdout.write(JSON.stringify(ev) + "\n");
    if (execMode === "hang") {
      setInterval(() => {}, 1000);
      return;
    }
    if (execMode === "fail") {
      process.stderr.write("fatal: model refused\n");
      process.exit(1);
    }
    if (execMode !== "silent") out({ type: "thread.started", thread_id: thread });
    const trust = "`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.";
    out({ type: "item.completed", item: { id: "item_0", type: "error", message: trust } });
    out({ type: "turn.started" });
    if (execMode === "blocked") {
      process.stderr.write(
        "2026-11-20T17:35:14.328013Z ERROR codex_core::tools::router: error=Command blocked by PreToolUse hook: test-deny blocked. Command: echo test-deny\n",
      );
      out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "The hook blocked the command." } });
    } else if (execMode === "ok") {
      out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "I will check the status once." } });
      out({ type: "item.started", item: { id: "item_2", type: "command_execution", command: "git status --short", exit_code: null, status: "in_progress" } });
      out({ type: "item.completed", item: { id: "item_2", type: "command_execution", command: "git status --short", aggregated_output: "", exit_code: 0, status: "completed" } });
      const reply = process.env.FAKE_CODEX_REPLY ?? (resumeAt >= 0 ? "PINEAPPLE" : "Status is clean.");
      out({ type: "item.completed", item: { id: "item_3", type: "agent_message", text: reply } });
    }
    saveImages(thread);
    out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    process.exit(0);
  });
}

// 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function saveImages(thread) {
  const count = Number(process.env.FAKE_CODEX_IMAGES ?? "0");
  if (!(count > 0)) return;
  const dir = join(home, "generated_images", thread);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(dir, `exec-${randomUUID()}.png`), PNG);
}
