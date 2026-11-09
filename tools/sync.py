"""Copy core/ into each target directory, or check that targets match.

Usage: python tools/sync.py [--check]
--check exits 1 when a target differs from core, and changes nothing.
"""

import filecmp
import pathlib
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
CORE = ROOT / "core"
MAP = {
    "claude": {"rules.md": "rules.md", "skills": "skills", "guard": "guard", "ste": "ste"},
    "codex": {"rules.md": "AGENTS.md", "skills": "skills", "guard": "guard", "ste": "ste"},
}


def files(src):
    if src.is_file():
        return [pathlib.Path()]
    return sorted(p.relative_to(src) for p in src.rglob("*") if p.is_file() and "__pycache__" not in p.parts)


def pairs():
    for target, entries in MAP.items():
        for src_name, dst_name in entries.items():
            src, dst = CORE / src_name, ROOT / target / dst_name
            for rel in files(src):
                yield src / rel, dst / rel
            if dst.is_dir():
                expected = {dst / rel for rel in files(src)}
                for extra in files(dst):
                    if dst / extra not in expected:
                        yield None, dst / extra


def main(argv):
    check = "--check" in argv
    drift = []
    for src, dst in pairs():
        if src is None:
            drift.append(f"extra: {dst.relative_to(ROOT)}")
            if not check:
                dst.unlink()
        elif not dst.exists() or not filecmp.cmp(src, dst, shallow=False):
            drift.append(f"stale: {dst.relative_to(ROOT)}")
            if not check:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, dst)
    for line in drift:
        print(line)
    return 1 if check and drift else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
