"""Print the kit rules and the project wiki index into session context."""

import os
import pathlib

PLUGIN = pathlib.Path(__file__).resolve().parents[1]
ROOT = pathlib.Path(os.environ.get("WIKI_ROOT") or pathlib.Path.home() / "notes" / "wiki")
INDEX = ROOT / pathlib.Path.cwd().name / "index.md"

print((PLUGIN / "rules.md").read_text(encoding="utf-8"))
if INDEX.is_file():
    print(f"## Project wiki index ({INDEX.parent})\n")
    print(INDEX.read_text(encoding="utf-8"))
