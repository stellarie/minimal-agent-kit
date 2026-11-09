"""Tests for tools/sandbox.py: a non-empty DEST is refused (C5.1); init makes a git repo with the template."""

import contextlib
import io
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import sandbox


class SandboxTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dest = Path(self.tmp.name) / "sbx"

    def tearDown(self):
        self.tmp.cleanup()

    def init(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return sandbox.init(self.dest, install=False)

    def test_refuses_non_empty(self):
        self.dest.mkdir()
        (self.dest / "keep.txt").write_text("x")
        self.assertEqual(2, self.init())
        self.assertEqual(["keep.txt"], [p.name for p in self.dest.iterdir()])

    def test_refuses_file(self):
        self.dest.write_text("x")
        self.assertEqual(2, self.init())

    def test_init_without_install(self):
        self.assertEqual(0, self.init())
        for rel in ("python/faults.py", "js/faults.js", "js/package-lock.json", "js/react/Greeting.jsx", "README.md"):
            self.assertTrue((self.dest / rel).is_file(), rel)
        log = subprocess.run(["git", "-C", str(self.dest), "log", "--oneline"], capture_output=True, text=True)
        self.assertIn("Seed spike sandbox", log.stdout)


if __name__ == "__main__":
    unittest.main()
