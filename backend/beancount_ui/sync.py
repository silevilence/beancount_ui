"""Explicit repository onboarding and snapshot-bound Git operations.

Git credentials are supplied by the server's credential helper/SSH environment.
Never relay command output on failure: it can contain a credential-bearing URL.
"""

import difflib
import json
import os
import re
import subprocess
from pathlib import Path

from pydantic import BaseModel, Field

from .ledger import LedgerError, digest, load_snapshot, read_files
from .writer import Writer, atomic_write


class ConnectInput(BaseModel):
    revision: str
    include: list[str] = Field(default_factory=list)


class GitFailure(LedgerError):
    pass


def safe_remote(remote: str) -> str:
    # Credentials must live in a helper, never in a URL/config/API response.
    if not remote or remote.startswith("-") or any(c in remote for c in "\n\r\0"):
        raise GitFailure("请在服务端配置账本远端")
    if "://" in remote and ("@" in remote or "?" in remote or "#" in remote):
        raise GitFailure("远端 URL 不得包含凭据或参数，请使用服务端 Git 凭据助手")
    if "::" in remote:
        raise GitFailure("不支持该 Git 传输协议")
    return remote


class Sync:
    def __init__(self, writer: Writer):
        self.writer = writer
        self.ledger = writer.ledger
        self.root = writer.root
        self.settings = self.ledger.settings
        self.path = writer.state / "sync.json"

    def state(self):
        if not self.path.exists():
            return {"connected": False, "enabled": False}
        return json.loads(self.path.read_text(encoding="utf-8"))

    def save(self, **values):
        state = self.state() | values
        atomic_write(self.path, json.dumps(state, ensure_ascii=False).encode())
        return state

    def git(self, *args, env=None, data=None):
        try:
            result = subprocess.run(
                ["git", "-c", "core.hooksPath=", "-C", str(self.root), *args],
                input=data,
                capture_output=True,
                timeout=45,
                env=os.environ
                | {"GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}
                | (env or {}),
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise GitFailure("Git 不可用或连接超时；本地记录保留，请检查服务端网络和凭据") from exc
        if result.returncode:
            raise GitFailure(
                f"Git {args[0]} 失败；请检查网络、认证、目标分支或仓库状态。本地记录保留。"
            )
        return result.stdout.decode("utf-8", errors="strict").rstrip("\r\n")

    def repository(self):
        top = self.git("rev-parse", "--show-toplevel")
        if Path(top).resolve() != self.root.resolve():
            raise GitFailure("账本必须使用独立 Git 仓库根目录")
        if self.git("branch", "--show-current") != self.settings.branch:
            raise GitFailure(f"分支错误：请人工切换到 {self.settings.branch} 后重试")
        remote = safe_remote(self.git("remote", "get-url", "origin"))
        if self.settings.remote and remote != safe_remote(self.settings.remote):
            raise GitFailure("origin 与服务端配置不一致，请核对后重试")
        return remote

    def remote_head(self, remote):
        line = self.git("ls-remote", "--exit-code", remote, f"refs/heads/{self.settings.branch}")
        return line.split()[0]

    def changes(self):
        raw = self.git("status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames")
        return [{"status": line[:2], "file": line[3:]} for line in raw.split("\0") if line]

    def unpushed(self):
        try:
            return int(self.git("rev-list", "--count", f"origin/{self.settings.branch}..HEAD"))
        except GitFailure:
            return None

    def candidate(self, include):
        files = read_files(self.root)
        snap = load_snapshot(files, self.settings.entry)
        for name in include:
            if name not in files or name in snap.included or not re.fullmatch(r"[\w/.-]+", name):
                raise LedgerError("请选择未纳入 include 的账本文件")
        if include:
            entry = self.settings.entry
            files[entry] = (
                files[entry].rstrip()
                + b"\n"
                + "".join(f'include "{name}"\n' for name in sorted(set(include))).encode()
            )
        return files, load_snapshot(files, self.settings.entry)

    def preview(self, include=()):
        with self.writer.guard():
            remote = self.repository()
            original = read_files(self.root)
            files, snap = self.candidate(include)
            return {
                "revision": digest(original),
                "remote": remote,
                "branch": self.settings.branch,
                "changes": self.changes(),
                "ahead": self.unpushed(),
                "unreferenced": sorted(set(files) - set(snap.included)),
                "errors": snap.errors,
                "diff": "".join(
                    difflib.unified_diff(
                        original[self.settings.entry].decode().splitlines(True),
                        files[self.settings.entry].decode().splitlines(True),
                        fromfile=self.settings.entry,
                        tofile=self.settings.entry,
                    )
                ),
            }

    def clone(self):
        with self.writer.guard():
            if self.root.exists() and any(self.root.iterdir()):
                raise LedgerError("仅允许克隆到空目录；已有副本请使用接入预览")
            remote = safe_remote(self.settings.remote)
            self.root.mkdir(parents=True, exist_ok=True)
            self.git(
                "clone", "--branch", self.settings.branch, "--single-branch", "--", remote, "."
            )
        return self.preview()

    def connect(self, request: ConnectInput):
        with self.writer.guard():
            remote = self.repository()
            head = self.remote_head(remote)
            original = read_files(self.root)
            if digest(original) != request.revision:
                raise LedgerError("接入预览已过期，请重新预览")
            files, snap = self.candidate(request.include)
            if snap.errors:
                raise LedgerError("账本校验失败，请修复后重新接入")
            if digest(read_files(self.root)) != request.revision:
                raise LedgerError("接入期间文件发生变化，请重新预览")
            if files != original:
                atomic_write(self.root / self.settings.entry, files[self.settings.entry])
            self.save(
                connected=True,
                enabled=False,
                remote=remote,
                branch=self.settings.branch,
                remote_head=head,
                message="接入完成；自动备份关闭",
                last_success=None,
            )
        return self.status()

    def status(self):
        with self.writer.guard():
            state = self.state()
            try:
                remote = self.repository()
                changes = self.changes()
                head = self.git("rev-parse", "HEAD")
                connected = bool(
                    state.get("connected")
                    and state.get("remote") == remote
                    and state.get("branch") == self.settings.branch
                )
                return state | {
                    "connected": connected,
                    "remote": remote,
                    "branch": self.settings.branch,
                    "changes": changes,
                    "head": head,
                    "ahead": self.unpushed(),
                    "error": None,
                }
            except GitFailure as exc:
                return state | {
                    "connected": False,
                    "enabled": False,
                    "branch": self.settings.branch,
                    "error": str(exc),
                    "changes": [],
                }
