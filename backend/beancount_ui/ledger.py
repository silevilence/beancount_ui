"""Read immutable snapshots; never let Beancount caches touch the source ledger."""

import hashlib
import json
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import beancount
from beancount import loader
from beancount.core import data
from beancount.parser import parser

from .config import Settings

loader.initialize(use_cache=False)


class LedgerError(ValueError):
    pass


def digest(files: dict[str, bytes]) -> str:
    value = [(name, hashlib.sha256(content).hexdigest()) for name, content in sorted(files.items())]
    return hashlib.sha256(json.dumps(value).encode()).hexdigest()


def read_files(root: Path) -> dict[str, bytes]:
    if not root.is_dir():
        raise LedgerError("账本目录不存在")
    result = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if ".git" in relative.parts:
            continue
        if path.is_symlink() or path.is_junction():
            raise LedgerError(f"账本不支持符号链接或目录联接：{relative.as_posix()}")
        if path.is_file() and path.suffix in {".bean", ".beancount"}:
            result[relative.as_posix()] = path.read_bytes()
    return result


def git_info(root: Path) -> dict:
    def run(*args):
        result = subprocess.run(
            ["git", "-C", str(root), *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
        return result.stdout.strip() if result.returncode == 0 else None

    try:
        top = run("rev-parse", "--show-toplevel")
        if top is None or Path(top).resolve() != root.resolve():
            return {"repository": False, "sync": "未配置 Git 同步"}
        dirty = run("status", "--porcelain=v1", "--untracked-files=all")
        upstream = run("rev-parse", "--abbrev-ref", "@{upstream}")
        ahead = run("rev-list", "--count", "@{upstream}..HEAD") if upstream else None
        return {
            "repository": True,
            "branch": run("branch", "--show-current"),
            "commit": run("rev-parse", "HEAD"),
            "changes": (dirty or "").splitlines(),
            "upstream": upstream,
            "ahead": int(ahead) if ahead else None,
            "sync": "待提交" if dirty else "已提交（远端状态未核验）",
        }
    except (OSError, subprocess.TimeoutExpired):
        return {"repository": False, "sync": "Git 状态读取失败"}


def default_business_files():
    from .layout import default_layout

    return {b: [route.target] for b, route in default_layout().routes.items() if b != "ordinary"}


@dataclass
class Snapshot:
    files: dict[str, bytes]
    revision: str
    entries: list
    errors: list[dict]
    included: list[str]
    edges: dict[str, list[str]]
    records: list[dict] | None = None
    business_files: dict[str, list[str]] = field(default_factory=default_business_files)


def load_snapshot(files: dict[str, bytes], entry: str = "main.beancount") -> Snapshot:
    """Validate in isolation, including routing candidates with new include files."""
    errors = []
    edges = {}
    with tempfile.TemporaryDirectory(prefix="beancount-ui-") as folder:
        root = Path(folder)
        for name, content in files.items():
            path = root / name
            if not path.resolve().is_relative_to(root.resolve()):
                raise LedgerError("账本文件路径越界")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        pending, visited = [entry], set()
        while pending:
            name = pending.pop()
            if name in visited:
                continue
            visited.add(name)
            if name not in files:
                errors.append({"file": name, "line": 0, "message": "include 文件不存在"})
                continue
            _, _, options = parser.parse_file(str(root / name))
            if options.get("plugin"):
                errors.append({"file": name, "line": 0, "message": "自定义 plugin 尚不支持"})
            children = []
            for include in options.get("include", []):
                candidate = (root / name).parent / include
                # Beancount supports globs; resolve them before loading outside the sandbox.
                if candidate.is_absolute() and not candidate.resolve().is_relative_to(
                    root.resolve()
                ):
                    errors.append({"file": name, "line": 0, "message": "include 不得越出账本目录"})
                    continue
                pattern = candidate.resolve().relative_to(root.resolve()).as_posix()
                matches = list(root.glob(pattern))
                children.extend(p.relative_to(root).as_posix() for p in matches)
                if not matches:
                    errors.append(
                        {"file": name, "line": 0, "message": f"include 未匹配：{include}"}
                    )
            edges[name] = sorted(children)
            pending.extend(children)
        visited, visiting = set(), set()

        def visit(name):
            if name in visiting:
                errors.append({"file": name, "line": 0, "message": "include 存在循环"})
                return
            if name in visited:
                return
            visited.add(name)
            visiting.add(name)
            for child in edges.get(name, []):
                visit(child)
            visiting.remove(name)

        visit(entry)
        entries = []
        included = sorted(visited)
        if not errors:
            entries, load_errors, options = loader.load_file(str(root / entry))
            included = sorted(Path(p).relative_to(root).as_posix() for p in options["include"])
            for error in load_errors:
                source = error.source or {}
                filename = source.get("filename", str(root / entry))
                source_path = Path(filename).resolve()
                errors.append(
                    {
                        "file": source_path.relative_to(root).as_posix()
                        if source_path.is_relative_to(root)
                        else entry,
                        "line": source.get("lineno", 0),
                        "type": type(error).__name__,
                        "message": error.message.replace(str(root), "."),
                    }
                )
            for directive in entries:
                if directive.meta and directive.meta.get("filename"):
                    directive.meta["filename"] = (
                        Path(directive.meta["filename"]).resolve().relative_to(root).as_posix()
                    )
    return Snapshot(files, digest(files), entries, errors, included, edges)


class Ledger:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.latest: Snapshot | None = None
        self.last_valid: Snapshot | None = None
        self.layout_version: str | None = None

    @property
    def entry(self):
        from .layout_config import read_layout

        return read_layout(self.settings)[0].entry

    def refresh(self) -> Snapshot:
        from .layout_config import business_files, read_layout

        layout, history, version = read_layout(self.settings)
        if version != self.layout_version:
            self.latest = self.last_valid = None
            self.layout_version = version
        files = read_files(self.settings.ledger_dir)
        if self.latest is None or digest(files) != self.latest.revision:
            self.latest = load_snapshot(files, layout.entry)
            self.latest.business_files = business_files(history)
            # A writer outside this process must not turn a mixed snapshot into a valid view.
            if digest(read_files(self.settings.ledger_dir)) != self.latest.revision:
                self.latest = None
                raise LedgerError("读取期间账本发生变化，请重试")
            if not self.latest.errors:
                self.last_valid = self.latest
        return self.latest

    def status(self) -> dict:
        snap = self.refresh()
        return {
            "entry": self.entry,
            "version": beancount.__version__,
            "revision": snap.revision,
            "writable": not snap.errors,
            "errors": snap.errors,
            "files": snap.included,
            "include_graph": snap.edges,
            "unreferenced": sorted(set(snap.files) - set(snap.included)),
            "entry_count": len(snap.entries),
            "git": git_info(self.settings.ledger_dir),
            "accounts": sorted({e.account for e in snap.entries if isinstance(e, data.Open)}),
        }
