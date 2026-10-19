"""Explicit, audited corrections; financial refunds never imply stock movement."""

import json
import time
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from .fulfillment import Fulfillment
from .fulfillment_models import ItemInput
from .grocy import Grocy
from .ledger import LedgerError
from .stock_operations import StockOperations


class CorrectionInput(BaseModel):
    request_id: UUID
    order_id: str
    action: Literal[
        "cancel_remaining", "replace_unreceived", "release", "void_receipt", "return_note"
    ]
    reason: str = Field(min_length=3, max_length=2000)
    item_id: str = ""
    receipt_id: str = ""
    replacement: ItemInput | None = None


class OrderCorrections:
    def __init__(self, writer):
        self.writer = writer
        self.orders = Fulfillment(writer)
        self.operations = StockOperations(writer)

    def inspect(self, order_id, receipt_id):
        order = next((o for o in self.orders.list() if o["id"] == order_id), None)
        if not order:
            raise LedgerError("订单不存在")
        receipt = next((r for r in order["receipts"] if r["request_id"] == receipt_id), None)
        if not receipt:
            raise LedgerError("收货记录不存在")
        ops = [
            self.operations.reconcile(o["id"])
            for o in self.operations.list()
            if o["receipt_id"] == receipt_id
            and o["status"] not in ("pending", "failed", "cancelled")
        ]
        return {
            "receipt": receipt,
            "operations": ops,
            "guidance": (
                "仅退款／差价不扣库存。真实退货请按对应批次在库存页确认消耗；"
                "误录可申请撤销，已有后续操作或结果未知时需人工处理。"
            ),
        }

    def apply(self, request: CorrectionInput):
        identity = str(request.request_id)
        body = request.model_dump(mode="json")
        # Ledger lock excludes concurrent physical receipts. No network callback acquires it.
        with self.writer.guard():
            with self.writer.database() as db:
                previous = db.execute(
                    "SELECT * FROM order_corrections WHERE id=?", (identity,)
                ).fetchone()
                if previous:
                    if json.loads(previous["request"]) != body:
                        raise LedgerError("更正编号已用于不同内容")
                    return json.loads(previous["result"])
            current = next((o for o in self.orders.list() if o["id"] == request.order_id), None)
            if not current:
                raise LedgerError("订单不存在")
            with self.writer.database() as db:
                stored = db.execute(
                    "SELECT payload FROM fulfillment_orders WHERE id=?", (request.order_id,)
                ).fetchone()
            doc = json.loads(stored["payload"])
            receipt = None
            previous_item = None
            if request.action in ("cancel_remaining", "replace_unreceived"):
                item = next((i for i in current["items"] if i["id"] == request.item_id), None)
                if not item or (
                    request.action == "cancel_remaining" and Decimal(item["remaining"]) <= 0
                ):
                    raise LedgerError("商品没有剩余待收数量")
                if request.action == "cancel_remaining":
                    doc["cancelled"][item["id"]] = str(
                        Decimal(item["cancelled"]) + Decimal(item["remaining"])
                    )
                else:
                    if any(
                        line["item_id"] == item["id"]
                        for r in current["receipts"]
                        if not r.get("voided")
                        for line in r["lines"]
                    ):
                        raise LedgerError(
                            "商品仍有有效收货；请先作废相关收货并确认库存撤销，再更正商品"
                        )
                    if not request.replacement or str(request.replacement.id) != item["id"]:
                        raise LedgerError("更正需保留商品编号")
                    previous_item = next(i for i in doc["items"] if i["id"] == item["id"])
                    replacement = request.replacement.model_dump(mode="json")
                    Grocy(self.writer.state).validate_items([{"items": [replacement]}], bind=True)
                    doc["items"] = [
                        replacement if i["id"] == item["id"] else i for i in doc["items"]
                    ]
                    doc["cancelled"].pop(item["id"], None)
            elif request.action == "release":
                if any(not r.get("voided") for r in current["receipts"]):
                    raise LedgerError("存在收货历史，不能解除关联或删除；请保留原订单并显式更正")
            else:
                receipt = next(
                    (r for r in current["receipts"] if r["request_id"] == request.receipt_id), None
                )
                if not receipt:
                    raise LedgerError("收货记录不存在")
                if request.action == "void_receipt":
                    if receipt.get("voided"):
                        raise LedgerError("收货已作废，请刷新")
                    ops = [
                        o for o in self.operations.list() if o["receipt_id"] == request.receipt_id
                    ]
                    for op in ops:
                        result = self.operations.undo_receipt(op["id"], request.reason)
                        if result["status"] not in ("undone", "cancelled"):
                            raise LedgerError("库存撤销未全部确认，收货历史保留；请先核对")
                    receipt["voided"] = True
                receipt.setdefault("corrections", []).append(
                    {"action": request.action, "reason": request.reason, "at": time.time()}
                )
            result = {
                "status": "done",
                "action": request.action,
                "message": "更正已记录；付款／退款需单独在账务页处理",
            }
            if previous_item is not None:
                result["previous_item"] = previous_item
            with self.writer.database() as db:
                if previous_item is not None:
                    for historical in current["receipts"]:
                        if any(
                            line["item_id"] == previous_item["id"] for line in historical["lines"]
                        ):
                            historical.setdefault("item_snapshots", {}).setdefault(
                                previous_item["id"], previous_item
                            )
                            db.execute(
                                "UPDATE receipts SET payload=? WHERE id=?",
                                (json.dumps(historical), historical["request_id"]),
                            )
                if request.action == "release":
                    db.execute("DELETE FROM fulfillment_orders WHERE id=?", (request.order_id,))
                    result["released_snapshot"] = doc
                    result["released_receipts"] = current["receipts"]
                else:
                    db.execute(
                        "UPDATE fulfillment_orders SET payload=? WHERE id=?",
                        (json.dumps(doc), request.order_id),
                    )
                if receipt:
                    db.execute(
                        "UPDATE receipts SET payload=? WHERE id=?",
                        (json.dumps(receipt), request.receipt_id),
                    )
                db.execute(
                    "INSERT INTO order_corrections VALUES (?,?,?,?)",
                    (identity, request.order_id, json.dumps(body), json.dumps(result)),
                )
            return result
