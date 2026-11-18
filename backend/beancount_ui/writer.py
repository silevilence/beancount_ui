"""Durable preview/commit with idempotency, optimistic revisions and crash recovery."""

import base64
import difflib
import hashlib
import json
import os
import sqlite3
import tempfile
from contextlib import closing, contextmanager, nullcontext
from decimal import Decimal
from pathlib import Path

from beancount.core import data
from beancount.parser import parser
from filelock import FileLock

from .editing import basic_edit, locate, replace_record
from .fulfillment import committed, guard_edit, initialize, order_document
from .layout import insert_new, matches_business_file
from .layout_config import business_files, read_layout
from .ledger import Ledger, LedgerError, digest, load_snapshot, read_files
from .models import BatchMutation, Mutation
from .orders import guard_order_edit, order_raw, validate_order_totals
from .posting_form import render_form
from .query import transactions
from .record_template import current_day


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


class _ReplayBatch(Exception):
    """Validate prefixes individually when a grouped check needs item-level detail."""


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
            initialize(db)

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
        from .git_recovery import recover

        recover(self)
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
                committed(db, json.loads(request["result"]))
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
        # Preserve receipts created before template fields were introduced.
        omit = {
            key
            for key in ("values", "layout_version", "posting_entry", "claim_order", "claim_items")
            if getattr(mutation, key, None) is None
        }

        def excluded(item):
            result = {k: True for k in omit if getattr(item, k, None) is None}
            if item.order and not item.order.items:
                result["order"] = {"items": True}
            return result

        exclude = (
            {"items": {i: excluded(item) for i, item in enumerate(mutation.items)}}
            if isinstance(mutation, BatchMutation)
            else excluded(mutation)
        )
        fingerprint = hashlib.sha256(mutation.model_dump_json(exclude=exclude).encode()).hexdigest()
        request_id = str(mutation.request_id)
        with self.guard():
            with self.database() as db:
                existing = db.execute("SELECT * FROM requests WHERE id=?", (request_id,)).fetchone()
            if existing:
                if existing["fingerprint"] != fingerprint:
                    raise LedgerError("请求标识已用于不同内容，请创建新请求")
                return {**json.loads(existing["result"]), "status": existing["status"]}
            layout_state = read_layout(self.ledger.settings)
            layout_version = layout_state[2]
            write_day = current_day()
            snapshot = self.ledger.refresh()
            if snapshot.errors:
                raise LedgerError("账本存在错误，禁止写入")
            if mutation.revision != snapshot.revision:
                raise LedgerError("账本已变化，请重新加载并预览")
            try:
                prepared = self._prepare_preview(mutation, snapshot, layout_state, write_day)
            except _ReplayBatch:
                prepared = self._prepare_preview(
                    mutation, snapshot, layout_state, write_day, validate_each=True
                )
            candidate, targets, fulfillment, warnings, depends_on_today = prepared
            changes = {
                name: {"before": encode(snapshot.files.get(name)), "after": encode(content)}
                for name, content in candidate.files.items()
                if content != snapshot.files.get(name)
            }
            from .grocy import Grocy

            Grocy(self.state).validate_items(fulfillment)
            diffs = {
                name: "".join(
                    difflib.unified_diff(
                        (snapshot.files.get(name, b""))
                        .decode("utf-8-sig")
                        .splitlines(keepends=True),
                        candidate.files[name].decode("utf-8-sig").splitlines(keepends=True),
                        fromfile=name,
                        tofile=name,
                    )
                )
                for name in changes
            }
            result = {
                "write_day": str(write_day) if depends_on_today else None,
                "layout_version": layout_version,
                "request_id": request_id,
                "target": targets[-1]["target"],
                "items": targets,
                "warnings": warnings,
                "diffs": diffs,
                "revision": candidate.revision,
                "status": "preview",
                "fulfillment": fulfillment,
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
            self.ledger.previewed = (layout_version, candidate)
            return result

    def _prepare_preview(self, mutation, snapshot, layout_state, write_day, *, validate_each=False):
        layout, history, layout_version = layout_state
        known_files = business_files(history)
        request_id = str(mutation.request_id)
        depends_on_today = False
        files = dict(snapshot.files)
        targets = []
        fulfillment = []
        warnings = []
        items = mutation.items if isinstance(mutation, BatchMutation) else [mutation]
        validate_each = validate_each or len(items) == 1
        candidate = snapshot
        validated_count = 0
        # Backdated changes can affect a later pad/balance or lot booking, even if
        # offsetting entries would make the final ledger valid again.
        last_sensitive_date = None
        if not validate_each:
            last_sensitive_date = max(
                (
                    e.date
                    for e in snapshot.entries
                    if isinstance(e, data.Balance)
                    or (isinstance(e, data.Transaction) and any(p.cost for p in e.postings))
                ),
                default=None,
            )
        for index, item in enumerate(items, 1):
            try:
                operation = getattr(item, "operation", "create")
                kind = "ordinary"
                if item.order and operation != "create":
                    raise LedgerError("订单业务只能创建，请删除误录后重新关联")
                if (
                    operation != "delete"
                    and sum(
                        v is not None
                        for v in (
                            item.entry,
                            item.posting_entry,
                            item.raw,
                            item.order,
                            item.values,
                        )
                    )
                    != 1
                ):
                    raise LedgerError("必须选择基础表单或原文中的一种输入")
                if operation == "create":
                    if item.business not in layout.routes:
                        raise LedgerError("业务类型不存在，请重新加载业务配置")
                    route = layout.routes[item.business]
                    kind = layout.kind(item.business)
                    if item.layout_version is not None and item.layout_version != layout_version:
                        raise LedgerError("业务配置已变化，请重新打开表单核对字段")
                    if route.template:
                        if item.values is None:
                            raise LedgerError("该业务已配置记录模板，请使用业务模板表单填写")
                        if item.layout_version != layout_version:
                            raise LedgerError("业务配置已变化，请重新打开表单核对字段")
                        try:
                            raw = route.template.render(item.values, write_day)
                        except ValueError as exc:
                            raise LedgerError(str(exc)) from exc
                        depends_on_today |= any(
                            f.mode == "today" for f in route.template.fields.values()
                        )
                    elif item.values is not None:
                        raise LedgerError("该业务未启用记录模板，请重新加载表单")
                    if item.order and item.business != "ordinary":
                        raise LedgerError("订单业务必须使用普通月份路由")
                    raw = (
                        raw
                        if route.template
                        else (
                            order_raw(
                                item.order,
                                candidate,
                                f"{request_id}-{index}",
                                basic_raw,
                            )
                            if item.order
                            else render_form(item.posting_entry)
                            if item.posting_entry
                            else basic_raw(item.entry, kind)
                            if item.entry
                            else item.raw
                        )
                    )
                    directive = parse_single(raw, kind)
                    if not item.order and any(k.startswith("order-") for k in directive.meta):
                        raise LedgerError("order- 元数据由订单入口管理，请使用订单业务录入")
                    if kind == "yuebao" and any(
                        r["date"] == str(directive.date)
                        and matches_business_file(r["file"], known_files["yuebao"])
                        for r in transactions(candidate)
                    ):
                        raise LedgerError("该日期已有余额宝收益，请选择已有记录更正")
                    depends_on_today |= route.date_source == "write"
                    # Linking an existing, previously unreachable file can introduce
                    # directives that affect earlier transactions in this batch.
                    if not validate_each and any(
                        name in snapshot.files and name not in candidate.included
                        for name in layout.chain(item.business, directive.date, write_day)
                    ):
                        raise _ReplayBatch
                    target = insert_new(
                        files, item.business, directive.date, raw, layout, write_day
                    )
                else:
                    if item.values is not None:
                        raise LedgerError("历史记录请使用原位编辑，不重新套用业务模板")
                    row = locate(snapshot, item.transaction_id)
                    parse_single(row["raw"], "ordinary")
                    target = row["file"]
                    if operation == "delete":
                        raw = ""
                    else:
                        if item.posting_entry and not row["posting_form"]:
                            raise LedgerError("此记录请使用原文高级编辑")
                        raw = (
                            render_form(item.posting_entry, row["raw"])
                            if item.posting_entry
                            else basic_edit(row, item.entry, quote)
                            if item.entry
                            else item.raw
                        )
                        if not getattr(item, "claim_order", None):
                            parse_single(raw, "ordinary")
                    claim = getattr(item, "claim_order", None)
                    if claim:
                        from .orders import orders

                        source = next((r for r in orders(snapshot) if r["id"] == row["id"]), None)
                        if not source or operation != "edit":
                            raise LedgerError("只能明确认领未管理的历史消费")
                        with self.database() as db:
                            if db.execute(
                                "SELECT 1 FROM fulfillment_orders WHERE id=?", (source["key"],)
                            ).fetchone():
                                raise LedgerError("订单已经纳入收货管理")
                        if source["mode"] != "historical" and source["mode"] != claim:
                            raise LedgerError("历史账务与认领付款方式不一致")
                        head, body = row["raw"].split("\n", 1)
                        raw = (
                            head
                            + f"\n  order-id: {quote(source['key'])}"
                            + f"\n  order-action: {quote(claim)}\n"
                            + body
                        )
                        if source["identified"]:
                            raw = row["raw"]
                    else:
                        guard_order_edit(snapshot, row, raw)
                    with self.database() as db:
                        guard_edit(db, row, raw)
                    if raw:
                        edited = parse_single(raw, "ordinary")
                        metadata = {
                            k: str(v) for k, v in edited.meta.items() if k.startswith("order-")
                        }
                        if not claim and metadata != row["metadata"]:
                            raise LedgerError("不能修改订单关联元数据")
                    if matches_business_file(target, known_files["yuebao"]) and raw:
                        edited = parse_single(raw, "ordinary")
                        if any(
                            r["id"] != row["id"]
                            and matches_business_file(r["file"], known_files["yuebao"])
                            and r["date"] == str(edited.date)
                            for r in transactions(snapshot)
                        ):
                            raise LedgerError("更正日期已有余额宝收益，不能形成重复日期")
                    replace_record(files, row, raw)
                has_lots_or_price = False
                if raw and kind != "balance":
                    parsed = directive if operation == "create" else parse_single(raw, "ordinary")
                    has_lots_or_price = any(p.cost or p.price for p in parsed.postings)
                    if any(
                        isinstance(getattr(p.units, "number", None), Decimal)
                        and p.units.number == 0
                        for p in parsed.postings
                    ):
                        warnings.append(
                            f"第 {index} 笔含零金额分录，请确认；不会根据备注推算或补值。"
                        )
                targets.append({"item": index, "target": target, "raw": raw})
                if not validate_each and (
                    kind == "balance"
                    or has_lots_or_price
                    or (last_sensitive_date and directive.date <= last_sensitive_date)
                ):
                    raise _ReplayBatch
                next_item = items[index] if index < len(items) else None
                # Income and order actions read the accumulated state before insertion.
                # Purchases also need their validated source to build a fulfillment record.
                if (
                    not validate_each
                    and next_item
                    and not item.order
                    and not next_item.order
                    and next_item.business in layout.routes
                    and layout.kind(next_item.business) != "yuebao"
                ):
                    continue
                candidate = load_snapshot(dict(files), layout.entry)
                if any(t["target"] not in candidate.included for t in targets[validated_count:]):
                    raise LedgerError("目标文件未纳入入口，请检查 include 规则")
                # A later item may restore an existing dated balance assertion.
                # Structural/transaction errors remain attributable to this item;
                # balance assertions are authoritative on the final whole batch.
                errors = [
                    e
                    for e in candidate.errors
                    if index == len(items) or e.get("type") != "BalanceError"
                ]
                if errors:
                    message = "\n".join(f"{e['file']}:{e['line']} {e['message']}" for e in errors)
                    raise LedgerError(f"候选账本校验失败：\n{message}")
                validate_order_totals(candidate)
                if (item.order and item.order.purchase) or getattr(item, "claim_order", None):
                    from .orders import orders

                    key = f"{request_id}-{index}" if item.order else source["key"]
                    order_source = next(r for r in orders(candidate) if r["key"] == key)
                    fulfillment.append(
                        order_document(
                            order_source, item.order.items if item.order else item.claim_items
                        )
                    )
                validated_count = index
            except LedgerError as exc:
                if not validate_each and validated_count < index - 1:
                    raise _ReplayBatch from exc
                if isinstance(mutation, BatchMutation):
                    raise LedgerError(f"第 {index} 笔：{exc}") from exc
                raise
        return candidate, targets, fulfillment, warnings, depends_on_today

    def cancel_preview(self, request_id: str) -> dict:
        # guard completes any applying write first; never discard an unknown file write.
        with self.guard(), self.database() as db:
            request = db.execute("SELECT status FROM requests WHERE id=?", (request_id,)).fetchone()
            if not request:
                raise LedgerError("预览不存在，请先恢复原请求核对")
            if request["status"] == "done":
                return {"status": "done", "request_id": request_id}
            if request["status"] not in ("preview", "cancelled"):
                raise LedgerError("原写入尚未确认，不能结束请求")
            db.execute("UPDATE requests SET status='cancelled' WHERE id=?", (request_id,))
            return {"status": "cancelled", "request_id": request_id}

    def commit(self, request_id: str) -> dict:
        from .grocy import Grocy

        grocy = Grocy(self.state)
        with self.guard():
            with self.database() as db:
                request = db.execute("SELECT * FROM requests WHERE id=?", (request_id,)).fetchone()
            if not request:
                raise LedgerError("预览不存在，请重新预览")
            result = json.loads(request["result"])
            if request["status"] == "done":
                return {**result, "status": "done"}
            if request["status"] == "cancelled":
                raise LedgerError("此账务预览已明确取消，请重新预览")
            documents = result.get("fulfillment", [])
            linked = any(i["product_id"] for d in documents for i in d["items"])
            # Completed and ordinary saves never wait for the remote inventory lock.
            with grocy.lock if linked else nullcontext():
                write_day = result.get("write_day")
                if write_day and write_day != str(current_day()):
                    raise LedgerError("预览后已跨日，请取消旧预览并重新预览实际写入日期")
                expected_layout = result.get("layout_version", "default")
                layout, _, layout_version = read_layout(self.ledger.settings)
                if expected_layout != layout_version:
                    raise LedgerError("预览后布局已变化，请重新预览后保存（使用新的请求标识）")
                files = read_files(self.root)
                if digest(files) != request["revision"]:
                    raise LedgerError("预览后账本已被修改，请重新加载并预览")
                grocy.validate_items(documents, bind=True)
                with self.database() as db:
                    managed = db.execute("SELECT payload FROM fulfillment_orders").fetchall()
                if managed:
                    from .orders import orders

                    candidate = self.ledger.preview_for(result["revision"], layout_version)
                    if candidate is None:
                        files.update(
                            {
                                name: decode(change["after"])
                                for name, change in json.loads(request["changes"]).items()
                            }
                        )
                        candidate = load_snapshot(files, layout.entry)
                    candidates = {r["key"]: r for r in orders(candidate)}
                    current = {r["key"]: r for r in orders(self.ledger.refresh())}
                    for row in managed:
                        key = json.loads(row["payload"])["id"]
                        if current.get(key, {}).get("raw") != candidates.get(key, {}).get("raw"):
                            raise LedgerError("预览后订单已关联商品或收货，请在订单页显式处理")
                with self.database() as db:
                    db.execute("UPDATE requests SET status='applying' WHERE id=?", (request_id,))
                self.recover()
                return {**result, "status": "done"}
