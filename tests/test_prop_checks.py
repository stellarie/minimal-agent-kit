"""Tests for prop_checks.py (property tests demanded for tested claims)."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

VERIFY = Path(__file__).resolve().parents[1] / "core" / "verify"
sys.path.insert(0, str(VERIFY))
import prop_checks

PY_PROP = "from hypothesis import given\n\n@given(x=1)\ndef test_c1_1_total(x):\n    pass\n"
PY_PLAIN = "def test_c1_1_total():\n    pass\n"
JS_PROP = "test('c1_1 total', () => { fc.assert(fc.property(fc.nat(), (n) => true)); });\n"
JS_PLAIN = "test('c1_1 total', () => { expect(1).toBe(1); });\n"


def claim(**extra):
    return {"id": "C1.1", "strength": "tested", "evidence": "x", **extra}


class Project:
    def __init__(self, tc, files, claims, slice_files):
        self.tmp = tempfile.TemporaryDirectory()
        tc.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name, text in files.items():
            p = self.root / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8")
        self.plan = {"goal": "g", "acceptance": [], "slices": [{"id": "S1", "files": slice_files, "claims": claims}]}
        (self.root / "plan.json").write_text(json.dumps(self.plan), encoding="utf-8")

    def ids(self, level=None):
        return {f["id"] for f in prop_checks.run(self.plan, self.root) if level in (None, f["level"])}


def py(tc, test=PY_PROP, claims=None, extra=None, manifest="hypothesis\n"):
    files = {"a.py": "x = 1\n", "tests/test_a.py": test}
    if manifest:
        files["requirements.txt"] = manifest
    files.update(extra or {})
    return Project(tc, files, claims or [claim()], ["a.py"])


def js(tc, test=JS_PROP, claims=None, extra=None, manifest='{"devDependencies": {"fast-check": "3"}}'):
    files = {"a.js": "x = 1\n", "a.test.js": test}
    if manifest:
        files["package.json"] = manifest
    files.update(extra or {})
    return Project(tc, files, claims or [claim()], ["a.js"])


class RuleTests(unittest.TestCase):
    def test_claim_id_rule(self):
        self.assertTrue(prop_checks.name_matches("C1.1", "test_C1_1_x"))
        self.assertTrue(prop_checks.name_matches("C1.1", "c1_1"))
        self.assertFalse(prop_checks.name_matches("C1.1", "test_c1_10_x"))
        self.assertFalse(prop_checks.name_matches("C1.1", "test_other"))


class PythonTests(unittest.TestCase):
    def seeded(self):
        return "from hypothesis import given, settings\n\n@settings(derandomize=True)\n@given(x=1)\ndef test_c1_1_total(x):\n    pass\n"

    def test_property_without_seed(self):
        self.assertEqual({"property-seed:C1.1"}, py(self, PY_PROP).ids("fail"))

    def test_derandomize_in_test_file(self):
        self.assertEqual(set(), py(self, self.seeded()).ids("fail"))

    def test_seed_decorator_in_test_file(self):
        t = "from hypothesis import given, seed\n\n@seed(1)\n@given(x=1)\ndef test_c1_1_a(x):\n    pass\n"
        self.assertEqual(set(), py(self, t).ids("fail"))

    def test_seed_in_conftest(self):
        p = py(self, extra={"tests/conftest.py": "settings.register_profile('p', derandomize=True)\n"})
        self.assertEqual(set(), p.ids("fail"))

    def test_seed_in_pyproject(self):
        p = py(self, extra={"pyproject.toml": "[tool.x]\nderandomize = true\n[tool.y]\nhypothesis = 1\n# derandomize=True\n"})
        self.assertEqual(set(), p.ids("fail"))

    def test_no_given(self):
        self.assertEqual({"property:C1.1"}, py(self, PY_PLAIN).ids("fail"))

    def test_attribute_given_with_call(self):
        t = "import hypothesis\n\n@hypothesis.given(x=1)\n@hypothesis.seed(2)\ndef test_c1_1_a(x):\n    pass\n"
        self.assertEqual(set(), py(self, t).ids("fail"))

    def test_given_on_other_function(self):
        t = "@given(x=1)\ndef test_other(x):\n    pass\n\ndef test_c1_1_a():\n    pass\n"
        self.assertEqual({"property:C1.1"}, py(self, t).ids("fail"))

    def test_no_test_at_all(self):
        self.assertEqual({"property:C1.1"}, py(self, "def test_z():\n    pass\n").ids("fail"))

    def test_c1_1_does_not_match_c1_10(self):
        t = "@given(x=1)\n@seed(1)\ndef test_c1_10_a(x):\n    pass\n"
        self.assertEqual({"property:C1.1"}, py(self, t).ids("fail"))

    def test_no_library(self):
        p = py(self, PY_PLAIN, manifest="requests\n")
        self.assertEqual(set(), p.ids("fail"))
        self.assertEqual({"property:library:py"}, p.ids("consider"))

    def test_syntax_error_is_not_run(self):
        p = py(self, "def test_c1_1_a(:\n")
        self.assertEqual({"property:unread:tests/test_a.py"}, p.ids("not-run"))
        self.assertEqual({"property:C1.1"}, p.ids("fail"))

    def test_cases_out_of_scope(self):
        p = py(self, PY_PLAIN, claims=[claim(cases=[{"name": "e", "test": "t"}])])
        self.assertEqual(set(), p.ids())

    def test_proved_out_of_scope(self):
        self.assertEqual(set(), py(self, PY_PLAIN, claims=[claim(strength="proved")]).ids())

    def test_pass_gives_no_finding(self):
        self.assertEqual(set(), py(self, self.seeded()).ids())


class JsTests(unittest.TestCase):
    def test_property_without_seed(self):
        self.assertEqual({"property-seed:C1.1"}, js(self).ids("fail"))

    def test_seed_in_assert(self):
        t = "test('c1_1 a', () => { fc.assert(fc.property(fc.nat(), n => true), { seed: 42 }); });\n"
        self.assertEqual(set(), js(self, t).ids("fail"))

    def test_configure_global_in_test(self):
        t = "fc.configureGlobal({ numRuns: 5 });\n" + JS_PROP
        self.assertEqual(set(), js(self, t).ids("fail"))

    def test_seed_in_jest_setup_from_package_json(self):
        pkg = '{"devDependencies": {"fast-check": "3"}, "jest": {"setupFiles": ["<rootDir>/setup.js"]}}'
        p = js(self, manifest=pkg, extra={"setup.js": "fc.configureGlobal({ seed: 1 });\n"})
        self.assertEqual(set(), p.ids("fail"))

    def test_seed_in_vitest_config_setup(self):
        cfg = "export default { test: { setupFiles: ['./setup/fc.ts'] } };\n"
        p = js(self, extra={"vitest.config.ts": cfg, "setup/fc.ts": "fc.configureGlobal({ seed: 1 });\n"})
        self.assertEqual(set(), p.ids("fail"))

    def test_setup_file_not_named_gives_fail(self):
        p = js(self, extra={"setup.js": "fc.configureGlobal({ seed: 1 });\n"})
        self.assertEqual({"property-seed:C1.1"}, p.ids("fail"))

    def test_no_fc(self):
        self.assertEqual({"property:C1.1"}, js(self, JS_PLAIN).ids("fail"))

    def test_it_title_and_ts_file(self):
        t = "it(\"C1_1 sums\", () => { fc.assert(fc.property(fc.nat(), n => true), {seed: 1}); });\n"
        p = Project(self, {"a.ts": "", "a.test.ts": t, "package.json": '{"dependencies": {"fast-check": "3"}}'}, [claim()], ["a.ts"])
        self.assertEqual(set(), p.ids())

    def test_file_level_check_and_title_rule(self):
        t = "test('other', () => { fc.assert(fc.property(fc.nat(), n => true)); });\n" + JS_PLAIN
        self.assertEqual({"property-seed:C1.1"}, js(self, t).ids("fail"))
        t = "test('other', () => { fc.assert(fc.property(fc.nat(), n => true)); });\n"
        self.assertEqual({"property:C1.1"}, js(self, t).ids("fail"))
        self.assertEqual({"property:C1.1"}, js(self, JS_PLAIN.replace("c1_1", "c1_10")).ids("fail"))

    def test_no_library(self):
        p = js(self, JS_PLAIN, manifest='{"dependencies": {}}')
        self.assertEqual(set(), p.ids("fail"))
        self.assertEqual({"property:library:js"}, p.ids("consider"))

    def test_python_library_does_not_cover_js(self):
        p = js(self, JS_PLAIN, manifest=None, extra={"requirements.txt": "hypothesis\n"})
        self.assertEqual({"property:library:js"}, p.ids("consider"))


class CliTests(unittest.TestCase):
    def run_cli(self, p):
        r = subprocess.run([sys.executable, str(VERIFY / "prop_checks.py"), str(p.root / "plan.json"), "--root", str(p.root)],
                           capture_output=True, text=True)
        return r.returncode, json.loads(r.stdout)

    def test_fail_exits_1(self):
        code, found = self.run_cli(py(self, PY_PLAIN))
        self.assertEqual(1, code)
        self.assertEqual("property:C1.1", found[0]["id"])

    def test_library_consider_exits_0(self):
        code, found = self.run_cli(py(self, PY_PLAIN, manifest="requests\n"))
        self.assertEqual(0, code)
        self.assertEqual("consider", found[0]["level"])

    def test_main_returns_code(self):
        p = py(self, PY_PROP)
        self.assertEqual(1, prop_checks.main([str(p.root / "plan.json"), "--root", str(p.root)]))


if __name__ == "__main__":
    unittest.main()
