"""Vendor an upstream memory plugin into memory/ as the neutral agent-memory plugin.

Usage: python tools/vendor_memory.py --source PATH [--map FILE] [--check]
FILE is a JSON object of extra {"old": "new"} text renames.
PATH is a checkout of the upstream repository. Its directory name is the
upstream plugin name, for example <prefix>-memory.
--check exits 1 when memory/ differs from a fresh vendor run.
"""

import argparse
import filecmp
import json
import pathlib
import re
import shutil
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEST = ROOT / "memory"
SKIP = {".git", "node_modules"}
NEW = "agent-memory"


class Renamer:
    """Rename the upstream plugin, its env names, and its CLI to neutral names."""

    def __init__(self, old, extra=None):
        extra = extra or {}
        prefix = old.split("-")[0]
        up, short = prefix.upper(), prefix[0] + "mem"
        # Order matters: longer and path tokens first.
        self.text = [
            (f"https://github.com/stellarie/{old}", "https://github.com/stellarie/minimal-agent-kit"),
            (f"plugins/{old}/", ""),
            (f'"plugins", "{old}", ', ""),
            (short.upper(), "AMEM"),
            (old, NEW),
            (f"{up}_MEMORY_", "AGENT_MEMORY_"),
            (f"{up}_AGENT", "AGENT_MEMORY_AGENT"),
            (f"{up}_RUNTIME", "AGENT_MEMORY_RUNTIME"),
        ] + list(extra.items())
        self.word = re.compile(rf"\b{short}")
        olds = "".join(rf"|\b{re.escape(k)}\b" for k in extra)
        self.leftover = re.compile(rf"{prefix}|\b{short}{olds}", re.I)

    def __call__(self, text):
        for old, new in self.text:
            text = text.replace(old, new)
        return self.word.sub("amem", text)

    def missed(self, root):
        return [str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()
                and (self.leftover.search(str(p.relative_to(root)))
                     or self.leftover.search(p.read_text(encoding="utf-8", errors="ignore")))]


def copy_tree(src, dst, rename):
    for path in sorted(src.rglob("*")):
        rel = path.relative_to(src)
        if path.is_dir() or SKIP & set(rel.parts):
            continue
        out = dst / rename(rel.as_posix())
        out.parent.mkdir(parents=True, exist_ok=True)
        try:
            out.write_text(rename(path.read_text(encoding="utf-8")), encoding="utf-8", newline="")
        except UnicodeDecodeError:
            shutil.copyfile(path, out)


def build(source, dst, extra=None):
    rename = Renamer(source.resolve().name, extra)
    copy_tree(source / "plugins" / source.resolve().name, dst, rename)
    copy_tree(source / "test", dst / "test", rename)
    pkg = rename((source / "package.json").read_text(encoding="utf-8"))
    (dst / "package.json").write_text(pkg, encoding="utf-8", newline="")
    left = rename.missed(dst)
    if left:
        raise SystemExit(f"rename missed tokens in: {', '.join(left)}")


def same(a, b):
    cmp = filecmp.dircmp(a, b, ignore=[])
    if cmp.left_only or cmp.right_only or cmp.funny_files:
        return False
    if filecmp.cmpfiles(a, b, cmp.common_files, shallow=False)[1:] != ([], []):
        return False
    return all(same(a / d, b / d) for d in cmp.common_dirs)


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--source", type=pathlib.Path, required=True)
    parser.add_argument("--map", type=pathlib.Path)
    args = parser.parse_args(argv)
    if not (args.source / "plugins" / args.source.resolve().name).is_dir():
        print(f"source not found: {args.source}", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory() as tmp:
        fresh = pathlib.Path(tmp) / "memory"
        extra = json.loads(args.map.read_text(encoding="utf-8")) if args.map else None
        build(args.source, fresh, extra)
        if args.check:
            ok = DEST.is_dir() and same(fresh, DEST)
            print("memory/ is current" if ok else "memory/ is stale")
            return 0 if ok else 1
        if DEST.exists():
            shutil.rmtree(DEST)
        shutil.copytree(fresh, DEST)
    print("memory/ vendored")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
