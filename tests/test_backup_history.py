import json

import pytest
from beancount_ui.app import create_app
from beancount_ui.sync import BackupInput, GitFailure, Sync
from beancount_ui.writer import Writer
from fastapi.testclient import TestClient
from test_sync import connect


def test_backup_history_persists_success_and_failure_without_credentials(sync, monkeypatch):
    connect(sync)
    plan = sync.backup_preview()
    sync.backup(BackupInput(**{key: plan[key] for key in ("revision", "head")}))
    history = Sync(Writer(sync.ledger)).history()
    assert history[0]["action"] == "backup"
    assert history[0]["outcome"] == "success"
    assert history[1]["action"] == "preview"
    original = sync.git

    def fail(*args, **kwargs):
        if args[0] == "fetch":
            raise GitFailure("连接失败 github_pat_test_secret")
        return original(*args, **kwargs)

    monkeypatch.setattr(sync, "git", fail)
    with pytest.raises(GitFailure):
        sync.backup(BackupInput(revision=plan["revision"], head=plan["head"]), source="automatic")
    event = sync.history()[0]
    assert event["outcome"] == "failed"
    assert event["source"] == "automatic"
    assert "[REDACTED]" in event["message"]
    assert "github_pat_test_secret" not in sync.history_path.read_text(encoding="utf-8")
    assert not sync.history_path.is_relative_to(sync.root)


def test_history_is_bounded_and_api_is_read_only(sync, monkeypatch):
    for i in range(205):
        sync.record_event("check", "automatic", "skipped", f"检查 {i}")
    assert len(sync.history()) == 200
    assert sync.history()[0]["message"] == "检查 204"
    assert sync.history()[-1]["message"] == "检查 5"

    def no_git(*args, **kwargs):
        raise AssertionError("Reading local history must not invoke Git")

    monkeypatch.setattr(Sync, "git", no_git)
    app = create_app(sync.settings)
    with TestClient(app) as client:
        response = client.get("/api/sync/history")
        assert response.status_code == 200
        assert response.json() == sync.history()


def test_history_write_error_does_not_turn_completed_backup_into_failure(sync, monkeypatch):
    connect(sync)
    plan = sync.backup_preview()

    def unavailable():
        raise OSError("private filesystem detail")

    monkeypatch.setattr(sync, "history", unavailable)
    result = sync.backup(BackupInput(revision=plan["revision"], head=plan["head"]))
    assert result["sync"] == "已同步"


def test_invalid_history_is_reported_not_silently_empty(sync):
    sync.history_path.write_text("broken", encoding="utf-8")
    with pytest.raises(json.JSONDecodeError):
        sync.history()
