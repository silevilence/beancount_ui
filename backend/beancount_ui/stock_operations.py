"""A durable outbox. Once dispatch may have happened, retry means reconcile, not resend."""

import json
import time
from collections import defaultdict
from decimal import Decimal
from threading import Event, Thread
from urllib.parse import quote, urlencode
from uuid import UUID, uuid5

from filelock import FileLock, Timeout

from .grocy import Grocy, GrocyError
from .ledger import LedgerError


def enqueue(db, document):
    identity = document["id"]
    existing = db.execute(
        "SELECT document FROM inventory_operations WHERE id=?", (identity,)
    ).fetchone()
    if existing:
        if json.loads(existing["document"]) != document:
            raise LedgerError("库存操作编号已用于不同内容")
        return identity
    db.execute(
        "INSERT INTO inventory_operations(id,receipt_id,document,status) VALUES (?,?,?,?)",
        (identity, document.get("receipt_id", ""), json.dumps(document), "pending"),
    )
    return identity


def receipt_operation(receipt_id, item, line, received_date):
    identity = str(uuid5(UUID(receipt_id), item["id"]))
    from decimal import Decimal

    return {
        "id": identity,
        "receipt_id": receipt_id,
        "instance_id": item["instance_id"],
        "product_id": item["product_id"],
        "action": "add",
        "item": item,
        "payload": {
            "amount": str(Decimal(line["quantity"]) * Decimal(item["factor"])),
            "price": item["unit_price"],
            "transaction_type": "purchase",
            "purchased_date": received_date,
            "best_before_date": line["best_before_date"],
            "location_id": line["location_id"],
            "note": "beancount-ui-receipt:" + identity,
        },
    }


class StockOperations:
    def __init__(self, writer):
        self.writer = writer
        self.grocy = Grocy(writer.state)

    def get(self, identity):
        with self.writer.database() as db:
            row = db.execute(
                "SELECT * FROM inventory_operations WHERE id=?", (identity,)
            ).fetchone()
        if not row:
            raise LedgerError("库存操作不存在")
        return json.loads(row["document"]) | {
            "status": row["status"],
            "evidence": json.loads(row["evidence"]),
            "error": row["error"],
            "attempts": row["attempts"],
            "next_check": row["next_check"],
        }

    def list(self):
        with self.writer.database() as db:
            ids = [
                r["id"]
                for r in db.execute("SELECT id FROM inventory_operations ORDER BY rowid DESC")
            ]
        return [self.get(identity) for identity in ids]

    def record(self, identity, status, evidence=None, error="", delay=0):
        with self.writer.database() as db:
            db.execute(
                "UPDATE inventory_operations SET status=?,evidence=?,error=?,next_check=? "
                "WHERE id=?",
                (status, json.dumps(evidence or {}), error, time.time() + delay, identity),
            )
        return self.get(identity)

    def operation_lock(self, identity):
        # Validate filenames, including when reached through an HTTP route.
        identity = str(UUID(identity))
        return FileLock(str(self.writer.state / f"stock-{identity}.lock"), timeout=0)

    def send(self, identity):
        try:
            with self.operation_lock(identity), self.grocy.lock:
                op = self.get(identity)
                if op["status"] not in ("pending", "failed"):
                    return op
                if op["status"] == "failed" and not op["evidence"].get("unsent"):
                    return op
                # Commit the dispatch boundary before entering the network library.
                with self.writer.database() as db:
                    db.execute(
                        "UPDATE inventory_operations SET status='sending',attempts=attempts+1 "
                        "WHERE id=?",
                        (identity,),
                    )
                try:
                    result = self.grocy.request(
                        f"stock/products/{op['product_id']}/{op['action']}",
                        "POST",
                        op["payload"],
                        instance_id=op["instance_id"],
                    )
                except GrocyError as exc:
                    return self.record(
                        identity,
                        "failed" if exc.unsent else "unknown",
                        {"unsent": exc.unsent},
                        str(exc),
                        15,
                    )
                except (OSError, ValueError):
                    return self.record(
                        identity, "unknown", error="请求中断，需核对远端日志", delay=15
                    )
                return self.record(
                    identity, "unknown", {"response": result}, "已收到响应，等待核对日志与批次"
                )
        except Timeout:
            return self.get(identity)

    def logs(self, key, value, instance_id):
        path = "objects/stock_log?" + urlencode({"query[]": f"{key}={value}"})
        result = self.grocy.request(path, instance_id=instance_id)
        if not isinstance(result, list) or any(not isinstance(r, dict) for r in result):
            raise GrocyError("invalid_response", "日志响应格式不兼容")
        return result

    def reconcile(self, identity):
        try:
            with self.operation_lock(identity), self.grocy.lock:
                return self._reconcile(self.get(identity))
        except Timeout:
            return self.get(identity)

    def _reconcile(self, op):
        identity, instance = op["id"], op["instance_id"]
        evidence = {"response": op["evidence"].get("response"), "checked_at": time.time()}
        checks = int(op["evidence"].get("checks", 0)) + 1
        evidence["checks"] = checks
        delay = min(900, 15 * 2 ** min(checks, 6))
        if op["status"] == "cancelled":
            return op
        try:
            if op["action"] != "add":
                return self.record(
                    identity,
                    "unknown",
                    evidence,
                    "此操作没有可可靠查询的客户端编号，请人工核对远端日志",
                    delay,
                )
            found = self.logs("note", op["payload"]["note"], instance)
            # Grocy propagates a stock note to subsequent consumes and transfers.
            matches = [
                r
                for r in found
                if r.get("transaction_type") == "purchase"
                and r.get("note") == op["payload"]["note"]
            ]
            evidence.update(lookup_complete=True, matches=matches)
            if not matches:
                return self.record(
                    identity,
                    "unknown",
                    evidence,
                    "暂未查到本次入库日志；原请求可能仍在执行，不会自动重发",
                    delay,
                )
            transactions = {str(r.get("transaction_id", "")) for r in matches}
            if len(transactions) != 1 or "" in transactions:
                return self.record(
                    identity, "conflict", evidence, "同一编号对应多个事务或事务标识缺失", delay
                )
            transaction = next(iter(transactions))
            full = self.grocy.request(
                "stock/transactions/" + quote(transaction, safe=""), instance_id=instance
            )
            evidence["transaction"] = full
            if not isinstance(full, list) or {str(r["id"]) for r in full} != {
                str(r["id"]) for r in matches
            }:
                return self.record(
                    identity, "conflict", evidence, "事务日志与操作编号查询不完整或不一致", delay
                )
            expected = op["payload"]
            for r in full:
                if (
                    str(r["product_id"]) != str(op["product_id"])
                    or r["transaction_type"] != "purchase"
                    or r.get("note") != expected["note"]
                    or Decimal(str(r["price"])) != Decimal(expected["price"])
                    or str(r["location_id"]) != str(expected["location_id"])
                    or str(r["best_before_date"])[:10] != expected["best_before_date"]
                    or str(r["purchased_date"])[:10] != expected["purchased_date"]
                ):
                    return self.record(
                        identity, "conflict", evidence, "产品、动作、单价、位置或日期不匹配", delay
                    )
            if sum(Decimal(str(r["amount"])) for r in full) != Decimal(expected["amount"]):
                return self.record(
                    identity, "conflict", evidence, "入库日志数量不完整，禁止整笔重发", delay
                )
            undone = [str(r.get("undone", "0")) in ("1", "True", "true") for r in full]
            if all(undone):
                return self.record(
                    identity, "undone", evidence, "本次入库已在 Grocy 撤销，不会自动重做"
                )
            if any(undone):
                return self.record(
                    identity, "conflict", evidence, "本次入库只有部分日志已撤销", delay
                )
            histories = {}
            for stock_id in {str(r["stock_id"]) for r in full}:
                histories[stock_id] = self.logs("stock_id", stock_id, instance)
            entries = self.grocy.request(
                f"stock/products/{op['product_id']}/entries", instance_id=instance
            )
            evidence.update(histories=histories, entries=entries)
            for stock_id, history in histories.items():
                required = {str(r["id"]) for r in full if str(r["stock_id"]) == stock_id}
                if not stock_id or not required.issubset({str(r["id"]) for r in history}):
                    return self.record(
                        identity, "conflict", evidence, "批次历史缺少原始入库日志", delay
                    )
                balances = defaultdict(Decimal)
                for row in history:
                    if str(row["stock_id"]) != stock_id:
                        raise ValueError("批次历史查询范围不一致")
                    if str(row.get("undone", "0")) in ("1", "True", "true"):
                        continue
                    kind = row["transaction_type"]
                    if str(row["product_id"]) != str(op["product_id"]):
                        raise ValueError("产品历史发生变化")
                    if kind == "product-opened":
                        continue
                    if kind not in (
                        "purchase",
                        "consume",
                        "inventory-correction",
                        "transfer_from",
                        "transfer_to",
                        "stock-edit-old",
                        "stock-edit-new",
                    ):
                        raise ValueError("无法解释的后续操作")
                    amount = Decimal(str(row["amount"]))
                    if kind == "stock-edit-old":
                        amount = -amount
                    balances[str(row["location_id"])] += amount
                actual = defaultdict(Decimal)
                for entry in entries:
                    if str(entry["stock_id"]) == stock_id:
                        actual[str(entry["location_id"])] += Decimal(str(entry["amount"]))
                if any(
                    abs(balances[k] - actual[k]) > Decimal("0.00000001")
                    for k in set(balances) | set(actual)
                ):
                    return self.record(
                        identity,
                        "conflict",
                        evidence,
                        "日志与当前批次数量尚不一致，可能部分执行或并发变化",
                        delay,
                    )
                if self.logs("stock_id", stock_id, instance) != history:
                    return self.record(
                        identity, "unknown", evidence, "核对期间日志发生变化，稍后复查", delay
                    )
            return self.record(identity, "success", evidence)
        except GrocyError as exc:
            return self.record(identity, "unknown", evidence, str(exc), delay)
        except (KeyError, TypeError, ValueError, ArithmeticError):
            return self.record(
                identity, "conflict", evidence, "日志或批次字段不完整，需人工核对", delay
            )

    def manual_retry(self, identity, reason, original_stopped, no_effect):
        if not original_stopped or not no_effect or len(reason.strip()) < 10:
            raise LedgerError("需说明核对依据，并确认原执行已停止且未产生写入")
        try:
            with self.operation_lock(identity), self.grocy.lock:
                op = self._reconcile(self.get(identity))
                if (
                    op["status"] != "unknown"
                    or not op["evidence"].get("lookup_complete")
                    or op["evidence"].get("matches")
                ):
                    raise LedgerError("最新核对不能排除已执行，禁止重发；请在 Grocy 人工处理")
                with self.writer.database() as db:
                    db.execute(
                        "INSERT INTO inventory_audit VALUES (?,?,?)",
                        (identity, json.dumps({"manual_retry_reason": reason}), time.time()),
                    )
                self.record(identity, "pending", error="人工确认原执行已停止且无副作用，沿用原编号")
        except Timeout as exc:
            raise LedgerError("该库存操作正在处理，请稍后核对") from exc
        return self.send(identity)

    def tick(self):
        for op in self.list():
            if op["next_check"] > time.time():
                continue
            if op["status"] in ("sending", "unknown", "conflict"):
                self.reconcile(op["id"])
            elif op["status"] == "failed" and op["evidence"].get("unsent") and op["attempts"] < 3:
                result = self.send(op["id"])
                if result["status"] == "unknown":
                    self.reconcile(op["id"])


class StockReconciler:
    def __init__(self, writer):
        self.operations = StockOperations(writer)
        self.stop_event = Event()
        self.thread = Thread(target=self.run, daemon=True, name="grocy-reconcile")

    def start(self):
        # A restored backup may precede a dispatch. Never replay pending historical rows.
        with self.operations.writer.database() as db:
            db.execute(
                "UPDATE inventory_operations SET status='unknown',next_check=0 "
                "WHERE status IN ('pending','sending','failed')"
            )
        self.thread.start()

    def run(self):
        while not self.stop_event.wait(15):
            try:
                self.operations.tick()
            except (OSError, ValueError, Timeout):
                # Preserve every operation; the next tick or UI check can recover it.
                continue

    def stop(self):
        self.stop_event.set()
        self.thread.join(timeout=2)
