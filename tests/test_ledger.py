import subprocess

import pytest
from beancount_ui.app import create_app
from beancount_ui.ledger import LedgerError, git_info, load_snapshot, read_files
from fastapi.testclient import TestClient


def test_load_is_read_only(ledger):
    before = read_files(ledger.settings.ledger_dir)
    status = ledger.status()
    assert status["writable"]
    assert status["version"] == "3.2.3"
    assert len(status["files"]) == 12
    assert "Assets:Bank" in status["accounts"]
    assert read_files(ledger.settings.ledger_dir) == before
    assert status["git"]["repository"] is False
    assert ledger.refresh() is ledger.refresh()
    assert TestClient(create_app(ledger.settings)).get("/api/ledger").json()["writable"]


def test_errors_block_and_report_lines(ledger):
    path = ledger.settings.ledger_dir / "txs/2026/08.bean"
    path.write_bytes(path.read_bytes() + b'\n2026-09-30 * "bad"\n  Assets:Missing 2 CNY\n')
    status = ledger.status()
    assert not status["writable"]
    assert all(e["file"] == "txs/2026/08.bean" and e["line"] > 0 for e in status["errors"])


@pytest.mark.parametrize(
    "source",
    [
        b'include "../escape.bean"',
        b'include "absent.bean"',
        b'plugin "evil"',
        b'include "C:/outside.bean"',
    ],
)
def test_unsafe_or_missing_includes(source):
    snap = load_snapshot({"main.beancount": source})
    assert snap.errors


def test_missing_entry_and_directory(tmp_path):
    assert load_snapshot({}).errors
    with pytest.raises(LedgerError):
        read_files(tmp_path / "absent")


def test_git_discovery(ledger):
    root = ledger.settings.ledger_dir
    for args in [
        ["init", "-b", "master-1"],
        ["add", "."],
        [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "fixture",
        ],
    ]:
        subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)
    info = git_info(root)
    assert info["branch"] == "master-1" and info["commit"]
    assert info["changes"] == []
    (root / "extra.bean").write_text("; local", encoding="utf-8")
    assert git_info(root)["sync"] == "待提交"
    assert ledger.status()["unreferenced"] == ["extra.bean"]
