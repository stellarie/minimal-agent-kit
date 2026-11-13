"""Print the kit rules and the project wiki index into session context."""

import os
import pathlib
import sys

PLUGIN = pathlib.Path(__file__).resolve().parents[1]


def is_plain_name(name):
    """Return True when name is one folder name, not a path."""
    if name in (".", "..") or "/" in name or "\\" in name:
        return False
    return not pathlib.PureWindowsPath(name).drive


def wiki_dir(cwd, root, name=None):
    """Return the wiki folder, or None when no folder can be named.

    A blank root gives docs/wiki. A set root gives root/<name>, where name is
    WIKI_NAME or the directory name. A blank value counts as unset. A name
    that is a path gives None.
    """
    root = (root or "").strip()
    if not root:
        return cwd / "docs" / "wiki"
    name = (name or "").strip()
    if name:
        if not is_plain_name(name):
            return None
    else:
        name = cwd.name
        if not name:
            return None
    return pathlib.Path(root).expanduser() / name


def label(folder, cwd):
    try:
        return folder.relative_to(cwd).as_posix()
    except ValueError:
        return folder.as_posix()


def wiki_section():
    """Return the heading and index text, or "" when no index can be read."""
    try:
        cwd = pathlib.Path.cwd()
        folder = wiki_dir(cwd, os.environ.get("WIKI_ROOT"), os.environ.get("WIKI_NAME"))
        if folder is None:
            return ""
        text = (folder / "index.md").read_text(encoding="utf-8", errors="replace")
        return f"## Project wiki index ({label(folder, cwd)})\n\n{text}"
    except Exception:
        return ""


def main():
    reconfigure = getattr(sys.stdout, "reconfigure", None)
    if reconfigure:
        reconfigure(errors="replace")
    print((PLUGIN / "rules.md").read_text(encoding="utf-8"))
    section = wiki_section()
    if section:
        try:
            print(section)
        except Exception:
            pass


if __name__ == "__main__":
    main()
