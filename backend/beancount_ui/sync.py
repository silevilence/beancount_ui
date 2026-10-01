"""Explicit repository onboarding and snapshot-bound Git operations.

Git credentials are supplied by the server's credential helper/SSH environment.
Only log redacted stderr on failure; never relay raw output to the browser.
"""

import difflib
import json
import logging
import os
import re
import subprocess
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field

from .git_network import ProxyInput, redact_diagnostic, validate_proxy
from .github_auth import GithubAuth, GithubAuthInput
from .layout import ensure_include
from .layout_config import read_layout
from .ledger import LedgerError, digest, load_snapshot, read_files
from .writer import Writer, atomic_write

logger = logging.getLogger(__name__)


class ConnectInput(BaseModel):
    revision: str
    include: list[str] = Field(default_factory=list)


class BackupInput(BaseModel):
    revision: str
    head: str


class GitFailure(LedgerError):
    pass


class SyncBlocked(LedgerError):
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
        self.github_auth = GithubAuth(writer.state)

    def state(self):
        if not self.path.exists():
            return {"connected": False, "enabled": False}
        return json.loads(self.path.read_text(encoding="utf-8"))

    def save(self, **values):
        state = self.state() | values
        atomic_write(self.path, json.dumps(state, ensure_ascii=False).encode())
        return state

    def proxy(self):
        state = self.state()
        return {
            "proxy_mode": state.get("proxy_mode", "system"),
            "proxy_url": state.get("proxy_url", ""),
        }

    def configure_proxy(self, request: ProxyInput):
        if request.mode not in {"system", "direct", "custom"}:
            raise ValueError("请选择跟随服务端、直连或自定义代理")
        url = validate_proxy(request.url) if request.mode == "custom" else ""
        with self.writer.guard():
            self.save(proxy_mode=request.mode, proxy_url=url, next_check=0, failures=0)
            return self.proxy()

    def git(self, *args, env=None, data=None, binary=False):
        proxy = self.proxy()
        mode = proxy["proxy_mode"]
        url = proxy["proxy_url"] if mode == "custom" else self.settings.git_proxy
        overrides = []
        process_env = os.environ | {"GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}
        secret = ""
        if args[0] in {"clone", "ls-remote", "fetch", "push"}:
            for arg in args:
                if arg.startswith("https://"):
                    auth_options, auth_env, secret = self.github_auth.git_options(arg)
                    overrides.extend(auth_options)
                    process_env |= auth_env
                    break
        if mode != "system" or url:
            value = url if mode != "direct" else ""
            overrides.extend(["-c", f"http.proxy={value}", "-c", f"remote.origin.proxy={value}"])
            # A URL-specific Git config outranks http.proxy, even on the command line.
            for arg in args:
                if arg.startswith(("https://", "http://")):
                    overrides.extend(["-c", f"http.{arg}.proxy={value}"])
            process_env |= {"NO_PROXY": "", "no_proxy": ""}
        started = time.monotonic()

        def log_failure(code, stderr):
            # Do not log argv, stdin, stdout or exception repr: they may contain ledger data
            # or secrets. Git stderr still requires redaction (helpers can echo credentials).
            detail = (
                stderr.decode("utf-8", errors="replace") if isinstance(stderr, bytes) else stderr
            )
            if secret and detail:
                detail = detail.replace(secret, "[REDACTED]")
            logger.error(
                "Git failure: operation=%s branch=%s proxy_mode=%s code=%s elapsed=%.2fs stderr=%s",
                args[0],
                redact_diagnostic(self.settings.branch),
                mode,
                code,
                time.monotonic() - started,
                redact_diagnostic(detail),
            )

        try:
            result = subprocess.run(
                ["git", "-c", "core.hooksPath=", *overrides, "-C", str(self.root), *args],
                input=data,
                capture_output=True,
                timeout=45,
                env=process_env | (env or {}),
            )
        except subprocess.TimeoutExpired as exc:
            log_failure("timeout", exc.stderr)
            raise GitFailure("Git 连接超时（45 秒）；本地记录保留，请查看服务端控制台日志") from exc
        except OSError as exc:
            log_failure(f"{type(exc).__name__}:{exc.errno}", str(exc))
            raise GitFailure("Git 不可用或连接超时；本地记录保留，请检查服务端网络和凭据") from exc
        if result.returncode:
            log_failure(result.returncode, result.stderr)
            if any(
                marker in result.stderr.lower()
                for marker in (
                    b"could not read username",
                    b"authentication failed",
                    b"invalid username or token",
                )
            ):
                raise GitFailure(
                    "Git 认证失败或缺少凭据；请在备份中心保存或更新 GitHub Token，"
                    "并确认其具有目标仓库权限。本地记录保留。"
                )
            raise GitFailure(
                f"Git {args[0]} 失败；请检查网络、认证、代理、目标分支或仓库状态。"
                "本地记录保留；详情请查看服务端控制台日志。"
            )
        return result.stdout if binary else result.stdout.decode("utf-8").rstrip("\r\n")

    def configured_remote(self):
        return safe_remote(self.settings.remote) if self.settings.remote else self.repository()

    def configure_github_auth(self, request: GithubAuthInput):
        with self.writer.guard():
            return self.github_auth.save(self.configured_remote(), request)

    def remove_github_auth(self):
        with self.writer.guard():
            return self.github_auth.remove()

    def check_connection(self):
        with self.writer.guard():
            remote = self.configured_remote()
            self.root.mkdir(parents=True, exist_ok=True)
            head = self.remote_head(remote)
            return {"message": "仓库和目标分支可读取；推送权限将在实际备份时验证", "head": head}

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

    def require_resolved(self):
        git_dir = Path(self.git("rev-parse", "--absolute-git-dir"))
        if self.git("ls-files", "-u") or any(
            (git_dir / name).exists()
            for name in ("MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD")
        ):
            raise SyncBlocked("仓库存在未完成的合并/变基或冲突；请人工解决并完成操作，再立即同步")

    def plan(self):
        self.require_connected()
        self.require_resolved()
        head = self.git("rev-parse", "HEAD")
        snap = self.ledger.refresh()
        if snap.errors:
            raise LedgerError("账本校验失败；已保存的文件保留，请先修复账本错误")
        before = self.tree_files(head)
        old = self.historical_snapshot(before)
        allowed = set(snap.included) | set(old.included)
        allowed = {n for n in allowed if not any(p.startswith(".") for p in Path(n).parts)}
        changed = {c["file"] for c in self.changes()}
        # Git may normalize CRLF on Windows; do not rewrite unchanged files solely for EOL.
        names = sorted(
            n
            for n in allowed
            if before.get(n) != snap.files.get(n)
            and (
                n in changed
                or before.get(n, b"").replace(b"\r\n", b"\n")
                != snap.files.get(n, b"").replace(b"\r\n", b"\n")
                or (n in before) != (n in snap.files)
            )
        )
        # Commit exactly the validated bytes, excluding drafts, caches and unrelated files.
        candidate = before | {n: snap.files[n] for n in names if n in snap.files}
        for name in names:
            if name not in snap.files:
                candidate.pop(name, None)
        if load_snapshot(candidate, self.ledger.entry).errors:
            raise LedgerError("允许提交的文件不能组成有效账本，请检查 include 范围")
        today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
        return {
            "head": head,
            "revision": snap.revision,
            "files": names,
            "excluded": sorted(
                (
                    changed
                    | {n for n in snap.files if n not in allowed and snap.files[n] != before.get(n)}
                )
                - set(names)
            ),
            "message": f"账本备份：{len(names)} 个文件（{today}）",
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
            base = self.state().get("remote_head")
            try:
                commits = self.git("rev-list", "--reverse", f"{base}..{plan['head']}").splitlines()
                paths = set()
                for commit in commits:
                    paths.update(
                        self.git("diff", "--name-only", "-z", f"{commit}^1", commit).split("\0")
                    )
                plan["outgoing_files"] = sorted(paths - {""})
                plan["outgoing_count"] = len(commits)
            except GitFailure:
                plan["outgoing_files"] = []
                plan["outgoing_count"] = None
            return plan

    def fetch(self, remote):
        self.git("fetch", "--no-tags", remote, f"refs/heads/{self.settings.branch}")
        remote_head = self.git("rev-parse", "FETCH_HEAD")
        self.save(remote_head=remote_head)
        return remote_head

    def check_remote(self, head, remote_head):
        self.require_resolved()
        try:
            base = self.git("merge-base", head, remote_head)
        except GitFailure as exc:
            raise SyncBlocked("本地与远端历史无共同基点，请人工核对仓库") from exc
        if base == remote_head:
            return False
        if base != head:
            raise SyncBlocked("历史分叉；请备份两侧内容并人工合并，解决后重新校验与立即同步")
        local_files = {n: b.replace(b"\r\n", b"\n") for n, b in read_files(self.root).items()}
        committed = {n: b.replace(b"\r\n", b"\n") for n, b in self.tree_files(head).items()}
        if self.changes() or local_files != committed:
            raise SyncBlocked("远端有新记录且本地有未处理变更；请先保留并人工处理，再立即同步")
        remote = load_snapshot(self.tree_files(remote_head), self.ledger.entry)
        if remote.errors:
            raise SyncBlocked("远端账本校验失败；保留当前有效本地版本，请修复远端后重试")
        for item in self.git("ls-tree", "-rz", remote_head).split("\0"):
            if item and not item.startswith(("100644 blob ", "100755 blob ")):
                raise SyncBlocked("远端含符号链接或子模块，请人工核对")
        from .git_recovery import prepare

        try:
            prepare(self, head, remote_head)
        except LedgerError as exc:
            raise SyncBlocked(str(exc)) from exc
        if self.ledger.refresh().errors:
            raise SyncBlocked("更新后账本校验失败，请检查外部修改；暂停同步")
        return True

    def historical_snapshot(self, files):
        layout, history, _ = read_layout(self.settings)
        # Unpushed commits may predate a newly created entry. Validate them with
        # the last known entry that actually existed in that commit. Never fall
        # back from an existing but invalid current entry.
        entry = next(
            (item.entry for item in [layout, *reversed(history)] if item.entry in files),
            layout.entry,
        )
        return load_snapshot(files, entry)

    def validate_outgoing(self, remote_head, head):
        for commit in self.git("rev-list", "--reverse", f"{remote_head}..{head}").splitlines():
            files = self.tree_files(commit)
            snap = self.historical_snapshot(files)
            parent = self.git("rev-parse", f"{commit}^1")
            old = self.historical_snapshot(self.tree_files(parent))
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
            # A freshly deployed container need not have an interactive user's Git identity.
            name = self.git("config", "--default", "日用账本", "--get", "user.name")
            email = self.git("config", "--default", "beancount-ui@localhost", "--get", "user.email")
            identity = {
                key: os.environ.get(key) or value
                for key, value in {
                    "GIT_AUTHOR_NAME": name,
                    "GIT_AUTHOR_EMAIL": email,
                    "GIT_COMMITTER_NAME": name,
                    "GIT_COMMITTER_EMAIL": email,
                }.items()
            }
            commit = self.git(
                "commit-tree", tree, "-p", plan["head"], "-m", plan["message"], env=identity
            )
            self.git("update-ref", f"refs/heads/{self.settings.branch}", commit, plan["head"])
            # Only reconcile the explicitly included paths in the user's index.
            self.git("reset", "--quiet", commit, "--", *plan["files"])
            return commit

    def backup(self, request: BackupInput):
        try:
            with self.writer.guard():
                remote = self.require_connected()
                self.require_resolved()
                plan, snap = self.plan()
                if plan["revision"] != request.revision or plan["head"] != request.head:
                    raise LedgerError("备份预览已过期，请重新预览")
                remote_head = self.fetch(remote)
                if self.check_remote(plan["head"], remote_head):
                    plan, snap = self.plan()
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
                    blocked=False,
                )
        except LedgerError as exc:
            with self.writer.lock:
                self.save(
                    message=f"备份失败：{exc}", error=str(exc), blocked=isinstance(exc, SyncBlocked)
                )
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
        snap = load_snapshot(files, self.ledger.entry)
        for name in include:
            if name not in files or name in snap.included or not re.fullmatch(r"[\w/.-]+", name):
                raise LedgerError("请选择未纳入 include 的账本文件")
        if include:
            entry = self.ledger.entry
            for name in sorted(set(include)):
                ensure_include(files, entry, name)
        return files, load_snapshot(files, self.ledger.entry)

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
                        original[self.ledger.entry].decode().splitlines(True),
                        files[self.ledger.entry].decode().splitlines(True),
                        fromfile=self.ledger.entry,
                        tofile=self.ledger.entry,
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
                atomic_write(self.root / self.ledger.entry, files[self.ledger.entry])
            self.save(
                connected=True,
                enabled=False,
                remote=remote,
                branch=self.settings.branch,
                remote_head=head,
                message="接入完成；自动备份关闭",
                last_success=None,
                synced_head=None,
                synced_revision=None,
                pending=False,
                blocked=False,
                error=None,
                observed=None,
                next_check=0,
                failures=0,
            )
        return self.status()

    def status(self):
        with self.writer.guard():
            state = self.state() | self.proxy() | {"github_auth": self.github_auth.status()}
            try:
                configured_remote = (
                    safe_remote(self.settings.remote) if self.settings.remote else ""
                )
            except GitFailure:
                configured_remote = ""
            if not (self.root / ".git").exists():
                return state | {
                    "repository": False,
                    "connected": False,
                    "enabled": False,
                    "remote": configured_remote,
                    "branch": self.settings.branch,
                    "changes": [],
                    "sync": "尚未接入 Git 仓库",
                    "error": "账本目录尚未建立 Git 仓库；空目录请先克隆，已有文件请接入完整仓库",
                }
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
                if not connected:
                    label = "仓库已就绪 · 待确认接入"
                if state.get("error"):
                    label += " · 备份失败"
                return state | {
                    "repository": True,
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
                    "repository": True,
                    "connected": False,
                    "enabled": False,
                    "branch": self.settings.branch,
                    "error": str(exc),
                    "changes": [],
                    "remote": configured_remote,
                    "sync": "仓库待检查",
                }
