"""Behaviour tests for tools/sync.py on a temporary copy of the repo."""

import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[1]


class SyncBehaviour(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        for name in ("core", "tools", "claude", "codex"):
            if (REPO / name).exists():
                shutil.copytree(REPO / name, self.tmp / name, ignore=shutil.ignore_patterns("__pycache__"))
        self.sync("")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def sync(self, flag):
        args = [sys.executable, str(self.tmp / "tools" / "sync.py")] + ([flag] if flag else [])
        return subprocess.run(args, capture_output=True, text=True).returncode

    def test_given_synced_tree_when_checked_then_exits_zero(self):
        self.assertEqual(self.sync("--check"), 0)

    def test_given_changed_core_file_when_checked_then_exits_nonzero(self):
        with open(self.tmp / "core" / "rules.md", "a", encoding="utf-8") as f:
            f.write("\nnew rule\n")
        self.assertEqual(self.sync("--check"), 1)

    def test_given_extra_target_file_when_synced_then_removed(self):
        extra = self.tmp / "codex" / "skills" / "stale.md"
        extra.write_text("old", encoding="utf-8")
        self.sync("")
        self.assertFalse(extra.exists())
        self.assertEqual(self.sync("--check"), 0)


if __name__ == "__main__":
    unittest.main()
