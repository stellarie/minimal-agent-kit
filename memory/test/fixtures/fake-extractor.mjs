// Stands in for `claude -p`. Reads the prompt on stdin and prints a claude-style envelope.
import fs from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_EXTRACTOR_DIR;
// A test runner may load this file by itself. Do nothing then.
if (!dir) process.exit(0);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  fs.appendFileSync(path.join(dir, "calls.log"), `${process.env.AGENT_MEMORY_CAPTURE}\n`);
  fs.writeFileSync(path.join(dir, "last-prompt.txt"), input);
  if (fs.existsSync(path.join(dir, "fail"))) {
    console.error("boom");
    process.exit(1);
  }
  let result;
  if (fs.existsSync(path.join(dir, "obey-outside"))) {
    // A naive model obeys whatever follows the first closing fence.
    const close = input.indexOf("</transcript>");
    result = (close >= 0 ? input.slice(close + "</transcript>".length) : "").trim() || "[]";
  } else {
    result = fs.readFileSync(path.join(dir, "result.txt"), "utf8");
  }
  console.log(JSON.stringify({ type: "result", is_error: false, result }));
});
