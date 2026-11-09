"""Warn the agent about STE100 hits in a Markdown file it just wrote.

PostToolUse hook. Exit 2 sends stderr to the agent. The write is
already done, so this warns and never blocks.
"""

import contextlib
import io
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "ste"))
import ste_check

MAX_LINES = 15

try:
    event = json.load(sys.stdin)
except ValueError:
    sys.exit(0)
path = (event.get("tool_input") or {}).get("file_path") or ""
if not path.lower().endswith(".md") or not pathlib.Path(path).is_file():
    sys.exit(0)

out = io.StringIO()
with contextlib.redirect_stdout(out):
    code = ste_check.main([path])
if code != 1:
    sys.exit(0)

lines = out.getvalue().strip().splitlines()
more = len(lines) - MAX_LINES
print("STE100 check: hits in the file you wrote. Fix real issues; ignore false hits.", file=sys.stderr)
print("\n".join(lines[:MAX_LINES]), file=sys.stderr)
if more > 0:
    print(f"... {more} more lines", file=sys.stderr)
sys.exit(2)
