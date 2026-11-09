#!/usr/bin/env python3
"""Flag common Simplified Technical English (ASD-STE100) violations in prose.

The tool reads Markdown, skips code, tables, headings, and frontmatter, and
reports the usual smells: a sentence over the word limit, a long paragraph,
passive voice, hedges, existential "there is", and contractions.

It is a smell test, not a certified checker. Read every hit before you change
anything.

Usage:
    python ste_check.py FILE [FILE ...] [--limit 25] [--json] [--only CODE]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

DEFAULT_LIMIT = 25
PARAGRAPH_SENTENCE_LIMIT = 6

CODES = (
    "LONG_SENTENCE",
    "LONG_PARAGRAPH",
    "PASSIVE",
    "HEDGE",
    "EXISTENTIAL",
    "CONTRACTION",
)

HEDGES = frozenset({
    "should", "probably", "seems", "seem", "might", "perhaps", "maybe",
    "somewhat", "fairly", "quite", "likely", "possibly", "roughly",
})

CONTRACTIONS = re.compile(
    r"\b(?:n't|it's|that's|there's|here's|what's|let's|who's)\b",
    re.IGNORECASE,
)
EXISTENTIAL = re.compile(r"\bthere\s+(?:is|are|was|were|will\s+be)\b", re.IGNORECASE)
PASSIVE = re.compile(
    r"\b(?:is|are|was|were|be|been|being)\s+(?:\w+ly\s+)?(\w+(?:ed|en))\b",
    re.IGNORECASE,
)
LIST_ITEM = re.compile(r"^\s*(?:[-*+]|\d+\.)\s")
FENCE = re.compile(r"^\s*(```|~~~)")
SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z(`*\"'\[0-9])")
INLINE_CODE = re.compile(r"`[^`]*`")
LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
EMPHASIS = re.compile(r"[*_~]")


def extract_prose(lines: list[str]) -> list[tuple[int, str]]:
    """Return (line number, text) pairs for prose lines only.

    Args:
        lines: the raw file lines, without terminators.

    Returns:
        One pair per prose line, with blockquote markers removed.
    """
    units: list[tuple[int, str]] = []
    in_fence = False
    fence_marker = ""
    in_frontmatter = False
    for index, raw in enumerate(lines):
        stripped = raw.strip()
        if index == 0 and stripped == "---":
            in_frontmatter = True
            continue
        if in_frontmatter:
            if stripped == "---":
                in_frontmatter = False
            continue
        fence = FENCE.match(raw)
        if fence:
            if not in_fence:
                in_fence = True
                fence_marker = fence.group(1)
            elif fence.group(1) == fence_marker:
                in_fence = False
            continue
        if in_fence:
            continue
        if stripped.startswith("|") or stripped.startswith("#") or stripped.startswith("<!--"):
            continue
        units.append((index + 1, re.sub(r"^\s*>\s?", "", raw)))
    return units


def build_paragraphs(units: list[tuple[int, str]]) -> list[dict[str, object]]:
    """Join wrapped prose lines into paragraphs, each keeping its first line.

    Args:
        units: pairs from ``extract_prose``.

    Returns:
        Paragraphs as ``{"line": int, "text": str}`` in file order.
    """
    paragraphs: list[dict[str, object]] = []
    current: dict[str, object] | None = None
    for line_number, text in units:
        if text.strip() == "":
            current = None
            continue
        if LIST_ITEM.match(text):
            body = LIST_ITEM.sub("", text, count=1)
            body = re.sub(r"^\[[ xX]\]\s*", "", body)
            current = {"line": line_number, "text": body}
            paragraphs.append(current)
            continue
        if current is None:
            current = {"line": line_number, "text": text}
            paragraphs.append(current)
        else:
            current["text"] = str(current["text"]) + " " + text
    return paragraphs


def count_words(sentence: str) -> int:
    """Count words, treating inline code, links, and emphasis as single tokens.

    Args:
        sentence: the raw sentence text.

    Returns:
        The word count.
    """
    text = INLINE_CODE.sub("X", sentence)
    text = LINK.sub(r"\1", text)
    text = EMPHASIS.sub("", text)
    return len([word for word in text.split() if word])


def split_sentences(text: str) -> list[str]:
    """Split a paragraph into sentences.

    Args:
        text: the paragraph text.

    Returns:
        The sentences, in order.
    """
    return [part for part in SENTENCE_SPLIT.split(text) if part.strip()]


def check_text(path: str, text: str, limit: int = DEFAULT_LIMIT) -> list[dict[str, object]]:
    """Check one document.

    Args:
        path: the display path used in findings.
        text: the document text.
        limit: the maximum words in one sentence.

    Returns:
        Findings, each with path, line, code, detail, and the offending text.
    """
    findings: list[dict[str, object]] = []
    for paragraph in build_paragraphs(extract_prose(text.splitlines())):
        line = int(paragraph["line"])  # type: ignore[arg-type]
        body = str(paragraph["text"])
        sentences = split_sentences(body)
        for sentence in sentences:
            words = count_words(sentence)
            if words > limit:
                findings.append(record(path, line, "LONG_SENTENCE", f"{words} words", sentence))
            # A quoted span is an example, not the author's own prose.
            lexical = strip_quoted(sentence)
            match = HEDGE_SEARCH(lexical)
            if match:
                findings.append(record(path, line, "HEDGE", match, sentence))
            match = EXISTENTIAL.search(lexical)
            if match:
                findings.append(record(path, line, "EXISTENTIAL", match.group(0), sentence))
            match = CONTRACTIONS.search(lexical)
            if match:
                findings.append(record(path, line, "CONTRACTION", match.group(0), sentence))
            match = PASSIVE.search(lexical)
            if match:
                findings.append(record(path, line, "PASSIVE", match.group(0), sentence))
        if len(sentences) > PARAGRAPH_SENTENCE_LIMIT:
            findings.append(
                record(
                    path,
                    line,
                    "LONG_PARAGRAPH",
                    f"{len(sentences)} sentences",
                    body,
                )
            )
    return findings


QUOTED = re.compile(r'"[^"]*"|\u201c[^\u201d]*\u201d')


def strip_quoted(text: str) -> str:
    """Replace quoted spans with a space, so examples are not checked.

    Args:
        text: the sentence text.

    Returns:
        The text without its quoted spans.
    """
    return QUOTED.sub(" ", text)


def HEDGE_SEARCH(sentence: str) -> str:
    """Return the first hedge word in a sentence, or an empty string.

    Args:
        sentence: the sentence text.

    Returns:
        The matched hedge, lowercased, or ``""``.
    """
    for word in re.findall(r"[A-Za-z']+", sentence):
        if word.lower() in HEDGES:
            return word.lower()
    return ""


def record(path: str, line: int, code: str, detail: str, text: str) -> dict[str, object]:
    """Build one finding.

    Args:
        path: the display path.
        line: the 1-based line number.
        code: the finding code.
        detail: the specific evidence.
        text: the offending text, truncated for display.

    Returns:
        The finding.
    """
    snippet = " ".join(str(text).split())
    return {
        "path": path,
        "line": line,
        "code": code,
        "detail": detail,
        "text": snippet[:140] + ("..." if len(snippet) > 140 else ""),
    }


def check_file(path: Path, limit: int) -> list[dict[str, object]]:
    """Check one file on disk.

    Args:
        path: the file to read.
        limit: the maximum words in one sentence.

    Returns:
        Findings for that file.
    """
    return check_text(str(path), path.read_text(encoding="utf-8", errors="replace"), limit)


def build_parser() -> argparse.ArgumentParser:
    """Build the argument parser.

    Returns:
        The parser.
    """
    parser = argparse.ArgumentParser(
        prog="ste_check.py",
        description="Flag common ASD-STE100 violations in Markdown prose.",
        epilog="Exit status: 0 clean, 1 findings, 2 bad arguments.",
    )
    parser.add_argument("paths", nargs="+", help="Markdown files to check")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="maximum words per sentence")
    parser.add_argument("--json", action="store_true", help="print one JSON object")
    parser.add_argument("--only", action="append", choices=CODES, help="report only this code; repeatable")
    parser.add_argument("--skip", action="append", choices=CODES, help="drop this code; repeatable")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the command line.

    Args:
        argv: arguments after the program name.

    Returns:
        The process exit status.
    """
    args = build_parser().parse_args(argv)
    findings: list[dict[str, object]] = []
    for raw in args.paths:
        path = Path(raw)
        if not path.is_file():
            print(f"not a file: {raw}", file=sys.stderr)
            return 2
        findings.extend(check_file(path, args.limit))
    if args.only:
        findings = [item for item in findings if item["code"] in set(args.only)]
    if args.skip:
        findings = [item for item in findings if item["code"] not in set(args.skip)]
    if args.json:
        print(json.dumps({"ok": not findings, "findings": findings, "count": len(findings)}, indent=2))
    else:
        for item in findings:
            print(f"{item['path']}:{item['line']}  {item['code']}  {item['detail']}")
            print(f"  {item['text']}")
        summary = "clean" if not findings else f"{len(findings)} to look at"
        print(f"{len(args.paths)} file(s): {summary}")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
