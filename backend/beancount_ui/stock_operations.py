"""A durable outbox. Once dispatch may have happened, retry means reconcile, not resend."""

import json
import time
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
                "UPDATE inventory_operations SET status=?,evidence=?,error=?,next_check=? WHERE id=?",
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
                        "UPDATE inventory_operations SET status='sending',attempts=attempts+1 WHERE id=?",
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
