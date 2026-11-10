"""Tests for the fact extractors and ast_checks.py (C2.1, C2.2, C3.1, C3.2, C3.3)."""

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

VERIFY = Path(__file__).resolve().parents[1] / "core" / "verify"
sys.path.insert(0, str(VERIFY))
import ast_checks

NODE = shutil.which("node")


def facts(script, source):
    cmd = [sys.executable, str(VERIFY / script)] if script.endswith(".py") else [NODE, str(VERIFY / script)]
    return json.loads(subprocess.run(cmd, input=source, capture_output=True, text=True, encoding="utf-8").stdout)


class PythonFactsTests(unittest.TestCase):
    def test_passthrough(self):
        f = facts("facts_py.py", "def a(x, y):\n    return b(x, y)\n\ndef c(x):\n    return b(x, 1)\n")
        self.assertEqual([True, False], [fn["passthrough"] for fn in f["functions"]])

    def test_method_passthrough_skips_self(self):
        f = facts("facts_py.py", "class K:\n    def a(self, x):\n        return self.b(x)\n")
        self.assertTrue(f["functions"][0]["passthrough"])

    def test_interface_respects_all(self):
        f = facts("facts_py.py", "__all__ = ['a']\ndef a(): pass\ndef b(): pass\ndef _c(): pass\n")
        self.assertEqual(["a()"], f["interface"])

    def test_syntax_error(self):
        self.assertIn("error", facts("facts_py.py", "def (:\n"))


@unittest.skipUnless(NODE, "node is not on PATH")
class JsFactsTests(unittest.TestCase):
    def test_passthrough_arrow_and_block(self):
        f = facts("facts_js.mjs", "const a = (x) => b(x);\nfunction c(x) { return b(x, 1); }\n")
        self.assertEqual([True, False], [fn["passthrough"] for fn in f["functions"]])

    def test_express_routes(self):
        f = facts("facts_js.mjs", "router.post('/items', h);\napp.get(path, h);\n")
        self.assertEqual(["route POST /items"], f["interface"])

    def test_react_props_and_exports(self):
        src = "export default function Card({ title, onClose }) { return <div>{title}</div>; }\nexport const n = 1;\n"
        f = facts("facts_js.mjs", src)
        self.assertEqual(["export default", "export n", "props Card{title,onClose}"], f["interface"])

    def test_commonjs_exports(self):
        f = facts("facts_js.mjs", "module.exports = { a, b };\nexports.c = 1;\n")
        self.assertEqual(["export a", "export b", "export c"], f["interface"])


class VendorChecksumTests(unittest.TestCase):
    def test_vendored_files_match_sums(self):
        vendor = VERIFY / "vendor"
        for line in (vendor / "SHA256SUMS").read_text().splitlines():
            digest, name = line.split(maxsplit=1)
            data = (vendor / name.lstrip("*")).read_bytes()
            self.assertEqual(digest, hashlib.sha256(data).hexdigest(), name)


class AstChecksTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.git("init", "-q")
        self.git("config", "user.email", "t@t")
        self.git("config", "user.name", "t")
        (self.root / "a.py").write_text("def keep(x):\n    return x + 1\n")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "base")
        self.plan = {"slices": [{"id": "S1", "files": ["a.py"], "calls": [], "interface": [], "pseudocode": []}]}

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True)

    def ids(self, phase=1):
        return {f["id"] for f in ast_checks.run(self.plan, self.root, "HEAD", phase)}

    def write(self, rel, text):
        (self.root / rel).write_text(text)

    def test_clean_change(self):
        self.write("a.py", "def keep(x):\n    return x + 2\n")
        self.assertEqual(set(), self.ids())

    def test_file_outside_slices(self):
        self.write("b.py", "X = 1\n")
        self.assertIn("files:b.py", self.ids())

    def test_eta(self):
        self.write("a.py", "def keep(x):\n    return other(x)\n")
        self.assertIn("eta:a.py:keep:1", self.ids())

    def test_effect_not_in_calls(self):
        self.write("a.py", "def keep(x):\n    print(x)\n    return x\n")
        self.assertIn("effect:a.py:print", self.ids())
        self.plan["slices"][0]["calls"] = ["print"]
        self.assertEqual(set(), self.ids())

    def test_interface_change(self):
        self.write("a.py", "def keep(x, y):\n    return x + y\n")
        self.assertIn("interface:a.py:keep(x, y)", self.ids())
        self.plan["slices"][0]["interface"] = ["a.keep"]
        self.assertEqual(set(), self.ids())

    def test_reduction_needs_done(self):
        self.write("a.py", "def keep(x):\n    return x + 2\n")
        self.assertIn("reduction:a.py:keep", self.ids(phase=2))
        self.plan["slices"][0]["pseudocode"] = [{"line": 1, "text": "add", "done": "a.py:2"}]
        self.assertEqual(set(), self.ids(phase=2))

    @unittest.skipUnless(NODE, "node is not on PATH")
    def test_js_route_change(self):
        self.plan["slices"][0]["files"].append("app.js")
        self.write("app.js", "app.get('/x', h);\n")
        self.assertIn("interface:app.js:route GET /x", self.ids())

    @unittest.skipUnless(NODE, "node is not on PATH")
    def test_planned_route_is_exact(self):
        self.plan["slices"][0]["files"].append("app.js")
        self.write("app.js", "app.get('/users/:id', h);\napp.get('/teams/:id', h);\n")
        self.plan["slices"][0]["interface"] = ["route GET /users/:id"]
        self.assertEqual({"interface:app.js:route GET /teams/:id"}, self.ids())

    def test_main_stops_on_bad_plan(self):
        plan = self.root / "plan.json"
        plan.write_text(json.dumps({"slices": [{"id": "S1", "files": "src/a.py"}]}))
        import contextlib, io
        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = ast_checks.main([str(plan), "--base", "HEAD", "--root", str(self.root)])
        self.assertEqual(1, code)
        self.assertIn("schema:slices[0].files", out.getvalue())

    def test_pure_calls_are_not_effects(self):
        self.write("a.py", "import json\ndef keep(x):\n    items = [x]\n    items.remove(x)\n    return json.dumps(x)\n")
        fails = [f for f in ast_checks.run(self.plan, self.root, "HEAD", 1) if f["level"] == "fail"]
        self.assertEqual([], fails)

    def test_module_helpers_are_not_effects(self):
        self.write("a.py", "import os, pickle\ndef keep(x):\n    pickle.dumps(x)\n    return os.path.join('a', x)\n")
        self.assertEqual(set(), self.ids())

    def test_database_call_is_a_note(self):
        self.write("a.py", "def keep(conn):\n    conn.execute('DELETE FROM t')\n    return conn\n")
        found = ast_checks.run(self.plan, self.root, "HEAD", 1)
        levels = {f["id"]: f["level"] for f in found}
        self.assertEqual("consider", levels.get("effect:a.py:conn.execute:2"))

    @unittest.skipUnless(NODE, "node is not on PATH")
    def test_planned_props_change(self):
        self.plan["slices"][0]["files"].append("c.jsx")
        self.write("c.jsx", "export const n = 1;\nfunction Card({ title }) { return <p>{title}</p>; }\n")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "card")
        self.write("c.jsx", "export const n = 1;\nfunction Card({ title, onClose }) { return <p>{title}</p>; }\n")
        self.plan["slices"][0]["interface"] = ["props Card{title,onClose}"]
        self.assertEqual(set(), self.ids())

    def test_zero_argument_wrapper_is_not_eta(self):
        self.write("a.py", "def keep(x):\n    return x + 1\n\ndef now():\n    return compute()\n")
        self.plan["slices"][0]["interface"] = ["now"]
        self.assertEqual(set(), self.ids())

    def two_slices(self, second):
        self.plan["slices"].append({"id": "S2", "files": [second], "depends": [], "calls": [], "interface": [], "pseudocode": []})
        return self.plan["slices"][1]

    def test_import_needs_depends(self):
        s2 = self.two_slices("b.py")
        self.write("b.py", "import a\n\nX = a.keep\n")
        self.assertIn("depends:b.py:S1", self.ids())
        s2["depends"] = ["S1"]
        self.assertEqual(set(), self.ids())

    def test_relative_import_needs_depends(self):
        (self.root / "pkg").mkdir()
        self.write("pkg/__init__.py", "")
        self.write("pkg/y.py", "Y = 1\n")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "pkg")
        self.plan["slices"][0]["files"].append("pkg/y.py")
        self.two_slices("pkg/x.py")
        self.write("pkg/x.py", "from . import y\nfrom .y import Y\n")
        self.assertIn("depends:pkg/x.py:S1", self.ids())

    def test_same_slice_and_package_imports_are_free(self):
        self.write("a.py", "import json\nfrom os import path\n\ndef keep(x):\n    return x + 1\n")
        self.assertEqual(set(), self.ids())

    @unittest.skipUnless(NODE, "node is not on PATH")
    def test_js_import_needs_depends(self):
        self.write("lib.js", "export const n = 1;\n")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "lib")
        self.plan["slices"][0]["files"].append("lib.js")
        self.two_slices("use.js")
        self.write("use.js", "import { n } from './lib';\nconst m = require('./lib.js');\nimport x from 'express';\n")
        self.assertIn("depends:use.js:S1", self.ids())

    def test_module_level_code_needs_done(self):
        self.write("a.py", "import os\n\ndef keep(x):\n    return x + 1\n\n\nLIMIT = 5\n")
        self.assertEqual({"reduction:a.py:7"}, self.ids(phase=2))
        self.plan["slices"][0]["pseudocode"] = [{"line": 1, "text": "limit", "done": "a.py:7"}]
        self.assertEqual(set(), self.ids(phase=2))

    def test_class_body_follows_method_rule(self):
        self.write("a.py", "def keep(x):\n    return x + 1\n\n\nclass K:\n    def go(self):\n        return 1\n")
        self.plan["slices"][0]["interface"] = ["K"]
        self.assertEqual({"reduction:a.py:go"}, self.ids(phase=2))

    def commit_pkg(self):
        (self.root / "pkg").mkdir()
        self.write("pkg/__init__.py", "def helper():\n    return 1\n")
        self.write("pkg/own.py", "O = 1\n")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "pkg")

    def test_package_init_import_needs_depends(self):
        self.commit_pkg()
        self.plan["slices"][0]["files"].append("pkg/__init__.py")
        self.two_slices("pkg/m.py")
        self.write("pkg/m.py", "from . import helper\n")
        self.assertIn("depends:pkg/m.py:S1", self.ids())

    def test_every_name_in_one_import_counts(self):
        self.commit_pkg()
        self.write("pkg/x.py", "X = 1\n")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "x")
        self.plan["slices"][0]["files"].append("pkg/x.py")
        s2 = self.two_slices("pkg/m.py")
        s2["files"].append("pkg/own.py")
        self.write("pkg/m.py", "from . import own, x\n")
        self.assertIn("depends:pkg/m.py:S1", self.ids())

    def test_sibling_import_needs_depends(self):
        (self.root / "src").mkdir()
        self.write("src/y.py", "Y = 1\n")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "src")
        self.plan["slices"][0]["files"].append("src/y.py")
        self.two_slices("src/m.py")
        self.write("src/m.py", "import y\n")
        self.assertIn("depends:src/m.py:S1", self.ids())

    @unittest.skipUnless(NODE, "node is not on PATH")
    def test_js_bare_specifier_is_not_a_python_file(self):
        self.two_slices("m.js")
        self.write("m.js", "const a = require('a');\nmodule.exports = { a };\n")
        self.plan["slices"][1]["calls"] = ["require"]
        self.plan["slices"][1]["interface"] = ["export a"]
        self.assertEqual(set(), self.ids())

    def test_each_statement_needs_its_own_done(self):
        self.write("a.py", "def keep(x):\n    return x + 1\n\n\nA = 1\nB = 2\n")
        self.plan["slices"][0]["pseudocode"] = [{"line": 1, "text": "a", "done": "a.py:5"}]
        self.assertEqual({"reduction:a.py:6"}, self.ids(phase=2))

    def test_multiline_statement_is_one_unit(self):
        self.write("a.py", "def keep(x):\n    return x + 1\n\n\nCONFIG = {\n    'a': 1,\n\n    'b': 2,\n}\n")
        self.plan["slices"][0]["pseudocode"] = [{"line": 1, "text": "c", "done": "a.py:8"}]
        self.assertEqual(set(), self.ids(phase=2))

    def test_decorator_belongs_to_its_function(self):
        self.write("a.py", "def keep(x):\n    return x + 1\n\n\n@staticmethod\ndef other():\n    return 2\n")
        self.plan["slices"][0]["interface"] = ["other"]
        self.plan["slices"][0]["pseudocode"] = [{"line": 1, "text": "o", "done": "a.py:7"}]
        self.assertEqual(set(), self.ids(phase=2))

    def test_module_docstring_is_not_code(self):
        self.write("a.py", '"""Doc."""\ndef keep(x):\n    return x + 1\n')
        self.assertEqual(set(), self.ids(phase=2))

    def test_colored_diff_config_still_reads_lines(self):
        self.git("config", "color.diff", "always")
        self.write("a.py", "def keep(x):\n    return other(x)\n")
        self.assertIn("eta:a.py:keep:1", self.ids())

    def test_src_layout_import_needs_depends(self):
        (self.root / "src" / "pkg").mkdir(parents=True)
        self.write("src/pkg/__init__.py", "")
        self.write("src/pkg/b.py", "B = 1\n")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "src")
        self.plan["slices"][0]["files"].append("src/pkg/b.py")
        self.two_slices("src/pkg/a.py")
        self.write("src/pkg/a.py", "from pkg.b import B\n")
        self.assertIn("depends:src/pkg/a.py:S1", self.ids())

    def test_dotted_import_runs_package_init(self):
        self.commit_pkg()
        self.plan["slices"][0]["files"].append("pkg/__init__.py")
        s2 = self.two_slices("m.py")
        s2["files"].append("pkg/own.py")
        self.write("m.py", "import pkg.own\n")
        self.assertIn("depends:m.py:S1", self.ids())

    def test_package_wins_over_module(self):
        self.commit_pkg()
        self.write("pkg.py", "P = 1\n")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "shadow")
        self.plan["slices"][0]["files"].append("pkg/__init__.py")
        s2 = self.two_slices("m.py")
        s2["files"].append("pkg.py")
        self.write("m.py", "import pkg\n")
        self.assertIn("depends:m.py:S1", self.ids())

    def test_compound_statement_children_count_alone(self):
        self.write("a.py", "def keep(x):\n    return x + 1\n\n\nif __name__ == '__main__':\n    keep(1)\n    G = 9\n")
        self.plan["slices"][0]["pseudocode"] = [{"line": 1, "text": "run", "done": "a.py:6"}]
        self.assertEqual({"reduction:a.py:5", "reduction:a.py:7"}, self.ids(phase=2))

    def test_multiline_compound_header_counts(self):
        self.write("a.py", "def keep(x):\n    return x + 1\n\n\nif (keep(1) and\n        keep(2)):\n    pass\n")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "if")
        self.write("a.py", "def keep(x):\n    return x + 1\n\n\nif (keep(1) and\n        keep(3)):\n    pass\n")
        self.assertEqual({"reduction:a.py:5"}, self.ids(phase=2))

    @unittest.skipUnless(NODE, "node is not on PATH")
    def test_js_header_and_catch_count(self):
        self.plan["slices"][0]["files"].append("m.js")
        self.write("m.js", "if (a &&\n  b) {\n  f();\n}\ntry {\n  g();\n} catch (e) {\n  h();\n}\n")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "js")
        self.write("m.js", "if (a &&\n  c) {\n  f();\n}\ntry {\n  g();\n} catch ({ code }) {\n  h();\n}\n")
        self.assertEqual({"reduction:m.js:1", "reduction:m.js:7"}, self.ids(phase=2))

    def test_stdlib_name_in_ancestor_folder_is_not_a_depend(self):
        (self.root / "myapp" / "cmd").mkdir(parents=True)
        self.write("myapp/logging.py", "L = 1\n")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "app")
        self.plan["slices"][0]["files"].append("myapp/logging.py")
        self.two_slices("myapp/cmd/run.py")
        self.write("myapp/cmd/run.py", "import logging\n")
        self.assertEqual(set(), self.ids())

    def test_subdirectory_root_and_space_in_name(self):
        sub = self.root / "sub"
        sub.mkdir()
        (sub / "my file.py").write_text("X = 1\n")
        found = {f["id"] for f in ast_checks.run(self.plan, sub, "HEAD", 1)}
        self.assertEqual({"files:my file.py"}, found)


if __name__ == "__main__":
    unittest.main()
