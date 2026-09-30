"""One elected background executor per ledger, with durable debounce and retry state."""

import threading
import time

from filelock import FileLock, Timeout
from pydantic import BaseModel, Field

from .ledger import LedgerError, digest, read_files
from .sync import BackupInput, GitFailure, Sync, SyncBlocked


class ScheduleInput(BaseModel):
    enabled: bool
    interval: int = Field(default=300, ge=5, le=86400)
    quiet: int = Field(default=60, ge=0, le=3600)


def configure(sync: Sync, request: ScheduleInput):
    with sync.writer.guard():
        if request.enabled:
            sync.require_connected()
        sync.save(**request.model_dump(), next_check=0, failures=0)
    return sync.status()


class Scheduler:
    def __init__(self, sync: Sync):
        self.sync = sync
        self.leader = FileLock(str(sync.writer.lock.lock_file) + ".scheduler", timeout=0)
        self.stop_event = threading.Event()
        self.thread = None
        self.reason = "自动备份关闭"

    def start(self):
        self.thread = threading.Thread(target=self.run, name="ledger-backup", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=2)

    def run(self):
        while not self.stop_event.is_set():
            try:
                with self.leader:
                    self.tick()
            except Timeout:
                self.reason = "由另一后台执行者处理"
            except Exception:
                # Keep the executor alive, without logging private file contents or credentials.
                self.reason = "后台暂不可用，请检查服务端状态目录"
            self.stop_event.wait(1)

    def tick(self, now=None):
        now = time.time() if now is None else now
        try:
            with self.sync.writer.lock.acquire(timeout=0):
                self._tick(now)
        except Timeout:
            self.reason = "正在写入或同步，本轮跳过"

    def _tick(self, now):
        sync = self.sync
        state = sync.state()
        if not state.get("enabled") or not state.get("connected"):
            self.reason = "自动备份关闭"
            return
        if state.get("blocked"):
            self.reason = "冲突/远端状态待处理；请解决后立即同步"
            return
        if now < state.get("next_check", 0):
            self.reason = state.get("schedule_reason", "等待下次检查")
            return
        interval, quiet = state.get("interval", 300), state.get("quiet", 60)
        try:
            sync.writer.recover()
            revision = digest(read_files(sync.root))
            head = sync.git("rev-parse", "HEAD")
            observed = f"{head}:{revision}"
            if state.get("observed") != observed:
                sync.save(observed=observed, changed_at=now)
                state = sync.state()
            if now - state.get("changed_at", now) < quiet:
                self.reason = "等待连续保存结束"
                sync.save(
                    next_check=min(now + interval, state["changed_at"] + quiet),
                    schedule_reason=self.reason,
                )
                return
            plan, _ = sync.plan()
            if not plan["files"] and sync.unpushed() == 0:
                self.reason = "无账本变更，本轮跳过"
                sync.save(next_check=now + interval, schedule_reason=self.reason, failures=0)
                return
            sync.backup(BackupInput(revision=plan["revision"], head=plan["head"]))
            self.reason = "自动备份成功"
            sync.save(next_check=now + interval, failures=0, schedule_reason=self.reason)
        except (LedgerError, OSError) as exc:
            failures = min(state.get("failures", 0) + 1, 10)
            delay = min(3600, max(interval, 5) * 2 ** (failures - 1))
            self.reason = (
                "网络/服务失败，稍后重试"
                if isinstance(exc, GitFailure)
                else "校验错误或冲突，本轮跳过"
            )
            sync.save(
                next_check=now + delay,
                failures=failures,
                schedule_reason=self.reason,
                blocked=isinstance(exc, SyncBlocked),
            )
