"""Durable order items and physical receipt history in the writer's state database."""

import json
from decimal import Decimal
from uuid import NAMESPACE_URL, uuid5

from .fulfillment_models import ItemInput, ReceiptInput
from .ledger import LedgerError
from .orders import orders


def initialize(db):
    db.execute("CREATE TABLE IF NOT EXISTS fulfillment_orders (id TEXT PRIMARY KEY, payload TEXT)")
    db.execute(
        "CREATE TABLE IF NOT EXISTS order_corrections "
        "(id TEXT PRIMARY KEY, order_id TEXT, request TEXT, result TEXT)"
    )
    db.execute(
        "CREATE TABLE IF NOT EXISTS receipt_previews "
        "(id TEXT PRIMARY KEY, request TEXT, prepared TEXT, result TEXT)"
    )
    db.execute("""CREATE TABLE IF NOT EXISTS receipts (
        id TEXT PRIMARY KEY, order_id TEXT NOT NULL, payload TEXT NOT NULL)""")
    db.execute("""CREATE TABLE IF NOT EXISTS inventory_operations (
        id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, document TEXT NOT NULL,
        status TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '{}',
        error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
        next_check REAL NOT NULL DEFAULT 0)""")
    db.execute(
        "CREATE TABLE IF NOT EXISTS inventory_audit (operation_id TEXT, event TEXT, at REAL)"
    )


def committed(db, result):
    for order in result.get("fulfillment", []):
        db.execute(
            "INSERT OR IGNORE INTO fulfillment_orders VALUES (?,?)",
            (order["id"], json.dumps(order)),
        )


def order_document(source, items):
    identity = source["key"]
    if not items:
        items = [
            ItemInput(
                id=uuid5(NAMESPACE_URL, identity),
                name=source["narration"] or "购买商品",
                quantity="1",
            )
        ]
    if len({str(i.id) for i in items}) != len(items):
        raise LedgerError("商品明细编号重复")
    return {
        "id": identity,
        "source": source,
        "items": [i.model_dump(mode="json") for i in items],
        "cancelled": {},
    }


def guard_edit(db, row, raw):
    key = row["metadata"].get("order-id", row["id"])
    if (
        raw != row["raw"]
        and db.execute("SELECT 1 FROM fulfillment_orders WHERE id=?", (key,)).fetchone()
    ):
        raise LedgerError("订单已关联商品或收货，请在订单页显式处理；不能直接更正或删除原记录")


class Fulfillment:
    def __init__(self, writer):
        self.writer = writer

    def list(self):
        with self.writer.guard(), self.writer.database() as db:
            snapshot = self.writer.ledger.refresh()
            current = {r["key"]: r for r in orders(snapshot)} if not snapshot.errors else {}
            result = []
            for row in db.execute("SELECT * FROM fulfillment_orders ORDER BY rowid DESC"):
                doc = json.loads(row["payload"])
                live = current.get(doc["id"])
                receipts = [
                    json.loads(r["payload"])
                    for r in db.execute(
                        "SELECT * FROM receipts WHERE order_id=? ORDER BY rowid", (doc["id"],)
                    )
                ]
                items = []
                for item in doc["items"]:
                    received = sum(
                        (
                            Decimal(line["quantity"])
                            for receipt in receipts
                            for line in receipt["lines"]
                            if line["item_id"] == item["id"] and not receipt.get("voided")
                        ),
                        Decimal(0),
                    )
                    cancelled = Decimal(doc["cancelled"].get(item["id"], "0"))
                    items.append(
                        item
                        | {
                            "received": str(received),
                            "cancelled": str(cancelled),
                            "remaining": str(Decimal(item["quantity"]) - received - cancelled),
                        }
                    )
                remaining = sum(Decimal(i["remaining"]) for i in items)
                received = sum(Decimal(i["received"]) for i in items)
                cancelled = sum(Decimal(i["cancelled"]) for i in items)
                state = (
                    ("partial" if received else "pending")
                    if remaining
                    else ("cancelled" if cancelled and not received else "received")
                )
                source = live or doc["source"]
                operations = [
                    {
                        "id": o["id"],
                        "status": o["status"],
                        "error": o["error"],
                        "evidence": json.loads(o["evidence"]),
                    }
                    for o in db.execute(
                        "SELECT o.* FROM inventory_operations o "
                        "JOIN receipts r ON o.receipt_id=r.id "
                        "WHERE r.order_id=?",
                        (doc["id"],),
                    )
                ]
                payment = (
                    "paid"
                    if source["mode"] == "paid" or Decimal(source["unpaid"]) == 0
                    else ("partial" if Decimal(source["settled"]) else "unpaid")
                )
                result.append(
                    doc
                    | {
                        "source": source,
                        "items": items,
                        "receipts": receipts,
                        "receipt_state": state,
                        "payment_state": payment,
                        "source_changed": not live or live["raw"] != doc["source"]["raw"],
                        "operations": operations,
                        "corrections": [
                            json.loads(r["request"])
                            for r in db.execute(
                                "SELECT request FROM order_corrections WHERE order_id=?",
                                (doc["id"],),
                            )
                        ],
                    }
                )
            return result

    def receive(self, request: ReceiptInput, *, prepared=False, recovery_required=False):
        with self.writer.guard(), self.writer.database() as db:
            identity = str(request.request_id)
            payload = request.model_dump(mode="json")
            previous = db.execute("SELECT payload FROM receipts WHERE id=?", (identity,)).fetchone()
            if previous:
                existing = json.loads(previous["payload"])
                if any(existing.get(k) != v for k, v in payload.items()):
                    raise LedgerError("收货编号已用于不同内容")
                return existing
            doc = next((o for o in self.list() if o["id"] == request.order_id), None)
            if not doc or doc["source_changed"]:
                raise LedgerError("原订单已变化或不存在，请先核对原记录")
            if str(request.received_date) < doc["source"]["date"]:
                raise LedgerError("实物收货日期不能早于购买日期")
            if len({line.item_id for line in request.lines}) != len(request.lines):
                raise LedgerError("同次收货不能重复选择商品")
            for line in request.lines:
                item = next((i for i in doc["items"] if i["id"] == str(line.item_id)), None)
                if not item or line.quantity > Decimal(item["remaining"]):
                    raise LedgerError("收货数量超过剩余待收数量")
                if item["product_id"]:
                    if not prepared:
                        raise LedgerError("关联商品需通过核对后的入库流程收货")
                    from .stock_operations import enqueue, receipt_operation

                    stock_item = item | {"unit_price": str(line.unit_price)}
                    enqueue(
                        db,
                        receipt_operation(
                            identity,
                            stock_item,
                            line.model_dump(mode="json"),
                            str(request.received_date),
                        ),
                        status="unknown" if recovery_required else "pending",
                    )
            payload["item_snapshots"] = {
                item["id"]: item
                for item in doc["items"]
                if any(str(line.item_id) == item["id"] for line in request.lines)
            }
            db.execute(
                "INSERT INTO receipts VALUES (?,?,?)",
                (identity, request.order_id, json.dumps(payload)),
            )
            return payload

    def bindings(self):
        """Explain the conservative instance lock without changing historical links."""
        from .grocy import Grocy
        from .stock_operations import SETTLED_STATUSES, StockOperations

        with self.writer.guard():
            instance = Grocy(self.writer.state).read()["instance_id"]
            linked = [
                {
                    "order_id": o["id"],
                    "item_id": i["id"],
                    "name": i["name"],
                    "product_id": i["product_id"],
                }
                for o in self.list()
                for i in o["items"]
                if i["product_id"] and i["instance_id"] == instance
            ]
            operations = [
                {
                    "id": o["id"],
                    "product_id": o["product_id"],
                    "status": o["status"],
                    "needs_review": o["status"] not in SETTLED_STATUSES,
                }
                for o in StockOperations(self.writer).list()
                if o["instance_id"] == instance
            ]
            return {
                "locked": (self.writer.state / "grocy-bindings.locked").exists(),
                "items": linked,
                "operations": operations,
            }

    def purchase_quantities(self, instance_id):
        from .stock_operations import SETTLED_STATUSES, StockOperations

        result = {}
        operations = StockOperations(self.writer).list()
        for order in self.list():
            if order["source_changed"]:
                continue
            for item in order["items"]:
                if not item["product_id"] or item["instance_id"] != instance_id:
                    continue
                key = str(item["product_id"])
                line = result.setdefault(
                    key, {"pending": Decimal(0), "received_unsynced": Decimal(0), "order_ids": []}
                )
                line["pending"] += Decimal(item["remaining"]) * Decimal(item["factor"])
                if order["id"] not in line["order_ids"]:
                    line["order_ids"].append(order["id"])
            receipts = {r["request_id"] for r in order["receipts"] if not r.get("voided")}
            for op in operations:
                key = str(op["product_id"])
                if (
                    op["receipt_id"] in receipts
                    and key in result
                    and op["instance_id"] == instance_id
                    and op["status"] not in SETTLED_STATUSES
                ):
                    result[key]["received_unsynced"] += Decimal(op["payload"]["amount"])
        return {
            key: value
            | {
                "pending": str(value["pending"]),
                "received_unsynced": str(value["received_unsynced"]),
            }
            for key, value in result.items()
        }
