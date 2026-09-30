"""Validate a release tag and extract only its exact changelog section."""

import argparse
import re
from pathlib import Path


def release_notes(content: str, tag: str) -> str:
    if not re.fullmatch(r"[vV](0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", tag):
        raise ValueError("Tag must use V<major>.<minor>.<patch>, for example V0.1.0")
    headings = []
    offset = 0
    fence = None
    for line in content.splitlines(keepends=True):
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if marker:
            run = marker[1]
            if fence is None:
                fence = run
            elif run[0] == fence[0] and len(run) >= len(fence):
                fence = None
        elif fence is None:
            heading = re.match(r"^##[ \t]+(.+?)[ \t]*\r?\n?$", line)
            if heading:
                title = re.sub(r"[ \t]+#+$", "", heading[1]).strip()
                headings.append((title, offset, offset + len(line)))
        offset += len(line)
    matches = [i for i, h in enumerate(headings) if h[0].casefold() == tag.casefold()]
    if len(matches) != 1:
        raise ValueError(f"changelog needs exactly one section for {tag}; got {len(matches)}")
    index = matches[0]
    end = headings[index + 1][1] if index + 1 < len(headings) else len(content)
    body = content[headings[index][2] : end].strip()
    if not body:
        raise ValueError(f"changelog section {tag} is empty")
    return body + "\n"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag")
    parser.add_argument("--changelog", type=Path, default=Path("changelog.md"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        body = release_notes(args.changelog.read_text(encoding="utf-8-sig"), args.tag)
    except ValueError as exc:
        parser.error(str(exc))
    args.output.write_text(body, encoding="utf-8", newline="\n")
