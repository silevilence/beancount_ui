import subprocess
from dataclasses import replace

import pytest
from beancount_ui.ledger import Ledger, LedgerError, read_files
from beancount_ui.sync import ConnectInput, Sync
from beancount_ui.writer import Writer


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


@pytest.fixture
def sync(ledger, tmp_path):
    root = ledger.settings.ledger_dir
    git(root, "init", "-b", "master-1")
    git(root, "config", "user.email", "test@example.invalid")
    git(root, "config", "user.name", "Test")
    git(root, "add", ".")
    git(root, "commit", "-m", "baseline")
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    git(root, "remote", "add", "origin", str(remote))
    git(root, "push", "-u", "origin", "master-1")
    return Sync(Writer(ledger))


def connect(sync):
    preview = sync.preview()
    return sync.connect(ConnectInput(revision=preview["revision"]))


def test_connect_preserves_september_and_previews_include(sync):
    path = sync.root / "txs/2026/09.bean"
    path.write_text("; September already uploaded, new local supplement\n", encoding="utf-8")
    original = read_files(sync.root)
    p = sync.preview()
    assert "txs/2026/09.bean" in p["unreferenced"]
    assert any(c["file"] == "txs/2026/09.bean" for c in p["changes"])
    assert connect(sync)["connected"]
    assert read_files(sync.root) == original
    p = sync.preview(["txs/2026/09.bean"])
    assert '+include "txs/2026/09.bean"' in p["diff"]
    result = sync.connect(ConnectInput(revision=p["revision"], include=["txs/2026/09.bean"]))
    assert result["connected"] and not result["enabled"]
    assert not sync.ledger.refresh().errors


def test_clone_empty_and_refuse_overwrite(sync, tmp_path):
    with pytest.raises(LedgerError, match="空目录"):
        sync.clone()
    settings = replace(
        sync.settings,
        ledger_dir=tmp_path / "clone",
        state_dir=tmp_path / "clone-state",
        remote=git(sync.root, "remote", "get-url", "origin"),
    )
    other = Sync(Writer(Ledger(settings)))
    assert other.clone()["errors"] == []
    assert connect(other)["connected"]


def test_onboarding_branch_remote_errors_and_stale_preview(sync):
    p = sync.preview()
    (sync.root / "index.bean").write_bytes((sync.root / "index.bean").read_bytes() + b"\n")
    with pytest.raises(LedgerError, match="过期"):
        sync.connect(ConnectInput(revision=p["revision"]))
    git(sync.root, "checkout", "-b", "wrong")
    assert "分支错误" in sync.status()["error"]
    git(sync.root, "checkout", "master-1")
    git(sync.root, "remote", "set-url", "origin", "https://secret@example.invalid/x")
    assert "secret" not in str(sync.status())
    assert "凭据" in sync.status()["error"]


def test_onboarding_offline_and_invalid(sync):
    git(sync.root, "remote", "set-url", "origin", str(sync.root / "missing.git"))
    with pytest.raises(LedgerError, match="认证"):
        connect(sync)
    assert not sync.state()["connected"]
