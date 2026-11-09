"""Print the kit rules and the project wiki index into session context."""

import pathlib

PLUGIN = pathlib.Path(__file__).resolve().parents[1]
INDEX = pathlib.Path.cwd() / "docs" / "wiki" / "index.md"

print((PLUGIN / "rules.md").read_text(encoding="utf-8"))
if INDEX.is_file():
    print("## Project wiki index (docs/wiki)\n")
    print(INDEX.read_text(encoding="utf-8"))
