#!/usr/bin/env python3
"""Shared scanner: rejects secrets and lint-class characters.

Lint classes: em-dash (U+2014) and stray CJK/fullwidth/mojibake
codepoints (CJK punctuation, CJK ideographs incl. Extension A, kana,
hangul, fullwidth forms, U+FFFD replacement character) - added per the
cjk-sweep report's hygiene-gate gap finding.

Used by .githooks/pre-push (outgoing pushes) and the CI hygiene job
(.github/workflows/ci.yml, npm run hygiene over the full committed tree).

Usage:
  scan_diff.py --range <base>..<head>   scan a commit range
  scan_diff.py --staged                 scan the staged diff
  scan_diff.py --tree                   scan every tracked file (full tree)

Secret patterns are built by concatenation so this file never contains the
literals it scans for. Secret content is never printed - only file, line
number, and the pattern name.
"""

import os
import re
import subprocess
import sys

SECRET_PATTERNS = [
    ("anthropic-api-key", "sk-" + "ant-[A-Za-z0-9_-]{8,}"),
    ("openai-api-key", "sk-" + "proj-[A-Za-z0-9_-]{8,}"),
    ("generic-sk-key", "sk-" + "[A-Za-z0-9_-]{24,}"),
    ("github-classic-token", "gh" + "p_[A-Za-z0-9]{30,}"),
    ("github-oauth-token", "gh" + "o_[A-Za-z0-9]{30,}"),
    ("github-fine-grained-pat", "github_" + "pat_[A-Za-z0-9_]{20,}"),
    ("aws-access-key-id", "AKIA" + "[0-9A-Z]{16}"),
    ("private-key-block", "-----" + "BEGIN [A-Z ]*PRIVATE KEY"),
    ("oauth-refresh-token-value", '"refresh' + 'Token"\\s*:\\s*"[^"]{8,}"'),
    ("oauth-access-token-value", '"access' + 'Token"\\s*:\\s*"[^"]{8,}"'),
    ("slack-token", "xox" + "[baprs]-[A-Za-z0-9-]{10,}"),
    ("google-api-key", "AIza" + "[0-9A-Za-z_-]{35}"),
    ("anthropic-api-header-value", "Bearer " + "sk-" + "ant-[A-Za-z0-9_-]{8,}"),
]
COMPILED = [(name, re.compile(pat)) for name, pat in SECRET_PATTERNS]
EM_DASH = "\u2014"

# Stray-CJK/mojibake defect classes (cjk-sweep report). Each entry is
# (class-name, first, last) inclusive codepoints, stored as hex only so
# this file never contains a character from the classes it scans for.
# The em-dash rule above is unchanged: it checks U+2014 only.
BAD_CODEPOINT_CLASSES = [
    ("cjk-punctuation", 0x3000, 0x303F),
    ("kana", 0x3040, 0x30FF),
    ("cjk-extension-a", 0x3400, 0x4DBF),
    ("cjk-unified", 0x4E00, 0x9FFF),
    ("hangul", 0xAC00, 0xD7AF),
    ("fullwidth", 0xFF00, 0xFFEF),
]
REPLACEMENT_CHARACTER = 0xFFFD


def diff_lines(base, head):
    """Yield (file, line_no, text) for every added line in the diff."""
    if base is None:
        proc = subprocess.run(
            ["git", "diff", "--cached", "--unified=0"],
            capture_output=True,
            text=True,
            check=True,
        )
    else:
        proc = subprocess.run(
            ["git", "diff", "--unified=0", f"{base}..{head}"],
            capture_output=True,
            text=True,
            check=True,
        )
    current_file = None
    line_no = 0
    for line in proc.stdout.splitlines():
        if line.startswith("+++ b/"):
            current_file = line[6:]
        elif line.startswith("@@"):
            m = re.search(r"\+(\d+)", line)
            if m:
                line_no = int(m.group(1))
        elif line.startswith("+") and not line.startswith("+++"):
            yield current_file, line_no, line[1:]
            line_no += 1


def bad_codepoints(text):
    """Group a line's defect codepoints by class: [(class-name, [cp, ...])].

    Classes keep their declaration order; codepoints are sorted ascending.
    """
    cps = {ord(ch) for ch in text}
    hits = []
    for name, lo, hi in BAD_CODEPOINT_CLASSES:
        in_class = sorted(cp for cp in cps if lo <= cp <= hi)
        if in_class:
            hits.append((name, in_class))
    if REPLACEMENT_CHARACTER in cps:
        hits.append(("replacement-character", [REPLACEMENT_CHARACTER]))
    return hits


def codepoint_citation(hits):
    """Render grouped hits, e.g. 'cjk-unified=U+4F60,U+597D fullwidth=U+FF1A'."""
    return " ".join(
        f"{name}=" + ",".join(f"U+{cp:04X}" for cp in cps) for name, cps in hits
    )


def check_line(path, lineno, text, violations):
    """Apply every scan rule to one line of text."""
    for name, rx in COMPILED:
        if rx.search(text):
            violations.append(("secret", name, path, lineno))
    if EM_DASH in text:
        violations.append(("lint", "em-dash", path, lineno))
    hits = bad_codepoints(text)
    if hits:
        violations.append(
            (
                "lint",
                f"cjk-fullwidth-mojibake ({codepoint_citation(hits)})",
                path,
                lineno,
            )
        )


def scan(base, head):
    violations = []
    for path, lineno, text in diff_lines(base, head):
        check_line(path, lineno, text, violations)
    return violations


def tree_lines():
    """Yield (file, line_no, text) for every tracked file's content.

    Regular files are read from the working tree; symlinks contribute their
    link-target text (the committed blob content). Directory entries such as
    gitlinks/submodules carry no file content of their own and are skipped.
    Files whose bytes are not strict UTF-8 are classified as binary assets
    and skipped (cjk-sweep binary-handling rule: the vendored realesrgan
    models and executable are not text; classification, not a silent error).
    """
    proc = subprocess.run(["git", "ls-files", "-z"], capture_output=True, check=True)
    for raw in proc.stdout.split(b"\0"):
        if not raw:
            continue
        path = os.fsdecode(raw)
        if os.path.islink(path):
            yield path, 1, os.readlink(path)
            continue
        if os.path.isdir(path):
            continue
        with open(path, "rb") as fh:
            content = fh.read()
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            yield path, lineno, line


def scan_tree():
    violations = []
    for path, lineno, text in tree_lines():
        check_line(path, lineno, text, violations)
    return violations


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--range":
        base, head = sys.argv[2].split("..")
        violations = scan(base, head)
    elif len(sys.argv) == 2 and sys.argv[1] == "--staged":
        violations = scan(None, None)
    elif len(sys.argv) == 2 and sys.argv[1] == "--tree":
        violations = scan_tree()
    else:
        print(
            "usage: scan_diff.py --range BASE..HEAD | --staged | --tree",
            file=sys.stderr,
        )
        return 2

    if not violations:
        return 0

    print("REJECTED - violations found:", file=sys.stderr)
    seen = set()
    for kind, name, path, lineno in violations:
        key = (kind, name, path, lineno)
        if key in seen:
            continue
        seen.add(key)
        if kind == "secret":
            print(
                f"  SECRET  {name}: {path}:{lineno} (value redacted)", file=sys.stderr
            )
        else:
            print(f"  LINT    {name}: {path}:{lineno}", file=sys.stderr)
    print("Remove the offending content and commit again.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
