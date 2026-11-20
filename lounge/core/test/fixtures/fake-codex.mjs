// Fake codex CLI for the sign-in tests. FAKE_CODEX_MODE: ok | hang | fail.
// `login` prints a URL, then writes auth.json into CODEX_HOME, as the real CLI does after sign-in.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
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
} else {
  process.exit(0);
}
