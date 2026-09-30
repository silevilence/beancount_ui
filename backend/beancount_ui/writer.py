"""Durable preview/commit with idempotency, optimistic revisions and crash recovery."""

import base64
import difflib
import hashlib
import json
import os
import sqlite3
import tempfile
from contextlib import closing, contextmanager
from decimal import Decimal
from pathlib import Path

from beancount.core import data
from beancount.parser import parser
from filelock import FileLock

from .editing import basic_edit, locate, replace_record
from .layout import insert_new
from .ledger import Ledger, LedgerError, digest, load_snapshot, read_files
from .models import BatchMutation, Mutation
from .orders import guard_order_edit, order_raw, validate_order_totals
from .query import transactions


def quote(text: str) -> str:
    # Beancount's lexer uses JSON-compatible string escapes.
    return json.dumps(text, ensure_ascii=False)


def basic_raw(entry, business="ordinary") -> str:
    result = f"{entry.date} * {quote(entry.payee)} {quote(entry.narration)}\n"
    if entry.note:
        result += f"  memo: {quote(entry.note)}\n"
    if entry.splits:
        if business not in ("ordinary", "phone"):
            raise LedgerError("仅消费业务支持支出明细")
        if sum(p.amount for p in entry.splits) != entry.amount:
            raise LedgerError("商品与折扣合计必须等于实付金额")
        for posting in entry.splits:
            result += f"  {posting.category} {posting.amount:f} {entry.currency}\n"
            if posting.note:
                result += f"    memo: {quote(posting.note)}\n"
        return result + f"  {entry.payment} {-entry.amount:f} {entry.currency}\n"
    if business in ("salary", "yuebao"):
        if not entry.category.startswith("Income:") or not entry.payment.startswith("Assets:"):
            raise LedgerError("收入模板需要收入账户和资产到账账户")
        return result + f"  {entry.payment} {entry.amount:f} {entry.currency}\n  {entry.category}\n"
    if not entry.category.startswith("Expenses:"):
        raise LedgerError("消费模板需要费用分类")
    result += f"  {entry.category} {entry.amount:f} {entry.currency}\n"
    result += f"  {entry.payment} {-entry.amount:f} {entry.currency}\n"
    return result


def parse_single(raw: str, business: str):
    entries, errors, options = parser.parse_string(raw)
    allowed = data.Balance if business == "balance" else data.Transaction
    if (
        errors
        or len(entries) != 1
        or not isinstance(entries[0], allowed)
        or options.get("include")
        or options.get("plugin")
        or any(
            line
            and not line[0].isspace()
            and not line.startswith((";", "*"))
            and not line[:4].isdigit()
            for line in raw.splitlines()
        )
    ):
        raise LedgerError("仅允许一条完整交易（余额业务仅允许一条 balance），不允许附加指令")
    return entries[0]


def encode(content: bytes | None):
    return base64.b64encode(content).decode("ascii") if content is not None else None


def decode(content: str | None):
    return base64.b64decode(content) if content is not None else None


def atomic_write(path: Path, content: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".bean-ui-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Writer:
    def __init__(self, ledger: Ledger):
        self.ledger = ledger
        self.root = ledger.settings.ledger_dir
        self.state = ledger.settings.state_dir
        self.state.mkdir(parents=True, exist_ok=True)
        identity = hashlib.sha256(str(self.root.resolve()).casefold().encode()).hexdigest()
        self.lock = FileLock(
            str(Path(tempfile.gettempdir()) / f"beancount-ui-{identity}.lock"), timeout=10
        )
        self.db_path = self.state / "writes.sqlite3"
        with self.lock, self.database() as db:
            db.execute("CREATE TABLE IF NOT EXISTS identity (root TEXT NOT NULL)")
            row = db.execute("SELECT root FROM identity").fetchone()
            if row and row[0] != str(self.root.resolve()):
                raise LedgerError("状态目录已经用于其他账本")
            if not row:
                db.execute("INSERT INTO identity VALUES (?)", (str(self.root.resolve()),))
            db.execute("""CREATE TABLE IF NOT EXISTS requests (
                id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, revision TEXT NOT NULL,
                changes TEXT NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL)""")

    @contextmanager
    def database(self):
        with closing(sqlite3.connect(self.db_path)) as db, db:
            db.execute("PRAGMA synchronous=FULL")
            db.row_factory = sqlite3.Row
            yield db

    @contextmanager
    def guard(self):
        with self.lock:
            self.recover()
            yield

    def recover(self):
        with self.database() as db:
            pending = db.execute("SELECT * FROM requests WHERE status='applying'").fetchall()
        for request in pending:
            changes = json.loads(request["changes"])
            merged = read_files(self.root)
            merged.update({name: decode(change["after"]) for name, change in changes.items()})
            if digest(merged) != json.loads(request["result"])["revision"]:
                raise LedgerError("中断恢复发现其他账本文件变化，请保留状态目录并人工核对")
            # Inspect every participant before changing anything, preserving external work.
            for name, change in changes.items():
                path = self.root / name
                live = path.read_bytes() if path.exists() else None
                if live not in (decode(change["before"]), decode(change["after"])):
                    raise LedgerError(f"中断恢复发现外部修改：{name}；请保留状态目录并人工核对")
            for name, change in changes.items():
                self.write_part(name, decode(change["before"]), decode(change["after"]))
            with self.database() as db:
                db.execute("UPDATE requests SET status='done' WHERE id=?", (request["id"],))
            self.ledger.latest = None

    def write_part(self, name: str, before: bytes | None, after: bytes):
        path = self.root / name
        if not path.resolve().is_relative_to(self.root.resolve()):
            raise LedgerError("写入目标越界")
        live = path.read_bytes() if path.exists() else None
        if live == after:
            return
        if live != before:
            raise LedgerError(f"文件已被外部修改：{name}，请重新加载")
        atomic_write(path, after)

    def preview(self, mutation: Mutation | BatchMutation) -> dict:
        fingerprint = hashlib.sha256(mutation.model_dump_json().encode()).hexdigest()
        request_id = str(mutation.request_id)
        with self.guard():
            with self.database() as db:
                existing = db.execute("SELECT * FROM requests WHERE id=?", (request_id,)).fetchone()
            if existing:
                if existing["fingerprint"] != fingerprint:
                    raise LedgerError("请求标识已用于不同内容，请创建新请求")
                return {**json.loads(existing["result"]), "status": existing["status"]}
            snapshot = self.ledger.refresh()
            if snapshot.errors:
                raise LedgerError("账本存在错误，禁止写入")
            if mutation.revision != snapshot.revision:
                raise LedgerError("账本已变化，请重新加载并预览")
            files = dict(snapshot.files)
            targets = []
            warnings = []
            items = mutation.items if isinstance(mutation, BatchMutation) else [mutation]
            for index, item in enumerate(items, 1):
                try:
                    operation = getattr(item, "operation", "create")
                    if item.order and operation != "create":
                        raise LedgerError("订单业务只能创建，请删除误录后重新关联")
                    if (
                        operation != "delete"
                        and sum(v is not None for v in (item.entry, item.raw, item.order)) != 1
                    ):
                        raise LedgerError("必须选择基础表单或原文中的一种输入")
                    if operation == "create":
                        if item.order and item.business != "ordinary":
                            raise LedgerError("订单业务必须使用普通月份路由")
                        raw = (
                            order_raw(
                                item.order, load_snapshot(files), f"{request_id}-{index}", basic_raw
                            )
                            if item.order
                            else basic_raw(item.entry, item.business)
                            if item.entry
                            else item.raw
                        )
                        directive = parse_single(raw, item.business)
                        if not item.order and any(k.startswith("order-") for k in directive.meta):
                            raise LedgerError("order- 元数据由订单入口管理，请使用订单业务录入")
                        if item.business == "yuebao" and any(
                            r["file"] == "txs/category/yuebao.bean"
                            and r["date"] == str(directive.date)
                            for r in transactions(load_snapshot(files))
                        ):
                            raise LedgerError("该日期已有余额宝收益，请选择已有记录更正")
                        target = insert_new(files, item.business, directive.date, raw)
                    else:
                        row = locate(snapshot, item.transaction_id)
                        parse_single(row["raw"], "ordinary")
                        target = row["file"]
                        if operation == "delete":
                            raw = ""
                        else:
                            raw = basic_edit(row, item.entry, quote) if item.entry else item.raw
                            parse_single(raw, "ordinary")
                        guard_order_edit(snapshot, row, raw)
                        if raw:
                            edited = parse_single(raw, "ordinary")
                            metadata = {
                                k: str(v) for k, v in edited.meta.items() if k.startswith("order-")
                            }
                            if metadata != row["metadata"]:
                                raise LedgerError("不能修改订单关联元数据")
                        if target == "txs/category/yuebao.bean" and raw:
                            edited = parse_single(raw, "ordinary")
                            if any(
                                r["id"] != row["id"]
                                and r["file"] == target
                                and r["date"] == str(edited.date)
                                for r in transactions(snapshot)
                            ):
                                raise LedgerError("更正日期已有余额宝收益，不能形成重复日期")
                        replace_record(files, row, raw)
                    if raw and item.business != "balance":
                        parsed = parse_single(raw, "ordinary")
                        if any(
                            isinstance(getattr(p.units, "number", None), Decimal)
                            and p.units.number == 0
                            for p in parsed.postings
                        ):
                            warnings.append(
                                f"第 {index} 笔含零金额分录，请确认；不会根据备注推算或补值。"
                            )
                    candidate = load_snapshot(files)
                    # A later item may restore an existing dated balance assertion.
                    # Structural/transaction errors remain attributable to this item;
                    # balance assertions are authoritative on the final whole batch.
                    errors = [
                        e
                        for e in candidate.errors
                        if index == len(items) or e.get("type") != "BalanceError"
                    ]
                    if errors:
                        message = "\n".join(
                            f"{e['file']}:{e['line']} {e['message']}" for e in errors
                        )
                        raise LedgerError(f"候选账本校验失败：\n{message}")
                    validate_order_totals(candidate)
                    targets.append({"item": index, "target": target, "raw": raw})
                except LedgerError as exc:
                    if isinstance(mutation, BatchMutation):
                        raise LedgerError(f"第 {index} 笔：{exc}") from exc
                    raise
            changes = {
                name: {"before": encode(snapshot.files.get(name)), "after": encode(content)}
                for name, content in files.items()
                if content != snapshot.files.get(name)
            }
            diffs = {
                name: "".join(
                    difflib.unified_diff(
                        (snapshot.files.get(name, b""))
                        .decode("utf-8-sig")
                        .splitlines(keepends=True),
                        files[name].decode("utf-8-sig").splitlines(keepends=True),
                        fromfile=name,
                        tofile=name,
                    )
                )
                for name in changes
            }
            result = {
                "request_id": request_id,
                "target": target,
                "items": targets,
                "warnings": warnings,
                "diffs": diffs,
                "revision": candidate.revision,
                "status": "preview",
            }
            with self.database() as db:
                db.execute(
                    "INSERT INTO requests VALUES (?,?,?,?,?,?)",
                    (
                        request_id,
                        fingerprint,
                        snapshot.revision,
                        json.dumps(changes),
                        "preview",
                        json.dumps(result),
                    ),
                )
            return result

    def commit(self, request_id: str) -> dict:
        with self.guard():
            with self.database() as db:
                request = db.execute("SELECT * FROM requests WHERE id=?", (request_id,)).fetchone()
            if not request:
                raise LedgerError("预览不存在，请重新预览")
            if request["status"] == "done":
                return {**json.loads(request["result"]), "status": "done"}
            if digest(read_files(self.root)) != request["revision"]:
                raise LedgerError("预览后账本已被修改，请重新加载并预览")
            with self.database() as db:
                db.execute("UPDATE requests SET status='applying' WHERE id=?", (request_id,))
            self.recover()
            return {**json.loads(request["result"]), "status": "done"}
