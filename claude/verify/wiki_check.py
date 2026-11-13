"""Check a wiki folder against the wiki format (core/skills/wiki/format.md and SKILL.md).

Usage: python wiki_check.py WIKI_DIR [--json]
Prints findings in the kit format (see plan.schema.md): one line each and a count line, or a JSON list.
Exit 1 when a finding has level "fail". A "consider" or "not-run" finding gives exit 0.
Checks: index.md shape and its 20 line limit, index and page agreement, page file names, the 80 line
limit, frontmatter keys, the section names and order, and a citation on each Facts item.
"""

import argparse
import datetime
import json
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from verify_plan import finding  # noqa: E402

INDEX_HEADING = "# Wiki index"
INDEX_LIMIT = 20
PAGE_LIMIT = 80
PAGE_NAME = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*\.md")
INDEX_LINE = re.compile(r"- \[[^\]]+\]\((?P<file>[^)]+\.md)\): \S")
FIELD = re.compile(r"(?P<key>\w+):[ \t]*(?P<value>.*?)\s*")
DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
SHA = re.compile(r"[0-9a-fA-F]{7,40}")
TAG = "standards|architecture|library|gotcha|decision"
TAG_LIST = re.compile(rf"\[\s*(?:{TAG})(?:\s*,\s*(?:{TAG}))*\s*\]")
FENCE = re.compile(r" {0,3}(`{3,}(?!.*`)|~{3,})")
CITATION = re.compile(r"`[^`\s]+:\d+`")
SECTIONS = ("Summary", "Facts", "Decisions", "Gotchas")
KEYS = ("title", "updated", "source_commit", "tags")


def read_wiki(folder):
    try:
        paths = sorted(folder.iterdir())
    except OSError:
        return None
    files = {}
    for path in paths:
        if path.name.lower().endswith(".md"):
            try:
                files[path.name] = path.read_bytes().decode("utf-8-sig")
            except (OSError, UnicodeDecodeError):
                files[path.name] = None
    return files


def _is_date(value):
    if not DATE.fullmatch(value):
        return False
    try:
        datetime.date.fromisoformat(value)
    except ValueError:
        return False
    return True


VALUE_RULES = {
    "updated": (_is_date, "a real YYYY-MM-DD date"),
    "source_commit": (SHA.fullmatch, "7 to 40 hex characters"),
    "tags": (TAG_LIST.fullmatch, "a [a, b] list of standards, architecture, library, gotcha, decision"),
}


def _check_frontmatter(name, lines):
    """Return the findings and the index of the first line after the block."""
    if not lines or lines[0] != "---" or "---" not in lines[1:]:
        return [finding(f"frontmatter:{name}", "frontmatter", "the page does not start with a --- block", name, 1)], 0
    end = lines.index("---", 1)
    fields = {}
    for number, line in enumerate(lines[1:end], 2):
        match = FIELD.fullmatch(line)
        if match:
            fields[match["key"]] = (number, match["value"])
    found = []
    for key in KEYS:
        number, value = fields.get(key, (1, ""))
        if not value:
            found.append(finding(f"key:{name}:{key}", "frontmatter", f"{key} is missing or empty", name, number))
        elif key in VALUE_RULES and not VALUE_RULES[key][0](value):
            found.append(finding(f"{key.replace('_', '-')}:{name}", "frontmatter", f"{key} is not {VALUE_RULES[key][1]}", name, number))
    return found, end + 1


def _check_body(name, lines, start):
    found = []
    facts = []
    last = -1
    section = item = None
    fence = None
    for number, line in enumerate(lines[start:], start + 1):
        opening = FENCE.match(line)
        if fence:
            if re.fullmatch(f" {{0,3}}{fence[0]}{{{len(fence)},}}[ \\t]*", line):
                fence = None
        elif opening:
            fence = opening[1]
        elif line.startswith("## "):
            section = line[3:].strip()
            item = None
            if section not in SECTIONS:
                found.append(finding(f"section:{name}:{number}", "section", f"{section!r} is not a section name", name, number))
            elif SECTIONS.index(section) <= last:
                found.append(finding(
                    f"section-order:{name}:{number}", "section", f"{section} is a duplicate or out of order", name, number
                ))
            else:
                last = SECTIONS.index(section)
        elif section == "Facts" and line.startswith("- "):
            item = [number, line]
            facts.append(item)
        elif item and line.strip():
            item[1] += line
        else:
            item = None
    for number, text in facts:
        if not CITATION.search(text):
            found.append(finding(f"citation:{name}:{number}", "citation", "the fact has no `path:N` citation", name, number, "consider"))
    return found


def check_page(name, text):
    lines = text.splitlines()
    found = []
    if not PAGE_NAME.fullmatch(name):
        found.append(finding(f"name:{name}", "name", "the file name is not <kebab-topic>.md", name))
    if len(lines) > PAGE_LIMIT:
        found.append(finding(f"page-lines:{name}", "limit", f"{len(lines)} lines, limit {PAGE_LIMIT}", name))
    front, start = _check_frontmatter(name, lines)
    return found + front + _check_body(name, lines, start)


def check_index(text, pages):
    lines = text.splitlines()
    found = []
    if not lines or lines[0] != INDEX_HEADING:
        found.append(finding("index-heading", "index", f"line 1 is not {INDEX_HEADING!r}", "index.md", 1))
    if len(lines) > INDEX_LIMIT:
        found.append(finding("index-lines", "limit", f"{len(lines)} lines, limit {INDEX_LIMIT}", "index.md"))
    linked = set()
    for number, line in enumerate(lines[1:], 2):
        link = INDEX_LINE.match(line)
        if link:
            linked.add(link["file"])
            if link["file"] not in pages:
                found.append(finding(f"index-dead:{link['file']}", "index", f"{link['file']} is not in the folder", "index.md", number))
        elif line.strip():
            found.append(finding(
                f"index-line:{number}", "index", "not a '- [title](file.md): summary' line", "index.md", number, "consider"
            ))
    for page in sorted(set(pages) - linked):
        found.append(finding(f"index-absent:{page}", "index", f"{page} has no index line", "index.md"))
    return found


def check_wiki(files):
    if files is None:
        return [finding("wiki:unread", "read", "WIKI_DIR is not a directory that can be read", level="not-run")]
    found = [
        finding(f"unread:{name}", "read", f"{name} cannot be read, or is not UTF-8", name, level="not-run")
        for name, text in files.items() if text is None
    ]
    if "index.md" not in files:
        found.append(finding("index:missing", "index", "the folder has no index.md"))
    elif files["index.md"] is not None:
        found += check_index(files["index.md"], [name for name in files if name != "index.md"])
    for name, text in files.items():
        if name != "index.md" and text is not None:
            found += check_page(name, text)
    return found


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("wiki", type=pathlib.Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    found = check_wiki(read_wiki(args.wiki))
    blocking = [f for f in found if f["level"] == "fail"]
    if args.json:
        print(json.dumps(found, indent=1))
    else:
        for f in found:
            where = f"{f['file']}:{f['line']}  " if f["file"] else ""
            print(f"{f['level']:9} {f['id']}  {where}{f['detail']}".encode("ascii", "backslashreplace").decode())
        print(f"{len(found)} finding(s), {len(blocking)} fail")
    return 1 if blocking else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
