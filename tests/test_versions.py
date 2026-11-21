"""Every lounge manifest carries the kit version (C1.1)."""

import json
import pathlib
import re
import unittest


class Versions(unittest.TestCase):
    def test_c1_1_every_lounge_version_equals_the_kit_version(self):
        root = pathlib.Path(__file__).resolve().parents[1]

        def read(rel):
            return (root / rel).read_text(encoding="utf-8")

        kit = json.loads(read("claude/.claude-plugin/plugin.json"))["version"]
        manifests = ["lounge/app/src-tauri/tauri.conf.json", "lounge/app/package.json", "lounge/core/package.json"]
        manifests += ["lounge/ui/package.json", "lounge/plugins/claude-code/plugin.json", "lounge/plugins/codex/plugin.json"]
        for rel in manifests:
            with self.subTest(rel):
                self.assertEqual(json.loads(read(rel))["version"], kit)
        for rel in ("lounge/app", "lounge/core", "lounge/ui"):
            with self.subTest(rel + "/package-lock.json"):
                lock = json.loads(read(rel + "/package-lock.json"))
                self.assertEqual([lock["version"], lock["packages"][""]["version"]], [kit, kit])
        with self.subTest("Cargo.toml"):
            match = re.search(r'^version = "([^"]+)"', read("lounge/app/src-tauri/Cargo.toml"), re.MULTILINE)
            self.assertEqual(match.group(1), kit)
        with self.subTest("Cargo.lock"):
            match = re.search(r'name = "agent-lounge"\nversion = "([^"]+)"', read("lounge/app/src-tauri/Cargo.lock"))
            self.assertEqual(match.group(1), kit)
