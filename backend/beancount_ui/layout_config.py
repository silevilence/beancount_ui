"""Snapshot-bound layout activation, persisted separately from ledger contents."""

import difflib
import hashlib
import json
import re
from datetime import date

from pydantic import BaseModel, ConfigDict

from .layout import BUSINESSES, Layout, default_layout, ensure_include, validate_roles
from .ledger import LedgerError, digest, load_snapshot, read_files
from .record_template import current_day


class LayoutInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    layout: Layout
    day: date
    token: str = ""


def read_layout(settings):
    path = settings.state_dir / "layout.json"
    default = default_layout(settings.entry)
    if not path.exists():
        return default, [default], "default"
    try:
        content = path.read_bytes()
        state = json.loads(content)
        layout = Layout.model_validate(state["layout"])
        history = [Layout.model_validate(item) for item in state["history"]]
        if layout not in history or default not in history:
            raise ValueError("布局历史不完整")
        return layout, history, hashlib.sha256(content).hexdigest()
    except (ValueError, KeyError, TypeError) as exc:
        raise LedgerError("布局状态损坏，请从状态备份恢复 layout.json") from exc


def business_files(history):
    return {
        business: sorted(
            {
                route.target
                for layout in history
                for key, route in layout.routes.items()
                if layout.kind(key) == business
            }
        )
        for business in BUSINESSES
        if business != "ordinary"
    }


def configuration(writer):
    with writer.guard():
        layout, _, version = read_layout(writer.ledger.settings)
        return {
            "layout": layout.model_dump(),
            "default": default_layout().model_dump(),
            "version": version,
            "write_day": str(current_day()),
        }


def preview_locked(writer, request):
    settings = writer.ledger.settings
    active, history, version = read_layout(settings)
    proposed = request.layout
    for old in history:
        for business in set(old.routes) & set(proposed.routes):
            if old.kind(business) != proposed.kind(business):
                raise LedgerError("不能改变已有业务的记账语义，请创建新的业务类型")
    # A former business file must never become an index or another business's file.
    nodes = []
    for layout in [*history, proposed]:
        nodes.append((layout.entry, "index"))
        for business, route in layout.routes.items():
            nodes.extend((index, "index") for index in route.indexes)
            nodes.append((route.target, business))
    validate_roles(nodes, historical=True)
    files = read_files(writer.root)
    if proposed.entry not in files:
        raise LedgerError("入口文件必须已存在；请先创建入口并包含原有账本")
    current = load_snapshot(files, active.entry)
    candidate = load_snapshot(files, proposed.entry)
    if candidate.errors:
        raise LedgerError("新布局入口校验失败：" + candidate.errors[0]["message"])
    missing = set(current.included) - set(candidate.included)
    if any(
        re.sub(
            r'(?m)^\s*(?:include\s+"[^"\n]+"\s*)?(?:;[^\n]*)?$',
            "",
            files.get(name, b"").decode("utf-8-sig"),
        ).strip()
        for name in missing
    ):
        raise LedgerError("新入口必须包含全部历史账本数据，不能隐藏历史记录")
    routes = []
    write_day = current_day()
    for business in proposed.routes:
        chain = proposed.chain(business, request.day, write_day)
        routes.append({"business": business, "target": chain[-1], "chain": chain})
    # Validate generated includes on an isolated copy for the requested month and
    # a year boundary. No account/transaction data is synthesized or written.
    trial = dict(files)
    for day in {request.day, date(min(request.day.year + 1, 9999), 1, 1)}:
        for business in proposed.routes:
            chain = proposed.chain(business, day, write_day)
            for name in chain:
                path = writer.root / name
                if path.is_dir() or any(p.is_file() for p in path.parents if p != writer.root):
                    raise LedgerError(f"布局路径与现有文件或目录冲突：{name}")
                # Detect Windows aliases on all platforms before deploying there.
                if any(other.casefold() == name.casefold() and other != name for other in files):
                    raise LedgerError(f"布局路径大小写冲突：{name}")
                parent = writer.root
                for part in name.split("/"):
                    if parent.is_dir() and any(
                        p.name.casefold() == part.casefold() and p.name != part
                        for p in parent.iterdir()
                    ):
                        raise LedgerError(f"布局路径大小写冲突：{name}")
                    parent = parent / part
                trial.setdefault(name, b"; Created by layout preview\n")
            for parent, child in zip(chain, chain[1:], strict=False):
                ensure_include(trial, parent, child)
    checked = load_snapshot(trial, proposed.entry)
    if checked.errors:
        raise LedgerError("include 规则校验失败：" + checked.errors[0]["message"])
    if digest(read_files(writer.root)) != digest(files):
        raise LedgerError("预览期间账本已变化，请重新预览")
    diffs = {
        name: "".join(
            difflib.unified_diff(
                files.get(name, b"").decode("utf-8-sig").splitlines(True),
                content.decode("utf-8-sig").splitlines(True),
                fromfile=name,
                tofile=name,
            )
        )
        for name, content in trial.items()
        if files.get(name) != content
    }
    token = hashlib.sha256(
        json.dumps(
            [version, digest(files), proposed.model_dump(), str(request.day), str(write_day)],
            sort_keys=True,
        ).encode()
    ).hexdigest()
    return {
        "token": token,
        "routes": routes,
        "diffs": diffs,
        "entry": proposed.entry,
        "files": candidate.included,
        "write_day": str(write_day),
    }, history


def preview_layout(writer, request):
    with writer.guard():
        return preview_locked(writer, request)[0]


def activate_layout(writer, request):
    from .writer import atomic_write

    with writer.guard():
        result, history = preview_locked(writer, request)
        if request.token != result["token"]:
            raise LedgerError("布局或账本已变化，请重新预览布局后启用")
        if request.layout not in history:
            history.append(request.layout)
        state = {
            "layout": request.layout.model_dump(),
            "history": [item.model_dump() for item in history],
        }
        atomic_write(writer.state / "layout.json", json.dumps(state, ensure_ascii=False).encode())
        writer.ledger.latest = None
        writer.ledger.last_valid = None
        return {"layout": request.layout.model_dump(), "enabled": True}
