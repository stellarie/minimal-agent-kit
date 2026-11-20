// Fake claude CLI for adapter contract tests.
// Mode comes from FAKE_CLAUDE_MODE: ok | pass | is_error | exit1_error | exit2 | sleep | version.
import { appendFileSync, readFileSync } from "node:fs";

const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
const logPath = process.env.FAKE_CLAUDE_LOG;
const argv = process.argv.slice(2);

function writeLog(stdin) {
  if (!logPath) return;
  const at = argv.indexOf("--settings");
  const settings = at >= 0 ? JSON.parse(readFileSync(argv[at + 1], "utf8")) : undefined;
  const guard = { url: process.env.LOUNGE_GUARD_URL, token: process.env.LOUNGE_GUARD_TOKEN };
  const line = JSON.stringify({ argv, stdin, cwd: process.cwd(), pid: process.pid, settings, guard });
  appendFileSync(logPath, line + "\n");
}

function emit(result, isError) {
  console.log(JSON.stringify({ type: "system", subtype: "init" }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: result }] } }));
  console.log("not json, must be ignored");
  console.log(JSON.stringify({ type: "result", is_error: isError, result }));
}

if (argv.includes("--version")) {
  writeLog("");
  if (mode === "version") {
    process.stderr.write("version failure\n");
    process.exit(3);
  }
  console.log("0.0.0-fake (Fake Claude)");
  process.exit(0);
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  stdin += d;
});

if (mode === "sleep") {
  // Log at once so the test can read the pid, then hang forever.
  writeLog("");
  setInterval(() => {}, 1000);
} else {
  process.stdin.on("end", () => {
    writeLog(stdin);
    if (mode === "pass") {
      emit("[pass]", false);
    } else if (mode === "is_error") {
      emit("boom", true);
    } else if (mode === "exit1_error") {
      emit("Not logged in", true);
      process.exitCode = 1;
    } else if (mode === "exit2") {
      process.stderr.write("first\nlast stderr line\n");
      process.exit(2);
    } else {
      emit("hello from fake", false);
    }
  });
}
