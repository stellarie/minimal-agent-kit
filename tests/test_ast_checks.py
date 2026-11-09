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

    def test_pure_calls_are_not_effects(self):
        self.write("a.py", "import json\ndef keep(x):\n    items = [x]\n    items.remove(x)\n    return json.dumps(x)\n")
        self.assertFalse([i for i in self.ids() if i.startswith("effect:")])

    def test_zero_argument_wrapper_is_not_eta(self):
        self.write("a.py", "def keep(x):\n    return x + 1\n\ndef now():\n    return compute()\n")
        self.plan["slices"][0]["interface"] = ["now"]
        self.assertEqual(set(), self.ids())

    def test_subdirectory_root_and_space_in_name(self):
        sub = self.root / "sub"
        sub.mkdir()
        (sub / "my file.py").write_text("X = 1\n")
        found = {f["id"] for f in ast_checks.run(self.plan, sub, "HEAD", 1)}
        self.assertEqual({"files:my file.py"}, found)


if __name__ == "__main__":
    unittest.main()
