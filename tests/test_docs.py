"""Tests for the public docs: Node version, lounge zip, lounge features, no persona words (SC18, C10.1)."""

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
READMES = ["README.md", "README.zh-CN.md", "README.zh-TW.md"]
# Each word is split, so this file holds none of them.
_WORDS = ["im" + "outo", "on" + "ii-?chan", "on" + "iichan", "on" + "ee", "mesu" + "gaki", "tsun" + "dere", "per" + "sona"]
_NAMES = ["chl" + "oe", "sher" + "ry", "y" + "uu", "mo" + "mo"]
PERSONA = re.compile("|".join(_WORDS) + r"|\b(?:" + "|".join(_NAMES) + r")\b", re.IGNORECASE)
LOUNGE_ZIP = "minimal-agent-kit-lounge-<ver>-windows.zip"
KIT_ZIP = "minimal-agent-kit-<ver>.zip"
# One identifier per lounge feature: seeded skills, gates, blackboard, child threads.
FEATURES = ["lounge-workflow", "lounge_gate", "Board", "lounge_spawn"]


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


class DocsContent(unittest.TestCase):
    def test_sc18_given_the_readmes_when_searched_for_persona_names_then_none_match(self):
        for rel in READMES + ["lounge/docs/architecture.md", "INSTALL.md", "codex/hooks.md"]:
            with self.subTest(rel):
                self.assertIsNone(PERSONA.search(read(rel)))

    def test_c10_1_given_install_when_read_then_it_requires_node_22_18(self):
        text = read("INSTALL.md")
        self.assertIn("22.18", text)
        self.assertNotIn("22.13", text)

    def test_c10_1_given_install_when_read_then_it_has_a_lounge_section_with_both_zips(self):
        text = read("INSTALL.md")
        self.assertIn(LOUNGE_ZIP, text)
        self.assertIn("lounge/agent-lounge.exe", text)
        self.assertIn(KIT_ZIP, text)

    def test_c10_1_given_each_readme_when_read_then_it_names_the_lounge_zip_and_node_22_18(self):
        for rel in READMES:
            with self.subTest(rel):
                text = read(rel)
                self.assertIn(LOUNGE_ZIP, text)
                self.assertIn(KIT_ZIP, text)
                self.assertIn("22.18", text)
                self.assertNotIn("22.13", text)

    def test_c10_1_given_each_readme_when_read_then_it_names_the_four_lounge_features(self):
        for rel in READMES:
            for feature in FEATURES:
                with self.subTest(rel=rel, feature=feature):
                    self.assertIn(feature, read(rel))

    def test_c10_1_given_the_readmes_when_read_then_each_links_the_architecture_page(self):
        for rel in READMES:
            with self.subTest(rel):
                self.assertIn("lounge/docs/architecture.md", read(rel))

    def test_c10_1_given_the_architecture_page_when_read_then_it_covers_the_kept_parts(self):
        text = read("lounge/docs/architecture.md")
        for part in ["lounge_gate", "lounge_spawn", "CODEX_HOME", "blackboard", "classifier", "Node 22.18"]:
            with self.subTest(part):
                self.assertIn(part, text)

    def test_c10_1_given_the_codex_hook_doc_when_read_then_it_names_node_guard_js_and_the_timeout(self):
        text = read("codex/hooks.md")
        self.assertIn("node", text)
        self.assertIn("guard.js", text)
        self.assertIn("timeout = 600", text)

    def test_c10_1_given_install_and_hook_doc_when_read_then_the_codex_hook_command_is_the_same(self):
        command = "node \"<home>/.codex/kit/guard/guard.js\""
        self.assertIn(command, read("INSTALL.md"))
        self.assertIn(command, read("codex/hooks.md"))


if __name__ == "__main__":
    unittest.main()
