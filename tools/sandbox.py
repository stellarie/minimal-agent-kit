"""Create the reusable spike sandbox from core/sandbox/template. Run once.

Usage: python tools/sandbox.py DEST [--no-install]
Refuses a DEST that exists and is not empty. Writes only inside DEST.
Without --no-install: creates python/.venv with pytest, runs npm ci in js/, and runs the seed tests.
"""

import argparse
import pathlib
import shutil
import subprocess
import sys

TEMPLATE = pathlib.Path(__file__).resolve().parents[1] / "core" / "sandbox" / "template"


def venv_python(dest):
    sub = "Scripts/python.exe" if sys.platform == "win32" else "bin/python"
    return dest / "python" / ".venv" / sub


def step(cmd, cwd):
    print("$ " + " ".join(str(c) for c in cmd))
    exe = shutil.which(str(cmd[0])) or str(cmd[0])
    return subprocess.run([exe] + [str(c) for c in cmd[1:]], cwd=cwd).returncode


def init(dest, install=True):
    if dest.exists() and (not dest.is_dir() or any(dest.iterdir())):
        print(f"refused: {dest} is not an empty directory")
        return 2
    shutil.copytree(TEMPLATE, dest, dirs_exist_ok=True, ignore=shutil.ignore_patterns("node_modules", ".venv", "__pycache__"))
    for cmd in (["git", "init", "-q", "-b", "main"], ["git", "add", "-A"], ["git", "commit", "-q", "-m", "Seed spike sandbox"]):
        if step(cmd, dest):
            return 1
    if not install:
        return 0
    steps = [
        ([sys.executable, "-m", "venv", "python/.venv"], dest),
        ([venv_python(dest), "-m", "pip", "install", "-q", "-r", "python/requirements.txt"], dest),
        (["npm", "ci", "--no-audit", "--no-fund"], dest / "js"),
        ([venv_python(dest), "-m", "pytest", "-q"], dest / "python"),
        (["npm", "test", "--silent"], dest / "js"),
    ]
    for cmd, cwd in steps:
        if step(cmd, cwd):
            return 1
    print(f"sandbox ready: {dest}")
    return 0


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("dest", type=pathlib.Path)
    parser.add_argument("--no-install", action="store_true")
    args = parser.parse_args(argv)
    return init(args.dest.resolve(), not args.no_install)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
