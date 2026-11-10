"""Tests for minimal_check.py: each changed hunk must be needed by a test (1-minimal)."""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core" / "verify"))
import minimal_check

TEST = f'"{sys.executable}" -m unittest -q'


class MinimalCheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.git("init", "-q")
        self.git("config", "user.email", "t@t")
        self.git("config", "user.name", "t")
        self.write("a.py", "def one():\n    return 1\n")
        self.write("test_a.py", "import unittest\nimport a\n\n\nclass T(unittest.TestCase):\n    def test_one(self):\n        self.assertEqual(1, a.one())\n")
        self.commit("base")
        self.base = self.rev()

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True, text=True).stdout

    def write(self, rel, text):
        (self.root / rel).write_text(text)

    def commit(self, msg):
        self.git("add", ".")
        self.git("commit", "-q", "-m", msg)

    def rev(self):
        return self.git("rev-parse", "HEAD").strip()

    def run_check(self, **kw):
        return minimal_check.run(self.root, self.base, TEST, **kw)

    def levels(self, found):
        return {f["id"]: f["level"] for f in found}

    def test_needed_hunk_passes(self):
        self.write("a.py", "def one():\n    return 1\n\n\ndef two():\n    return 2\n")
        self.write("test_a.py", (self.root / "test_a.py").read_text() + "\n    def test_two(self):\n        self.assertEqual(2, a.two())\n")
        self.commit("two")
        self.assertEqual([], self.run_check())

    def test_unneeded_hunk_fails(self):
        self.write("a.py", "def one():\n    return 1\n\n\ndef spare():\n    return 3\n")
        self.commit("spare")
        self.assertEqual({"minimal:a.py:3": "fail"}, self.levels(self.run_check()))

    def test_changed_line_reverts_to_old(self):
        self.write("a.py", "def one():\n    return 2 - 1\n")
        self.commit("same value")
        self.assertEqual({"minimal:a.py:2": "fail"}, self.levels(self.run_check()))

    def test_test_files_comments_and_docs_are_skipped(self):
        self.write("test_a.py", (self.root / "test_a.py").read_text() + "\n    def test_extra(self):\n        pass\n")
        self.write("a.py", "# why: one is fixed\ndef one():\n    return 1\n")
        self.write("NOTES.md", "text\n")
        self.commit("skip")
        self.assertEqual([], self.run_check())

    def test_lines_mode(self):
        self.write("a.py", "def one():\n    x = 5\n    return 1\n")
        self.commit("extra line")
        self.assertIn("minimal:a.py:2", self.levels(self.run_check(lines=True)))

    def test_baseline_failure_is_not_run(self):
        self.write("a.py", "def one():\n    return 9\n")
        self.commit("broken")
        found = self.run_check()
        self.assertEqual({"minimal:baseline": "not-run"}, self.levels(found))

    def test_cap_gives_not_run(self):
        self.write("a.py", "X = 1\n\n\ndef one():\n    return 1\n\n\nY = 2\n")
        self.commit("two hunks")
        found = self.levels(self.run_check(limit=1))
        self.assertEqual("not-run", found.get("minimal:limit"))
        self.assertEqual(2, len(found))

    def test_tree_untouched_and_worktree_removed(self):
        self.write("a.py", "def one():\n    return 1\n\n\nZ = 0\n")
        self.commit("z")
        self.write("a.py", "dirty\n")
        self.run_check()
        self.assertEqual("dirty\n", (self.root / "a.py").read_text())
        self.assertEqual(1, self.git("worktree", "list").count("\n"))

    def test_lines_mode_is_exact(self):
        self.write("a.py", "def one():\n    x = 5\n    return 1\n")
        self.commit("extra line")
        self.assertEqual({"minimal:a.py:2": "fail"}, self.levels(self.run_check(lines=True)))

    def test_bad_base_is_not_run(self):
        self.assertEqual({"minimal:diff": "not-run"}, self.levels(minimal_check.run(self.root, "nope123", TEST)))

    def test_space_unicode_and_noprefix(self):
        self.git("config", "diff.noprefix", "true")
        self.write("my é.py", "Q = 1\n")
        self.commit("odd name")
        self.assertEqual({"minimal:my é.py:1": "fail"}, self.levels(self.run_check()))

    def test_removed_line_starting_with_dashes(self):
        diff = "+++ b/a.js\n@@ -2 +2,2 @@\n---c;\n+c = c - 1;\n+++ d;\n"
        hunks, _, _ = minimal_check.parse(diff)
        self.assertEqual([("a.js", 2, ["--c;"], ["c = c - 1;", "++ d;"])], hunks)

    def test_form_feed_keeps_line_numbers(self):
        self.write("a.py", "\x0c\ndef one():\n    return 1\n\n\nZ = 9\n")
        self.commit("ff")
        self.assertEqual({"minimal:a.py:4": "fail"}, self.levels(self.run_check()))

    def test_moved_base_uses_merge_base(self):
        self.git("branch", "side")
        self.write("b.py", "B = 1\n")
        self.commit("branch work")
        self.git("checkout", "-q", "side")
        self.write("a.py", "def one():\n    return 0 + 1\n")
        self.commit("main moved")
        self.git("checkout", "-q", "-")
        self.assertEqual({"minimal:b.py:1"}, set(self.levels(minimal_check.run(self.root, "side", TEST))))

    def test_other_language_is_a_note(self):
        self.write("lib.rs", "fn main() {}\n")
        self.commit("rust")
        self.assertEqual({"minimal:skipped": "consider"}, self.levels(self.run_check()))

    def test_timeout_is_not_run(self):
        self.write("a.py", "def one():\n    return 1\n\n\nT = 1\n")
        self.commit("t")
        slow = f'"{sys.executable}" -c "import os,time; time.sleep(30) if os.path.exists(\'flag\') else None"'
        (self.root / "flag").write_text("")
        self.git("add", "flag")
        self.commit("flag")
        import time
        t0 = time.time()
        found = minimal_check.run(self.root, self.base, slow, timeout=2)
        self.assertLess(time.time() - t0, 20)
        self.assertEqual({"minimal:baseline": "not-run"}, self.levels(found))

    def test_docstring_and_annotations_are_skipped(self):
        self.write("a.py", 'def one() -> int:\n    """One."""\n    return 1\n')
        self.commit("doc")
        self.assertEqual([], self.run_check())

    def test_test_support_folders_are_skipped(self):
        (self.root / "tests").mkdir()
        self.write("tests/helpers.py", "H = 1\n")
        self.write("conftest.py", "C = 1\n")
        self.commit("helpers")
        self.assertEqual([], self.run_check())

    def test_lines_mode_reports_syntax_breaks(self):
        self.write("a.py", "def one(x=None):\n    if x is None:\n        x = 0\n    return 1\n")
        self.commit("dead branch")
        found = self.levels(self.run_check(lines=True))
        self.assertEqual("not-run", found.get("minimal:syntax"))

    def test_main_exit_code(self):
        self.write("a.py", "def one():\n    return 1\n\n\nW = 0\n")
        self.commit("w")
        import contextlib, io
        with contextlib.redirect_stdout(io.StringIO()):
            code = minimal_check.main(["--base", self.base, "--root", str(self.root), "--test", TEST])
        self.assertEqual(1, code)


if __name__ == "__main__":
    unittest.main()
