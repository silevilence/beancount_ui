from beancount_ui.scheduler import ScheduleInput, Scheduler, configure
from beancount_ui.sync import GitFailure, Sync
from beancount_ui.writer import Writer
from conftest import git
from test_sync import connect


def enable(sync, quiet=0):
    connect(sync)
    configure(sync, ScheduleInput(enabled=True, interval=5, quiet=quiet))
    return Scheduler(sync)


def test_no_change_checks_make_no_network_or_empty_commits(sync, monkeypatch):
    worker = enable(sync)
    original = sync.git

    def no_network(*args, **kwargs):
        assert args[0] not in ("fetch", "push", "commit-tree")
        return original(*args, **kwargs)

    monkeypatch.setattr(sync, "git", no_network)
    for now in (100, 105, 110):
        worker.tick(now)
    assert "无账本变更" in worker.reason


def test_continuous_saves_coalesce_and_restart_retry(sync, monkeypatch):
    worker = enable(sync, quiet=10)
    path = sync.root / "index.bean"
    path.write_bytes(path.read_bytes() + b"; one\n")
    base = git(sync.root, "rev-list", "--count", "HEAD")
    worker.tick(100)
    path.write_bytes(path.read_bytes() + b"; two\n")
    worker.tick(105)
    worker.tick(110)
    assert "等待" in worker.reason
    original = sync.git

    def fail(*args, **kwargs):
        if args[0] == "push":
            raise GitFailure("offline")
        return original(*args, **kwargs)

    monkeypatch.setattr(sync, "git", fail)
    worker.tick(115)
    head = git(sync.root, "rev-parse", "HEAD")
    assert sync.state()["pending"]
    assert int(git(sync.root, "rev-list", "--count", "HEAD")) == int(base) + 1
    # A fresh service recovers pending commits and durable debounce state.
    restarted = Scheduler(Sync(Writer(sync.ledger)))
    restarted.tick(120)
    restarted.tick(130)
    assert sync.status()["sync"] == "已同步"
    assert git(sync.root, "rev-parse", "HEAD") == head


def test_invalid_and_busy_are_skipped(sync):
    from filelock import FileLock

    worker = enable(sync)
    other_lock = FileLock(sync.writer.lock.lock_file)
    with other_lock:
        worker.tick(100)
    assert "正在写入" in worker.reason
    head = git(sync.root, "rev-parse", "HEAD")
    (sync.root / "index.bean").write_bytes((sync.root / "index.bean").read_bytes() + b"INVALID\n")
    worker.tick(105)
    assert "校验错误" in worker.reason
    assert git(sync.root, "rev-parse", "HEAD") == head
    for now in (200, 1000, 10000, 20000, 30000):
        worker.tick(now)
        assert sync.state()["next_check"] <= now + 3600


def test_configuration_off_and_single_executor(sync):
    import pytest
    from beancount_ui.ledger import LedgerError
    from filelock import Timeout

    with pytest.raises(LedgerError, match="接入"):
        configure(sync, ScheduleInput(enabled=True))
    worker = Scheduler(sync)
    worker.tick(100)
    assert worker.reason == "自动备份关闭"
    enable(sync)
    other = Scheduler(Sync(Writer(sync.ledger)))
    with worker.leader, pytest.raises(Timeout):
        other.leader.acquire()
    configure(sync, ScheduleInput(enabled=False))
    worker.tick(105)
    assert worker.reason == "自动备份关闭"


def test_scheduler_lifecycle_and_schedule_api(sync):
    from beancount_ui.app import create_app
    from fastapi.testclient import TestClient

    connect(sync)
    app = create_app(sync.settings)
    with TestClient(app) as client:
        assert app.state.scheduler.thread.is_alive()
        response = client.post(
            "/api/sync/schedule", json={"enabled": True, "interval": 5, "quiet": 0}
        )
        assert response.status_code == 200
        assert response.json()["enabled"]
        assert "schedule_reason" in client.get("/api/sync").json()
        assert (
            client.post("/api/sync/schedule", json={"enabled": True, "interval": 0}).status_code
            == 422
        )
    assert not app.state.scheduler.thread.is_alive()
