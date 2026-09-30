"""Explicit repository onboarding and snapshot-bound Git operations.

Git credentials are supplied by the server's credential helper/SSH environment.
Never relay command output on failure: it can contain a credential-bearing URL.
"""

import difflib
import json
import os
import re
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from pydantic import BaseModel, Field

from .ledger import LedgerError, digest, load_snapshot, read_files
from .writer import Writer, atomic_write


class ConnectInput(BaseModel):
    revision: str
    include: list[str] = Field(default_factory=list)


class BackupInput(BaseModel):
    revision: str
    head: str


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

    def git(self, *args, env=None, data=None, binary=False):
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
        return result.stdout if binary else result.stdout.decode("utf-8").rstrip("\r\n")

    def tree_files(self, ref):
        files = {}
        for item in self.git("ls-tree", "-rz", ref).split("\0"):
            if not item:
                continue
            meta, name = item.split("\t", 1)
            if Path(name).suffix not in {".bean", ".beancount"}:
                continue
            mode, kind, oid = meta.split()
            if mode != "100644" or kind != "blob":
                raise LedgerError("账本只允许普通文本文件")
            files[name] = self.git("cat-file", "blob", oid, binary=True)
        return files

    def require_connected(self):
        remote = self.repository()
        state = self.state()
        if (
            not state.get("connected")
            or state.get("remote") != remote
            or state.get("branch") != self.settings.branch
        ):
            raise LedgerError("请先完成接入预览与确认")
        return remote

    def plan(self):
        self.require_connected()
        head = self.git("rev-parse", "HEAD")
        snap = self.ledger.refresh()
        if snap.errors:
            raise LedgerError("账本校验失败；已保存的文件保留，请先修复账本错误")
        before = self.tree_files(head)
        old = load_snapshot(before, self.settings.entry)
        allowed = set(snap.included) | set(old.included)
        allowed = {n for n in allowed if not any(p.startswith(".") for p in Path(n).parts)}
        changed = {c["file"] for c in self.changes()}
        # Git may normalize CRLF on Windows; do not rewrite unchanged files solely for EOL.
        names = sorted(n for n in allowed & changed if before.get(n) != snap.files.get(n))
        # Commit exactly the validated bytes, excluding drafts, caches and unrelated files.
        candidate = before | {n: snap.files[n] for n in names if n in snap.files}
        for name in names:
            if name not in snap.files:
                candidate.pop(name, None)
        if load_snapshot(candidate, self.settings.entry).errors:
            raise LedgerError("允许提交的文件不能组成有效账本，请检查 include 范围")
        return {
            "head": head,
            "revision": snap.revision,
            "files": names,
            "excluded": sorted(c["file"] for c in self.changes() if c["file"] not in names),
            "message": f"账本备份：{len(names)} 个文件（{datetime.now(UTC).date()}）",
            "diff": "".join(
                "".join(
                    difflib.unified_diff(
                        before.get(n, b"").decode().splitlines(True),
                        snap.files.get(n, b"").decode().splitlines(True),
                        fromfile=n,
                        tofile=n,
                    )
                )
                for n in names
            ),
        }, snap

    def backup_preview(self):
        with self.writer.guard():
            plan, _ = self.plan()
            return plan

    def fetch(self, remote):
        self.git("fetch", "--no-tags", remote, f"refs/heads/{self.settings.branch}")
        remote_head = self.git("rev-parse", "FETCH_HEAD")
        self.save(remote_head=remote_head)
        return remote_head

    def check_remote(self, head, remote_head):
        if self.git("merge-base", head, remote_head) != remote_head:
            raise LedgerError("远端有新记录或历史分叉，请先人工核对；未自动合并")

    def validate_outgoing(self, remote_head, head):
        for commit in self.git("rev-list", "--reverse", f"{remote_head}..{head}").splitlines():
            files = self.tree_files(commit)
            snap = load_snapshot(files, self.settings.entry)
            parent = self.git("rev-parse", f"{commit}^1")
            old = load_snapshot(self.tree_files(parent), self.settings.entry)
            names = self.git("diff", "--name-only", "-z", parent, commit).split("\0")
            allowed = set(snap.included) | set(old.included)
            if snap.errors or any(
                n and (n not in allowed or any(p.startswith(".") for p in Path(n).parts))
                for n in names
            ):
                raise LedgerError("待推送历史含非法账本或范围外文件，请人工核对本地提交")

    def commit_snapshot(self, plan, snap):
        with tempfile.TemporaryDirectory(prefix="bean-git-") as folder:
            env = {"GIT_INDEX_FILE": str(Path(folder) / "index")}
            self.git("read-tree", plan["head"], env=env)
            for name in plan["files"]:
                if name in snap.files:
                    oid = self.git("hash-object", "-w", "--stdin", data=snap.files[name])
                    self.git("update-index", "--add", "--cacheinfo", "100644", oid, name, env=env)
                else:
                    self.git("update-index", "--force-remove", "--", name, env=env)
            tree = self.git("write-tree", env=env)
            # Reject external edits before moving the branch. Git CAS protects concurrent commits.
            if digest(read_files(self.root)) != plan["revision"]:
                raise LedgerError("校验后文件发生变化，请重新预览")
            commit = self.git("commit-tree", tree, "-p", plan["head"], "-m", plan["message"])
            self.git("update-ref", f"refs/heads/{self.settings.branch}", commit, plan["head"])
            # Only reconcile the explicitly included paths in the user's index.
            self.git("reset", "--quiet", commit, "--", *plan["files"])
            return commit

    def backup(self, request: BackupInput):
        try:
            with self.writer.guard():
                remote = self.require_connected()
                plan, snap = self.plan()
                if plan["revision"] != request.revision or plan["head"] != request.head:
                    raise LedgerError("备份预览已过期，请重新预览")
                remote_head = self.fetch(remote)
                self.check_remote(plan["head"], remote_head)
                self.validate_outgoing(remote_head, plan["head"])
                head = self.commit_snapshot(plan, snap) if plan["files"] else plan["head"]
                if head != remote_head:
                    self.save(message="已提交待推送", pending=True)
                    # Explicit immutable source and destination: no upstream/pushurl surprises.
                    self.git("push", remote, f"{head}:refs/heads/{self.settings.branch}")
                self.save(
                    message="已同步",
                    pending=False,
                    error=None,
                    last_success=datetime.now(UTC).isoformat(),
                    synced_head=head,
                    synced_revision=plan["revision"],
                    remote_head=head,
                )
        except LedgerError as exc:
            with self.writer.lock:
                self.save(message=f"备份失败：{exc}", error=str(exc))
            raise
        return self.status()

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
            base = self.state().get("remote_head") or f"origin/{self.settings.branch}"
            return int(self.git("rev-list", "--count", f"{base}..HEAD"))
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
                revision = digest(read_files(self.root))
                pending_files = any(
                    Path(c["file"]).suffix in {".bean", ".beancount"} for c in changes
                )
                label = "已保存 · 待提交" if pending_files else "已保存 · 远端状态未核验"
                if not pending_files and self.unpushed():
                    label = "已提交待推送"
                if state.get("synced_head") == head and state.get("synced_revision") == revision:
                    label = "已同步"
                if state.get("error"):
                    label += " · 备份失败"
                return state | {
                    "connected": connected,
                    "remote": remote,
                    "branch": self.settings.branch,
                    "changes": changes,
                    "head": head,
                    "ahead": self.unpushed(),
                    "sync": label,
                }
            except GitFailure as exc:
                return state | {
                    "connected": False,
                    "enabled": False,
                    "branch": self.settings.branch,
                    "error": str(exc),
                    "changes": [],
                }
