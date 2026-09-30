import subprocess
from dataclasses import replace

import pytest
from beancount_ui.ledger import Ledger, LedgerError, read_files
from beancount_ui.sync import ConnectInput, Sync
from beancount_ui.writer import Writer
from conftest import git


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


def backup(sync):
    from beancount_ui.sync import BackupInput

    p = sync.backup_preview()
    return sync.backup(BackupInput(revision=p["revision"], head=p["head"]))


def test_backup_exact_snapshot_excludes_staged_secrets_and_no_empty_commit(sync):
    connect(sync)
    (sync.root / "index.bean").write_bytes((sync.root / "index.bean").read_bytes() + b"; saved\n")
    (sync.root / "secret.log").write_text("private", encoding="utf-8")
    git(sync.root, "add", "secret.log")
    p = sync.backup_preview()
    assert p["files"] == ["index.bean"] and p["excluded"] == ["secret.log"]
    assert backup(sync)["sync"] == "已同步"
    head = git(sync.root, "rev-parse", "HEAD")
    assert git(sync.root, "show", "--format=", "--name-only", head) == "index.bean"
    assert "secret.log" in git(sync.root, "diff", "--cached", "--name-only")
    assert backup(sync)["last_success"]
    assert head == git(sync.root, "rev-parse", "HEAD")
    remote = git(sync.root, "remote", "get-url", "origin")
    assert git(remote, "rev-parse", "master-1") == head


def test_push_failure_retains_commit_and_retry_no_duplicate(sync, monkeypatch):
    from beancount_ui.sync import GitFailure

    connect(sync)
    (sync.root / "index.bean").write_bytes((sync.root / "index.bean").read_bytes() + b"; saved\n")
    original = sync.git

    def fail(*args, **kwargs):
        if args[0] == "push":
            raise GitFailure("network unavailable")
        return original(*args, **kwargs)

    monkeypatch.setattr(sync, "git", fail)
    with pytest.raises(LedgerError, match="network"):
        backup(sync)
    head = original("rev-parse", "HEAD")
    assert "已提交待推送" in sync.status()["sync"]
    monkeypatch.setattr(sync, "git", original)
    assert backup(sync)["sync"] == "已同步"
    assert head == git(sync.root, "rev-parse", "HEAD")


def test_backup_invalid_stale_and_unapproved_history(sync):
    from beancount_ui.sync import BackupInput

    connect(sync)
    p = sync.backup_preview()
    (sync.root / "index.bean").write_bytes((sync.root / "index.bean").read_bytes() + b"; edited\n")
    with pytest.raises(LedgerError, match="过期"):
        sync.backup(BackupInput(revision=p["revision"], head=p["head"]))
    (sync.root / "index.bean").write_bytes((sync.root / "index.bean").read_bytes() + b"INVALID\n")
    with pytest.raises(LedgerError, match="校验失败"):
        backup(sync)
    git(sync.root, "checkout", "--", "index.bean")
    (sync.root / "secret.log").write_text("private", encoding="utf-8")
    git(sync.root, "add", "secret.log")
    git(sync.root, "commit", "-m", "unapproved")
    with pytest.raises(LedgerError, match="范围外"):
        backup(sync)


def test_backup_external_change_during_commit_keeps_head(sync, monkeypatch):
    connect(sync)
    head = git(sync.root, "rev-parse", "HEAD")
    original = sync.git
    (sync.root / "index.bean").write_bytes((sync.root / "index.bean").read_bytes() + b"; saved\n")

    def edit(*args, **kwargs):
        result = original(*args, **kwargs)
        if args[0] == "write-tree":
            (sync.root / "index.bean").write_bytes(
                (sync.root / "index.bean").read_bytes() + b"; race\n"
            )
        return result

    monkeypatch.setattr(sync, "git", edit)
    with pytest.raises(LedgerError, match="文件发生变化"):
        backup(sync)
    assert git(sync.root, "rev-parse", "HEAD") == head


def test_save_through_api_then_push(sync):
    from uuid import uuid4

    from beancount_ui.app import create_app
    from fastapi.testclient import TestClient

    connect(sync)
    client = TestClient(create_app(sync.settings))
    revision = client.get("/api/ledger").json()["revision"]
    p = client.post(
        "/api/preview",
        json={
            "request_id": str(uuid4()),
            "revision": revision,
            "raw": '2026-09-30 * "saved"\n  Expenses:Food 1 CNY\n  Assets:Cash -1 CNY\n',
        },
    ).json()
    assert client.post("/api/commit", json={"request_id": p["request_id"]}).status_code == 200
    assert "待提交" in client.get("/api/journal?day=2026-09-30").json()["sync"]
    p = client.post("/api/sync/backup-preview").json()
    response = client.post("/api/sync/backup", json={"revision": p["revision"], "head": p["head"]})
    assert response.status_code == 200, response.text
    assert client.get("/api/journal?day=2026-09-30").json()["sync"] == "已同步"


@pytest.fixture
def peer(sync, tmp_path):
    other = tmp_path / "peer"
    subprocess.run(
        [
            "git",
            "clone",
            "--branch",
            "master-1",
            git(sync.root, "remote", "get-url", "origin"),
            str(other),
        ],
        check=True,
        capture_output=True,
    )
    git(other, "config", "user.email", "test@example.invalid")
    git(other, "config", "user.name", "Peer")
    return other


def append_commit(root, text):
    path = root / "index.bean"
    path.write_bytes(path.read_bytes() + text.encode())
    git(root, "add", "index.bean")
    git(root, "commit", "-m", "ledger edit")
    return git(root, "rev-parse", "HEAD")


def test_clean_fast_forward_validates_before_update(sync, peer):
    connect(sync)
    expected = append_commit(peer, "; peer\n")
    git(peer, "push")
    assert backup(sync)["sync"] == "已同步"
    assert git(sync.root, "rev-parse", "HEAD") == expected
    assert b"; peer" in (sync.root / "index.bean").read_bytes()
    append_commit(peer, "INVALID\n")
    git(peer, "push")
    with pytest.raises(LedgerError, match="远端账本校验失败"):
        backup(sync)
    assert git(sync.root, "rev-parse", "HEAD") == expected
    assert not sync.ledger.refresh().errors


def test_dirty_remote_update_and_divergence_preserve_both_sides(sync, peer):
    connect(sync)
    append_commit(peer, "; peer\n")
    git(peer, "push")
    local = sync.root / "index.bean"
    local.write_bytes(local.read_bytes() + b"; local\n")
    content = local.read_bytes()
    with pytest.raises(LedgerError, match="未处理变更"):
        backup(sync)
    assert local.read_bytes() == content
    git(sync.root, "add", "index.bean")
    git(sync.root, "commit", "-m", "local ledger")
    with pytest.raises(LedgerError, match="历史分叉"):
        backup(sync)
    assert sync.state()["blocked"]
    # A human merges both sides; the app never chooses a side.
    result = subprocess.run(
        ["git", "-C", str(sync.root), "merge", "FETCH_HEAD"], capture_output=True
    )
    assert result.returncode != 0
    with pytest.raises(LedgerError, match="冲突"):
        backup(sync)
    local.write_bytes(content + b"; peer\n")
    git(sync.root, "add", "index.bean")
    git(sync.root, "commit", "-m", "resolve preserving both")
    assert backup(sync)["sync"] == "已同步"
    assert not sync.state()["blocked"]
    assert b"; local" in local.read_bytes() and b"; peer" in local.read_bytes()


def test_offline_valid_local_ledger_still_writable(sync, monkeypatch):
    from uuid import uuid4

    from beancount_ui.models import Mutation
    from beancount_ui.sync import GitFailure

    connect(sync)
    original = sync.git

    def offline(*args, **kwargs):
        if args[0] == "fetch":
            raise GitFailure("offline")
        return original(*args, **kwargs)

    monkeypatch.setattr(sync, "git", offline)
    with pytest.raises(LedgerError, match="offline"):
        backup(sync)
    p = sync.writer.preview(
        Mutation.model_validate(
            {
                "request_id": str(uuid4()),
                "revision": sync.ledger.refresh().revision,
                "raw": '2026-09-30 * "offline"\n  Expenses:Food 1 CNY\n  Assets:Cash -1 CNY\n',
            }
        )
    )
    assert sync.writer.commit(p["request_id"])["status"] == "done"
    assert not sync.ledger.refresh().errors


def test_hidden_local_change_is_backed_up_and_not_falsely_synced(sync):
    connect(sync)
    git(sync.root, "update-index", "--assume-unchanged", "index.bean")
    path = sync.root / "index.bean"
    path.write_bytes(path.read_bytes() + b"; hidden manual save\n")
    assert sync.changes() == []
    assert sync.backup_preview()["files"] == ["index.bean"]
    backup(sync)
    remote = git(sync.root, "remote", "get-url", "origin")
    assert "; hidden manual save" in git(remote, "show", "master-1:index.bean")


def test_fast_forward_preserves_ignored_local_september(sync, peer):
    connect(sync)
    local = sync.root / "txs/2026/09.bean"
    local.write_text("; local extra September\n", encoding="utf-8")
    (sync.root / ".git/info/exclude").write_text("txs/2026/09.bean\n", encoding="utf-8")
    assert sync.changes() == []
    (peer / "txs/2026/09.bean").write_text("; remote September\n", encoding="utf-8")
    (peer / "txs/2026/index.bean").write_bytes(
        (peer / "txs/2026/index.bean").read_bytes() + b'include "09.bean"\n'
    )
    git(peer, "add", ".")
    git(peer, "commit", "-m", "remote September")
    git(peer, "push")
    with pytest.raises(LedgerError, match="未处理变更"):
        backup(sync)
    assert local.read_text(encoding="utf-8") == "; local extra September\n"


@pytest.mark.parametrize("external", [False, True])
def test_fast_forward_process_crash_recovery(sync, peer, external):
    connect(sync)
    (peer / "txs/2026/09.bean").write_text("; remote September\n", encoding="utf-8")
    (peer / "txs/2026/index.bean").write_bytes(
        (peer / "txs/2026/index.bean").read_bytes() + b'include "09.bean"\n'
    )
    git(peer, "add", ".")
    git(peer, "commit", "-m", "remote September")
    git(peer, "push")
    expected = git(peer, "rev-parse", "HEAD")
    script = """
import os, sys
from pathlib import Path
from beancount_ui.config import Settings
from beancount_ui.ledger import Ledger
from beancount_ui.writer import Writer
from beancount_ui.sync import Sync, BackupInput
from beancount_ui import git_recovery
sync=Sync(Writer(Ledger(Settings(Path(sys.argv[1]),Path(sys.argv[2])))))
p=sync.backup_preview()
original=git_recovery.atomic_write
def die(path, content):
    original(path, content)
    if path.suffix == '.bean':
        os._exit(19)
git_recovery.atomic_write=die
sync.backup(BackupInput(revision=p['revision'],head=p['head']))
"""
    result = subprocess.run(
        ["uv", "run", "--frozen", "python", "-c", script, str(sync.root), str(sync.writer.state)],
        capture_output=True,
        timeout=45,
    )
    assert result.returncode == 19, result.stderr
    assert (sync.writer.state / "fast-forward.json").exists()
    restarted = Writer(Ledger(sync.settings))
    if external:
        path = sync.root / "txs/2026/09.bean"
        path.write_bytes(path.read_bytes() + b"; editor change after crash\n")
        with pytest.raises(LedgerError, match="外部文件修改"):
            with restarted.guard():
                pass
        assert b"editor change after crash" in path.read_bytes()
    else:
        with restarted.guard():
            assert not restarted.ledger.refresh().errors
            assert "txs/2026/09.bean" in restarted.ledger.refresh().included
        assert git(sync.root, "rev-parse", "HEAD") == expected
        assert not (sync.writer.state / "fast-forward.json").exists()
        assert backup(sync)["sync"] == "已同步"


@pytest.mark.parametrize(
    "name",
    [
        ".git/hooks/new",
        ".GiT/config",
        "git~1/config",
        "../outside",
        "txs/../index.bean",
        "/absolute",
        "txs\\x.bean",
        "x:stream",
        "txs//x.bean",
        ".git. /config",
    ],
)
def test_checkout_rejects_git_admin_and_unsafe_paths(tmp_path, name):
    from beancount_ui.git_recovery import checkout_path

    with pytest.raises(LedgerError, match="不安全"):
        checkout_path(tmp_path, name)


def test_fast_forward_rechecks_each_file_before_replace(sync, peer, monkeypatch):
    from beancount_ui import git_recovery

    connect(sync)
    (peer / "index.bean").write_bytes((peer / "index.bean").read_bytes() + b"; remote root\n")
    (peer / "txs/2026/index.bean").write_bytes(
        (peer / "txs/2026/index.bean").read_bytes() + b"; remote year\n"
    )
    git(peer, "add", ".")
    git(peer, "commit", "-m", "remote indexes")
    git(peer, "push")
    original = git_recovery.atomic_write
    year = sync.root / "txs/2026/index.bean"

    def race(path, content):
        original(path, content)
        if path == sync.root / "index.bean":
            year.write_bytes(year.read_bytes() + b"; concurrent editor\n")

    monkeypatch.setattr(git_recovery, "atomic_write", race)
    with pytest.raises(LedgerError, match="替换前"):
        backup(sync)
    assert b"concurrent editor" in year.read_bytes()
    assert (sync.writer.state / "fast-forward.json").exists()


def test_fast_forward_deletion_and_resume_after_branch_update(sync, peer, monkeypatch):
    from beancount_ui.sync import GitFailure

    connect(sync)
    (peer / "txs/2026/08.bean").unlink()
    (peer / "txs/2026/index.bean").write_text("; no monthly transactions\n", encoding="utf-8")
    git(peer, "add", ".")
    git(peer, "commit", "-m", "remove month")
    git(peer, "push")
    expected = git(peer, "rev-parse", "HEAD")
    original = Sync.git

    def fail(self, *args, **kwargs):
        if args[0] == "read-tree":
            raise GitFailure("simulated index lock")
        return original(self, *args, **kwargs)

    monkeypatch.setattr(Sync, "git", fail)
    with pytest.raises(LedgerError, match="index lock"):
        backup(sync)
    assert git(sync.root, "rev-parse", "HEAD") == expected
    assert (sync.writer.state / "fast-forward.json").exists()
    monkeypatch.setattr(Sync, "git", original)
    with sync.writer.guard():
        assert not sync.ledger.refresh().errors
    assert not (sync.root / "txs/2026/08.bean").exists()
    assert backup(sync)["sync"] == "已同步"


def test_reconnect_does_not_reuse_previous_backup_receipt(sync):
    connect(sync)
    backup(sync)
    assert sync.status()["sync"] == "已同步"
    assert connect(sync)["last_success"] is None
    assert sync.status()["sync"] != "已同步"
    assert sync.state()["synced_head"] is None
    assert not sync.state()["enabled"]
