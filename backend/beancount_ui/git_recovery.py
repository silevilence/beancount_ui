"""Durable fast-forward checkout, recovered before every application ledger access."""

import json
import os
import re
from pathlib import Path

from .ledger import LedgerError, digest, read_files
from .writer import atomic_write, decode, encode


def checkout_path(root, name):
    parts = name.split("/")
    if (
        not name
        or "\\" in name
        or ":" in name
        or Path(name).is_absolute()
        or any(
            p in {"", ".", ".."}
            or p.endswith((" ", "."))
            or p.casefold().rstrip(" .") == ".git"
            or re.fullmatch(r"git~\d+", p, re.IGNORECASE)
            for p in parts
        )
    ):
        raise LedgerError("远端文件路径不安全，请人工核对")
    path = root / name
    if not path.resolve().is_relative_to(root.resolve()):
        raise LedgerError("快进文件路径越界")
    return path


def tree(sync, ref):
    result = {}
    for item in sync.git("ls-tree", "-rz", ref).split("\0"):
        if not item:
            continue
        meta, name = item.split("\t", 1)
        checkout_path(sync.root, name)
        mode, kind, oid = meta.split()
        if kind != "blob" or mode not in {"100644", "100755"}:
            raise LedgerError("远端含符号链接或子模块，请人工核对")
        result[name] = {"mode": mode, "oid": oid}
    return result


def prepare(sync, head, target):
    before, after = tree(sync, head), tree(sync, target)
    changes = {}
    for name in sorted(before.keys() | after.keys()):
        if before.get(name) == after.get(name):
            continue
        path = checkout_path(sync.root, name)
        if name not in before and path.exists():
            raise LedgerError("远端新文件与本地忽略文件重名，请人工核对")
        if any(p.is_file() for p in path.parents if p != sync.root and p.is_relative_to(sync.root)):
            raise LedgerError("远端文件与目录布局冲突，请人工核对")
        content = path.read_bytes() if path.is_file() else None
        if name in before:
            expected = sync.git("cat-file", "blob", before[name]["oid"], binary=True)
            if content is None or content.replace(b"\r\n", b"\n") != expected.replace(
                b"\r\n", b"\n"
            ):
                raise LedgerError("本地存在未处理文件修改，请保留内容并人工核对")
        changes[name] = {
            "before": encode(content),
            "after": encode(sync.git("cat-file", "blob", after[name]["oid"], binary=True))
            if name in after
            else None,
            "mode": after.get(name, {}).get("mode"),
        }
    journal = {
        "head": head,
        "target": target,
        "branch": sync.settings.branch,
        "revision": digest(read_files(sync.root)),
        "changes": changes,
    }
    atomic_write(sync.writer.state / "fast-forward.json", json.dumps(journal).encode())
    recover(sync.writer)


def recover(writer):
    path = writer.state / "fast-forward.json"
    if not path.exists():
        return
    # Deferred import avoids a Writer / Sync construction cycle.
    from .sync import Sync

    sync = Sync(writer)
    journal = json.loads(path.read_text(encoding="utf-8"))
    head, target, branch = journal["head"], journal["target"], journal["branch"]
    expected_trees = (
        sync.git("rev-parse", f"{head}^{{tree}}"),
        sync.git("rev-parse", f"{target}^{{tree}}"),
    )

    def check_git():
        if sync.git("branch", "--show-current") != branch or sync.git("rev-parse", "HEAD") not in (
            head,
            target,
        ):
            raise LedgerError("快进恢复发现分支变化，请保留状态目录并人工核对")
        if sync.git("write-tree") not in expected_trees:
            raise LedgerError("快进恢复发现暂存区变化，请保留状态目录并人工核对")

    check_git()
    original = read_files(writer.root)
    # Inspect all participants before any replacement; preserve external editor changes.
    for name, change in journal["changes"].items():
        file = checkout_path(writer.root, name)
        live = file.read_bytes() if file.exists() else None
        before, after = decode(change["before"]), decode(change["after"])
        if live not in (before, after):
            raise LedgerError("快进恢复发现外部文件修改，请保留双方内容并人工核对")
        if file.suffix in {".bean", ".beancount"}:
            if before is None:
                original.pop(name, None)
            else:
                original[name] = before
    if digest(original) != journal["revision"]:
        raise LedgerError("快进恢复发现其他账本变化，请保留双方内容并人工核对")
    for name, change in journal["changes"].items():
        file = checkout_path(writer.root, name)
        after = decode(change["after"])
        live = file.read_bytes() if file.exists() else None
        if live not in (decode(change["before"]), after):
            raise LedgerError("快进替换前发现外部修改，请保留双方内容并人工核对")
        if after is None:
            file.unlink(missing_ok=True)
        else:
            atomic_write(file, after)
            if os.name != "nt":
                file.chmod(0o755 if change["mode"] == "100755" else 0o644)
    check_git()
    if sync.git("rev-parse", "HEAD") == head:
        sync.git("update-ref", f"refs/heads/{branch}", target, head)
    sync.git("read-tree", target)
    path.unlink()
    writer.ledger.latest = None
