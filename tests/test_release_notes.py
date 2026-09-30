import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("release_notes", "scripts/release_notes.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
release_notes = module.release_notes


def test_exact_version_with_newer_section_and_markdown():
    body = "### Features\n\n- first\n\n```md\n## V9.0.0\n```\n\n- last"
    content = f"# Change Log\n\n## V1.1.0\n\nnew\n\n## V0.1.0\n\n{body}\n\n## V0.0.1\nold"
    assert release_notes(content, "v0.1.0") == body + "\n"
    assert release_notes(content.replace("\n", "\r\n"), "V0.0.1") == "old\n"


@pytest.mark.parametrize(
    "content",
    [
        "## V0.1.1\nwrong",
        "## V0.1.0\n\n## V0.2.0\nother",
        "## V0.1.0\nfirst\n## v0.1.0\nsecond",
        "## V0.1.0-extra\nwrong",
    ],
)
def test_invalid_sections_fail_closed(content):
    with pytest.raises(ValueError):
        release_notes(content, "V0.1.0")


@pytest.mark.parametrize("tag", ["0.1.0", "V01.1.0", "V0.1", "V0.1.0-rc1", "V0.1.0\n"])
def test_invalid_tags(tag):
    with pytest.raises(ValueError):
        release_notes("## " + tag + "\nnotes", tag)


def test_current_release_is_nonempty():
    assert "### ✨ 新功能" in release_notes(Path("changelog.md").read_text("utf-8"), "V0.1.0")
