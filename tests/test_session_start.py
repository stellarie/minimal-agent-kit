"""Behaviour tests for the SessionStart hook in the Claude target."""

import contextlib
import importlib.util
import io
import os
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

HOOK = pathlib.Path(__file__).resolve().parents[1] / "claude" / "hooks" / "session_start.py"
RULES = HOOK.parents[1] / "rules.md"
HEADING = "## Project wiki index"


def bad_names(base):
    return ["../secret", "proj/../../secret", str(base / "secret"), ".", "..", "..\\secret", "a\\b", "C:secret"]


def load():
    spec = importlib.util.spec_from_file_location("session_start", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WikiLocation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = pathlib.Path(self.tmp.name)
        self.cwd = self.base / "my-project"
        self.cwd.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_given_unset_root_when_resolved_then_index_is_in_project_docs(self):
        index = load().wiki_dir(self.cwd, None) / "index.md"
        self.assertEqual(index, self.cwd / "docs" / "wiki" / "index.md")

    def test_given_empty_root_when_resolved_then_index_is_in_project_docs(self):
        index = load().wiki_dir(self.cwd, "") / "index.md"
        self.assertEqual(index, self.cwd / "docs" / "wiki" / "index.md")

    def test_given_blank_root_when_resolved_then_index_is_in_project_docs(self):
        index = load().wiki_dir(self.cwd, "  \t ") / "index.md"
        self.assertEqual(index, self.cwd / "docs" / "wiki" / "index.md")

    def test_given_set_root_when_resolved_then_index_is_in_folder_named_for_project(self):
        root = self.base / "wikis"
        index = load().wiki_dir(self.cwd, str(root)) / "index.md"
        self.assertEqual(index, root / "my-project" / "index.md")

    def test_given_root_with_trailing_slash_when_resolved_then_folder_is_the_same(self):
        root = self.base / "wikis"
        folder = load().wiki_dir(self.cwd, str(root) + os.sep)
        self.assertEqual(folder, root / "my-project")

    def test_given_tilde_root_when_resolved_then_tilde_expands_to_home(self):
        home = {"HOME": str(self.base), "USERPROFILE": str(self.base)}
        with mock.patch.dict(os.environ, home):
            index = load().wiki_dir(self.cwd, "~/wikis") / "index.md"
        self.assertEqual(index, self.base / "wikis" / "my-project" / "index.md")

    def test_given_wiki_name_when_resolved_then_name_replaces_directory_name(self):
        root = self.base / "wikis"
        folder = load().wiki_dir(self.cwd, str(root), "shared")
        self.assertEqual(folder, root / "shared")

    def test_given_blank_wiki_name_when_resolved_then_directory_name_is_used(self):
        root = self.base / "wikis"
        folder = load().wiki_dir(self.cwd, str(root), "   ")
        self.assertEqual(folder, root / "my-project")

    def test_given_wiki_name_and_unset_root_when_resolved_then_name_has_no_effect(self):
        folder = load().wiki_dir(self.cwd, None, "shared")
        self.assertEqual(folder, self.cwd / "docs" / "wiki")

    def test_given_wiki_name_that_is_a_path_when_resolved_then_no_folder(self):
        root = str(self.base / "wikis")
        for name in bad_names(self.base):
            with self.subTest(name=name):
                self.assertIsNone(load().wiki_dir(self.cwd, root, name))

    def test_given_directory_without_name_when_resolved_then_no_folder(self):
        top = pathlib.Path(self.cwd.anchor)
        self.assertIsNone(load().wiki_dir(top, str(self.base / "wikis")))

    def test_given_directory_name_that_looks_like_a_path_when_resolved_then_it_is_still_used(self):
        root = str(self.base / "wikis")
        for name in ("C:proj", "a\\b", "x:y"):
            with self.subTest(name=name):
                project = types.SimpleNamespace(name=name)
                self.assertEqual(load().wiki_dir(project, root), pathlib.Path(root) / name)

    def test_given_directory_without_name_and_wiki_name_when_resolved_then_name_is_used(self):
        top = pathlib.Path(self.cwd.anchor)
        root = self.base / "wikis"
        self.assertEqual(load().wiki_dir(top, str(root), "shared"), root / "shared")


class SessionStartMain(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = pathlib.Path(self.tmp.name)
        self.cwd = self.base / "my-project"
        self.cwd.mkdir()
        self.root = self.base / "wikis"
        self.rules = RULES.read_text(encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def make_index(self, folder, data=b"# Index\n"):
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "index.md").write_bytes(data)

    def run_main(self, cwd=None, root=None, name=None):
        out = io.StringIO()
        with mock.patch.dict(os.environ):
            os.environ.pop("WIKI_ROOT", None)
            os.environ.pop("WIKI_NAME", None)
            if root is not None:
                os.environ["WIKI_ROOT"] = str(root)
            if name is not None:
                os.environ["WIKI_NAME"] = name
            module = load()
            with mock.patch.object(module.pathlib.Path, "cwd", return_value=cwd or self.cwd):
                with contextlib.redirect_stdout(out):
                    module.main()
        return out.getvalue()

    def test_given_missing_index_when_started_then_only_rules_print(self):
        out = self.run_main(root=self.root)
        self.assertIn(self.rules, out)
        self.assertNotIn(HEADING, out)

    def test_given_root_set_and_local_wiki_present_when_started_then_root_wins(self):
        self.make_index(self.cwd / "docs" / "wiki", b"# Local index\n")
        self.make_index(self.root / "my-project", b"# Root index\n")
        out = self.run_main(root=self.root)
        self.assertIn("# Root index", out)
        self.assertNotIn("# Local index", out)

    def test_given_root_set_and_only_local_wiki_when_started_then_no_index_prints(self):
        self.make_index(self.cwd / "docs" / "wiki", b"# Local index\n")
        out = self.run_main(root=self.root)
        self.assertNotIn("# Local index", out)

    def test_given_wiki_name_when_started_then_named_folder_is_read(self):
        self.make_index(self.root / "my-project", b"# Own index\n")
        self.make_index(self.root / "shared", b"# Shared index\n")
        out = self.run_main(root=self.root, name="shared")
        self.assertIn("# Shared index", out)
        self.assertIn(f"{HEADING} ({(self.root / 'shared').as_posix()})", out)
        self.assertNotIn("# Own index", out)

    def test_given_wiki_name_that_is_a_path_when_started_then_no_index_loads(self):
        self.make_index(self.base / "secret", b"# Secret index\n")
        self.make_index(self.root / "my-project", b"# Own index\n")
        for name in bad_names(self.base):
            with self.subTest(name=name):
                out = self.run_main(root=self.root, name=name)
                self.assertIn(self.rules, out)
                self.assertNotIn("# Secret index", out)
                self.assertNotIn("# Own index", out)
                self.assertNotIn(HEADING, out)

    def test_given_blank_wiki_name_when_started_then_directory_name_is_used(self):
        self.make_index(self.root / "my-project", b"# Own index\n")
        out = self.run_main(root=self.root, name="  ")
        self.assertIn("# Own index", out)

    def test_given_directory_without_name_when_started_then_root_index_is_not_loaded(self):
        self.make_index(self.root, b"# Stray index\n")
        out = self.run_main(cwd=pathlib.Path(self.cwd.anchor), root=self.root)
        self.assertIn(self.rules, out)
        self.assertNotIn("# Stray index", out)
        self.assertNotIn(HEADING, out)

    def test_given_index_that_is_not_utf8_when_started_then_rules_and_index_still_print(self):
        self.make_index(self.root / "my-project", b"# Index \xff\xfe broken\n")
        out = self.run_main(root=self.root)
        self.assertIn(self.rules, out)
        self.assertIn(HEADING, out)
        self.assertIn("broken", out)

    def test_given_stdout_that_rejects_the_index_text_when_started_then_main_returns_after_rules(self):
        class AsciiOnly:
            def __init__(self):
                self.written = []

            def write(self, text):
                text.encode("ascii")
                self.written.append(text)
                return len(text)

            def flush(self):
                pass

        self.make_index(self.root / "my-project", "# 索引\n".encode("utf-8"))
        stdout = AsciiOnly()
        with mock.patch.dict(os.environ):
            os.environ.pop("WIKI_NAME", None)
            os.environ["WIKI_ROOT"] = str(self.root)
            module = load()
            with mock.patch.object(module.pathlib.Path, "cwd", return_value=self.cwd):
                with mock.patch.object(module.sys, "stdout", stdout):
                    module.main()
        self.assertIn(self.rules, "".join(stdout.written))

    def test_given_index_that_is_a_directory_when_started_then_only_rules_print(self):
        (self.root / "my-project" / "index.md").mkdir(parents=True)
        out = self.run_main(root=self.root)
        self.assertIn(self.rules, out)
        self.assertNotIn(HEADING, out)

    def test_given_home_that_cannot_resolve_when_started_then_rules_still_print(self):
        with mock.patch.object(pathlib.Path, "expanduser", side_effect=RuntimeError("no home")):
            out = self.run_main(root="~/wikis")
        self.assertIn(self.rules, out)
        self.assertNotIn(HEADING, out)

    def test_given_working_directory_that_cannot_resolve_when_started_then_rules_still_print(self):
        module = load()
        out = io.StringIO()
        with mock.patch.dict(os.environ):
            os.environ.pop("WIKI_ROOT", None)
            os.environ.pop("WIKI_NAME", None)
            with mock.patch.object(module.pathlib.Path, "cwd", side_effect=FileNotFoundError):
                with contextlib.redirect_stdout(out):
                    module.main()
        self.assertIn(self.rules, out.getvalue())
        self.assertNotIn(HEADING, out.getvalue())


class SessionStartProcess(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = pathlib.Path(self.tmp.name) / "my-project"
        self.cwd.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def run_hook(self, root, extra=None):
        env = {k: v for k, v in os.environ.items() if k not in ("WIKI_ROOT", "WIKI_NAME")}
        env.update(extra or {})
        if root is not None:
            env["WIKI_ROOT"] = str(root)
        proc = subprocess.run([sys.executable, str(HOOK)], cwd=self.cwd, env=env, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0)
        return proc.stdout

    def test_given_set_root_when_started_then_heading_names_folder_and_index_prints(self):
        folder = pathlib.Path(self.tmp.name) / "wikis" / "my-project"
        folder.mkdir(parents=True)
        (folder / "index.md").write_text("# Shared index\n", encoding="utf-8")
        out = self.run_hook(pathlib.Path(self.tmp.name) / "wikis")
        self.assertIn(f"{HEADING} ({folder.as_posix()})", out)
        self.assertIn("# Shared index", out)

    def test_given_stdout_that_cannot_encode_the_index_when_started_then_rules_and_heading_print(self):
        folder = pathlib.Path(self.tmp.name) / "wikis" / "my-project"
        folder.mkdir(parents=True)
        (folder / "index.md").write_text("# 索引 \U0001f600 tail\n", encoding="utf-8")
        out = self.run_hook(pathlib.Path(self.tmp.name) / "wikis", {"PYTHONIOENCODING": "cp1252"})
        self.assertIn(HEADING, out)
        self.assertIn("tail", out)
        self.assertIn(RULES.read_text(encoding="utf-8").splitlines()[0], out)

    def test_given_unset_root_when_started_then_heading_names_docs_wiki(self):
        folder = self.cwd / "docs" / "wiki"
        folder.mkdir(parents=True)
        (folder / "index.md").write_text("# Local index\n", encoding="utf-8")
        out = self.run_hook(None)
        self.assertIn(f"{HEADING} (docs/wiki)", out)
        self.assertIn("# Local index", out)


if __name__ == "__main__":
    unittest.main()
