"""Write the kit zip and the lounge zip into dist/.

Usage: python tools/release.py
The kit zip holds the tracked files outside lounge/. The lounge zip adds the lounge under lounge/,
the same place it has in the repo, so the relative paths of the core into the kit keep working:
lounge/agent-lounge.exe, lounge/core (tracked source and production node_modules), lounge/ui/dist,
lounge/plugins, and lounge/skills. The tool builds nothing. Build the exe and ui/dist first.
"""

import json
import pathlib
import subprocess
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
EXE = ROOT / "lounge" / "app" / "src-tauri" / "target" / "release" / "agent-lounge.exe"
UI_DIST = ROOT / "lounge" / "ui" / "dist"
CORE = ROOT / "lounge" / "core"
LOUNGE_PARTS = ("lounge/core/", "lounge/plugins/", "lounge/skills/")


def _tracked():
    out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout
    return sorted(p for p in out.decode("utf-8").split("\0") if p)


def _tree(directory):
    return sorted(p for p in directory.rglob("*") if p.is_file())


def _prod_modules():
    """Files of the packages that the lock file does not mark as dev, under lounge/core/node_modules."""
    packages = json.loads((CORE / "package-lock.json").read_text(encoding="utf-8"))["packages"]
    dev = [CORE / key for key, entry in packages.items() if entry.get("dev")]
    prod = [CORE / key for key, entry in packages.items() if key and not entry.get("dev")]
    files = {f for d in prod if d.is_dir() for f in _tree(d)}
    return sorted(f for f in files if not any(d in f.parents for d in dev))


def _write_zip(path, entries):
    path.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for arcname, source in entries:
            z.write(source, arcname)


def main():
    if subprocess.run([sys.executable, str(ROOT / "tools" / "sync.py"), "--check"], cwd=ROOT).returncode != 0:
        raise SystemExit("error: targets differ from core; run tools/sync.py")
    version = json.loads((ROOT / "claude" / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))["version"]
    files = _tracked()
    kit = [(p, ROOT / p) for p in files if not p.startswith("lounge/")]
    _write_zip(ROOT / "dist" / f"minimal-agent-kit-{version}.zip", kit)

    missing = [p.relative_to(ROOT).as_posix() for p in (EXE, UI_DIST, CORE / "node_modules") if not p.exists()]
    if missing:
        raise SystemExit(f"error: missing {', '.join(missing)}; build them first")
    lounge = [(p, ROOT / p) for p in files if p.startswith(LOUNGE_PARTS) and not p.startswith("lounge/core/test/")]
    lounge += [("lounge/agent-lounge.exe", EXE)]
    lounge += [(p.relative_to(ROOT).as_posix(), p) for p in _tree(UI_DIST) + _prod_modules()]
    _write_zip(ROOT / "dist" / f"minimal-agent-kit-lounge-{version}-windows.zip", kit + lounge)


if __name__ == "__main__":
    main()
