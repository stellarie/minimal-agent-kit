"""Behaviour tests for tools/release.py on a temporary tree with its own git index."""

import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile

REPO = pathlib.Path(__file__).resolve().parents[1]
VERSION = "9.9.9"
KIT_ZIP = f"dist/minimal-agent-kit-{VERSION}.zip"
LOUNGE_ZIP = f"dist/minimal-agent-kit-lounge-{VERSION}-windows.zip"
EXE = "lounge/app/src-tauri/target/release/agent-lounge.exe"
IGNORED = "dist/\nlounge/core/node_modules/\nlounge/ui/dist/\nlounge/app/src-tauri/target/\n"
LOCK = {
    "packages": {
        "": {"name": "agent-lounge-core"},
        "node_modules/ws": {"version": "8.0.0"},
        "node_modules/ws/node_modules/inner": {"version": "1.0.0"},
        "node_modules/typescript": {"version": "7.0.0", "dev": True},
        "node_modules/bufferutil": {"version": "4.0.0", "optional": True},
    }
}


def write(root, rel, text="x"):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def drop_readonly(func, path, _exc):
    """Git writes read-only object files, which rmtree cannot remove on Windows."""
    os.chmod(path, stat.S_IWRITE)
    func(path)


class ReleaseBehaviour(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        shutil.copytree(REPO / "core", self.tmp / "core", ignore=shutil.ignore_patterns("__pycache__"))
        (self.tmp / "tools").mkdir()
        for name in ("sync.py", "release.py"):
            if (REPO / "tools" / name).exists():
                shutil.copyfile(REPO / "tools" / name, self.tmp / "tools" / name)
        write(self.tmp, "claude/.claude-plugin/plugin.json", json.dumps({"name": "kit", "version": VERSION}))
        write(self.tmp, ".gitignore", IGNORED)
        write(self.tmp, "README.md")
        self.fake_lounge()
        self.run_tool("sync.py")
        self.git("init", "-q")
        self.git("add", "-A")

    def tearDown(self):
        shutil.rmtree(self.tmp, onexc=drop_readonly)

    def fake_lounge(self):
        write(self.tmp, "lounge/core/package.json", '{"type": "module"}')
        write(self.tmp, "lounge/core/package-lock.json", json.dumps(LOCK))
        write(self.tmp, "lounge/core/src/main.ts")
        write(self.tmp, "lounge/core/test/main.test.ts")
        write(self.tmp, "lounge/core/node_modules/ws/index.js")
        write(self.tmp, "lounge/core/node_modules/ws/node_modules/inner/index.js")
        write(self.tmp, "lounge/core/node_modules/typescript/lib.js")
        write(self.tmp, "lounge/plugins/p/plugin.json")
        write(self.tmp, "lounge/skills/s/SKILL.md")
        write(self.tmp, "lounge/app/src-tauri/src/main.rs")
        write(self.tmp, "lounge/ui/src/main.ts")
        self.build_outputs()

    def build_outputs(self):
        write(self.tmp, EXE)
        write(self.tmp, "lounge/ui/dist/index.html")

    def git(self, *args):
        subprocess.run(["git", *args], cwd=self.tmp, check=True, capture_output=True)

    def run_tool(self, name, *extra, env=None):
        args = [sys.executable, "-X", "utf8", str(self.tmp / "tools" / name), *extra]
        return subprocess.run(args, cwd=self.tmp, capture_output=True, text=True, env=env)

    def release(self, *extra, env=None):
        return self.run_tool("release.py", *extra, env=env)

    def fake_tools(self):
        """Put minisign and gh stand-ins first on PATH. Return the environment and the call log."""
        bin_dir = self.tmp / "fakebin"
        bin_dir.mkdir()
        log = self.tmp / "calls.log"
        fake = bin_dir / "fake.py"
        fake.write_text(
            "import json, os, sys\n"
            "with open(os.environ['FAKE_LOG'], 'a', encoding='utf-8') as f:\n"
            "    f.write(json.dumps(sys.argv[1:]) + '\\n')\n",
            encoding="utf-8",
        )
        for name in ("minisign", "gh"):
            if os.name == "nt":
                (bin_dir / f"{name}.cmd").write_text(f'@"{sys.executable}" "{fake}" {name} %*\n', encoding="utf-8")
            else:
                script = bin_dir / name
                script.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{fake}" {name} "$@"\n', encoding="utf-8")
                script.chmod(0o755)
        env = {**os.environ, "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"], "FAKE_LOG": str(log)}
        return env, log

    def names(self, zip_rel):
        with zipfile.ZipFile(self.tmp / zip_rel) as z:
            return set(z.namelist())

    def kit_names(self):
        tracked = subprocess.run(
            ["git", "ls-files"], cwd=self.tmp, capture_output=True, text=True, check=True
        ).stdout.split()
        return {p for p in tracked if not p.startswith("lounge/")}

    def lounge_extra(self):
        return {
            "lounge/agent-lounge.exe",
            "lounge/core/package.json",
            "lounge/core/package-lock.json",
            "lounge/core/src/main.ts",
            "lounge/core/node_modules/ws/index.js",
            "lounge/core/node_modules/ws/node_modules/inner/index.js",
            "lounge/ui/dist/index.html",
            "lounge/plugins/p/plugin.json",
            "lounge/skills/s/SKILL.md",
        }

    def test_c9_1_kit_zip(self):
        result = self.release()
        self.assertEqual(result.returncode, 0, result.stderr)
        names = self.names(KIT_ZIP)
        self.assertEqual(names, self.kit_names())
        self.assertIn("claude/.claude-plugin/plugin.json", names)
        self.assertFalse([n for n in names if n.startswith(("lounge/", "dist/"))])

    def test_c9_1_lounge_zip(self):
        self.release()
        names = self.names(LOUNGE_ZIP)
        self.assertEqual(names, self.kit_names() | self.lounge_extra())

    def test_sc16_both_zips_exist_with_listed_contents(self):
        result = self.release()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.tmp / KIT_ZIP).is_file())
        self.assertTrue((self.tmp / LOUNGE_ZIP).is_file())
        self.assertIn("lounge/skills/s/SKILL.md", self.names(LOUNGE_ZIP))
        self.assertNotIn("lounge/skills/s/SKILL.md", self.names(KIT_ZIP))

    def test_c9_1_missing_exe(self):
        (self.tmp / EXE).unlink()
        result = self.release()
        self.assertEqual(result.returncode, 1)
        self.assertIn("agent-lounge.exe", result.stderr)
        self.assertTrue((self.tmp / KIT_ZIP).is_file())
        self.assertFalse((self.tmp / LOUNGE_ZIP).exists())

    def test_sc17_no_exe_stops_with_error_and_writes_only_kit_zip(self):
        (self.tmp / EXE).unlink()
        self.release()
        self.assertEqual([p.name for p in (self.tmp / "dist").iterdir()], [pathlib.Path(KIT_ZIP).name])

    def test_c9_1_missing_ui_dist(self):
        shutil.rmtree(self.tmp / "lounge/ui/dist")
        result = self.release()
        self.assertEqual(result.returncode, 1)
        self.assertIn("ui/dist", result.stderr)
        self.assertFalse((self.tmp / LOUNGE_ZIP).exists())

    def test_c9_1_missing_node_modules(self):
        shutil.rmtree(self.tmp / "lounge/core/node_modules")
        result = self.release()
        self.assertEqual(result.returncode, 1)
        self.assertIn("node_modules", result.stderr)
        self.assertFalse((self.tmp / LOUNGE_ZIP).exists())

    def test_c9_1_sync_drift_stops_before_any_zip(self):
        with open(self.tmp / "core" / "rules.md", "a", encoding="utf-8") as f:
            f.write("\nnew rule\n")
        result = self.release()
        self.assertEqual(result.returncode, 1)
        self.assertFalse((self.tmp / "dist").exists())

    def test_c8_2_lounge_zip_holds_update_pub(self):
        write(self.tmp, "lounge/update.pub")
        self.git("add", "-A")
        self.assertEqual(self.release().returncode, 0)
        self.assertIn("lounge/update.pub", self.names(LOUNGE_ZIP))
        self.assertNotIn("lounge/update.pub", self.names(KIT_ZIP))

    def test_c8_1_publish_commands_sign_both_zips_then_create_the_release(self):
        write(self.tmp, "lounge/update.pub")
        self.git("add", "-A")
        env, log = self.fake_tools()
        result = self.release("--publish", "--key", "k.key", env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        kit = f"dist/minimal-agent-kit-{VERSION}.zip"
        lounge = f"dist/minimal-agent-kit-lounge-{VERSION}-windows.zip"
        tag = f"v{VERSION}"
        calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(
            calls,
            [
                ["minisign", "-S", "-s", "k.key", "-m", kit],
                ["minisign", "-S", "-s", "k.key", "-m", lounge],
                ["gh", "release", "create", tag, kit, lounge, kit + ".minisig", lounge + ".minisig", "--title", tag],
            ],
        )

    def test_c8_1_publish_without_update_pub_stops_before_any_command(self):
        env, log = self.fake_tools()
        result = self.release("--publish", "--key", "k.key", env=env)
        self.assertEqual(result.returncode, 1)
        self.assertIn("update.pub", result.stderr)
        self.assertFalse(log.exists())
        self.assertFalse((self.tmp / "dist").exists())

    def test_c8_1_without_publish_no_command_runs(self):
        write(self.tmp, "lounge/update.pub")
        self.git("add", "-A")
        env, log = self.fake_tools()
        self.assertEqual(self.release(env=env).returncode, 0)
        self.assertFalse(log.exists())

    def test_c9_1_lounge_relative_paths_resolve_after_unzip(self):
        for rel in ("lounge/core/src", "lounge/plugins", "lounge/skills"):
            shutil.rmtree(self.tmp / rel)
            shutil.copytree(REPO / rel, self.tmp / rel, ignore=shutil.ignore_patterns("__pycache__"))
        self.git("add", "-A")
        self.assertEqual(self.release().returncode, 0)
        out = pathlib.Path(tempfile.mkdtemp())
        try:
            with zipfile.ZipFile(self.tmp / LOUNGE_ZIP) as z:
                z.extractall(out)
            core = out / "lounge" / "core"
            sources = list(core.rglob("*.ts")) + list((out / "lounge" / "plugins").rglob("*.ts"))
            checked = 0
            for src in sources:
                if "node_modules" in src.parts:
                    continue
                text = src.read_text(encoding="utf-8")
                targets = [src.parent / m for m in re.findall(r'from "(\.[^"]+)"', text)]
                for call in re.findall(r"(?:resolve|join)\(import\.meta\.dirname((?:, *\"[^\"]+\")+)\)", text):
                    parts = re.findall(r'"([^"]+)"', call)
                    targets.append(src.parent.joinpath(*parts))
                for target in targets:
                    checked += 1
                    self.assertTrue(
                        target.resolve().exists(), f"{src.relative_to(out)} reaches missing {target.resolve()}"
                    )
            self.assertGreater(checked, 20)
            self.assertTrue((out / "lounge" / "ui" / "dist" / "index.html").is_file())
        finally:
            shutil.rmtree(out)


if __name__ == "__main__":
    unittest.main()
