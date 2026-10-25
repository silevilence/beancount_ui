"""Confirm receipt once: save any required bill before receiving and stocking goods."""

import json
from datetime import date, timedelta
from decimal import Decimal
from uuid import UUID, uuid5

from .fulfillment import Fulfillment
from .fulfillment_models import ReceiptInput
from .grocy import Grocy
from .ledger import LedgerError
from .models import Mutation, OrderInput
from .stock_operations import StockOperations


class ReceiptFlow:
    def __init__(self, writer):
        self.writer = writer
        self.orders = Fulfillment(writer)

    def preview(self, request: ReceiptInput, *, batch_id=None, options=None):
        identity = str(request.request_id)
        original = request.model_dump(mode="json")
        with self.writer.guard(), self.writer.database() as db:
            saved = db.execute("SELECT * FROM receipt_previews WHERE id=?", (identity,)).fetchone()
            if saved:
                if json.loads(saved["request"]) != original:
                    raise LedgerError("收货预览编号已用于不同内容")
                result = json.loads(saved["result"])
                if result.get("batch_id") != batch_id:
                    raise LedgerError("该收货请求属于其他批次，请恢复原请求")
                return result
            doc = next((o for o in self.orders.list() if o["id"] == request.order_id), None)
            if not doc or doc["source_changed"]:
                raise LedgerError("原订单发生变化，请先核对")
            if (
                doc["source"]["mode"] == "deferred"
                and Decimal(doc["source"]["unpaid"]) > 0
                and not request.settlement
            ):
                raise LedgerError("先用后付订单请在本次收货中填写账单金额与账户")
            if str(request.received_date) < doc["source"]["date"]:
                raise LedgerError("收货日期不能早于购买日期")
            if len({line.item_id for line in request.lines}) != len(request.lines):
                raise LedgerError("收货商品不能重复")
            prepared = request.model_dump(mode="json")
            config = Grocy(self.writer.state).read()
            if any(i["product_id"] for i in doc["items"]):
                options = options or Grocy(self.writer.state).receipt_options()
            actions = []
            for line in prepared["lines"]:
                item = next((i for i in doc["items"] if i["id"] == line["item_id"]), None)
                if not item or Decimal(line["quantity"]) > Decimal(item["remaining"]):
                    raise LedgerError("收货数量超过剩余待收数量")
                if item["product_id"]:
                    if item["instance_id"] != config["instance_id"]:
                        raise LedgerError("Grocy 实例不一致，需先核对关联")
                    product = next(
                        (p for p in options["products"] if str(p["id"]) == str(item["product_id"])),
                        None,
                    )
                    if not product:
                        raise LedgerError("关联产品已失效，请重新核对")
                    line["location_id"] = (
                        line["location_id"]
                        or product.get("location_id")
                        or item.get("default_location_id")
                        or config.get("default_location_id")
                    )
                    if not line["location_id"]:
                        raise LedgerError("请明确本次入库位置")
                    if not line["best_before_date"]:
                        days = product.get("default_best_before_days")
                        if days is None:
                            days = item.get("default_best_before_days")
                        if days is None:
                            days = config.get("default_best_before_days")
                        if days is None:
                            raise LedgerError("请明确本次保质期日期")
                        days = int(days)
                        line["best_before_date"] = str(
                            date(2999, 12, 31)
                            if days == -1
                            else request.received_date + timedelta(days=days)
                        )
                    line["unit_price"] = (
                        line["unit_price"] if line["unit_price"] is not None else item["unit_price"]
                    )
                    location = next(
                        (
                            location
                            for location in options["locations"]
                            if str(location["id"]) == str(line["location_id"])
                        ),
                        None,
                    )
                    if not location:
                        raise LedgerError("入库位置已失效，请重新选择")
                actions.append(
                    {
                        "name": item["name"],
                        "quantity": line["quantity"],
                        "unit": item["unit"],
                        "stock_amount": str(Decimal(line["quantity"]) * Decimal(item["factor"])),
                        "product_id": item["product_id"],
                        "currency": item["currency"],
                        "location_name": location["name"] if item["product_id"] else None,
                        **line,
                    }
                )
            financial = None
            if request.settlement:
                if doc["source"]["mode"] != "deferred":
                    raise LedgerError("已付款订单收货不需要新增结算")
            if request.settlement and not batch_id:
                settle = request.settlement
                financial = self.writer.preview(
                    Mutation(
                        request_id=uuid5(request.request_id, "settlement"),
                        revision=self.writer.ledger.refresh().revision,
                        order=OrderInput(
                            kind="settle",
                            source_id=doc["source"]["id"],
                            date=settle.date,
                            amount=str(settle.amount),
                            account=settle.account,
                        ),
                    )
                )
            result = {
                "batch_id": batch_id,
                "order_id": doc["id"],
                "payee": doc["source"]["payee"],
                "narration": doc["source"]["narration"],
                "note": doc["source"].get("note", ""),
                "item_snapshots": {
                    i["id"]: {
                        k: v
                        for k, v in i.items()
                        if k not in ("received", "remaining", "cancelled")
                    }
                    for i in doc["items"]
                },
                "request_id": identity,
                "received_date": str(request.received_date),
                "actions": actions,
                "financial": financial,
                "receipt_saved": False,
                "settlement_status": "pending" if financial else "none",
                "operations": [],
            }
            db.execute(
                "INSERT INTO receipt_previews VALUES (?,?,?,?)",
                (identity, json.dumps(original), json.dumps(prepared), json.dumps(result)),
            )
            return result

    def validate_commit(self, request, result):
        identity = str(request.request_id)
        with self.writer.database() as db:
            existing = db.execute("SELECT 1 FROM receipts WHERE id=?", (identity,)).fetchone()
        if not existing:
            order = next((o for o in self.orders.list() if o["id"] == request.order_id), None)
            if (
                not order
                or order["source_changed"]
                or any(
                    {
                        k: v
                        for k, v in item.items()
                        if k not in ("received", "remaining", "cancelled")
                    }
                    != result["item_snapshots"].get(item["id"])
                    for item in order["items"]
                )
            ):
                raise LedgerError("收货预览后商品关联已更正，请重新预览")
            for line in request.lines:
                item = next((i for i in order["items"] if i["id"] == str(line.item_id)), None)
                if not item or line.quantity > Decimal(item["remaining"]):
                    raise LedgerError("收货数量超过剩余待收数量")
            if (
                order["source"]["mode"] == "deferred"
                and Decimal(order["source"]["unpaid"]) > 0
                and not result["financial"]
            ):
                raise LedgerError("先用后付订单请重新预览，在本次收货中填写账单")
        return existing

    def commit(self, identity, *, batch_id=None):
        identity = str(UUID(identity))
        with self.writer.guard():
            with self.writer.database() as db:
                row = db.execute(
                    "SELECT * FROM receipt_previews WHERE id=?", (identity,)
                ).fetchone()
            if not row:
                raise LedgerError("收货预览不存在")
            request = ReceiptInput.model_validate_json(row["prepared"])
            result = json.loads(row["result"])
            if result.get("batch_id") != batch_id:
                raise LedgerError("请通过原批次确认收货")
            if result.get("cancelled"):
                raise LedgerError("本次收货请求已取消，请重新预览")
            existing = self.validate_commit(request, result)
            result["settlement_error"] = ""
            if result["financial"] and result["settlement_status"] != "abandoned":
                try:
                    self.writer.commit(result["financial"]["request_id"])
                    result["settlement_status"] = "done"
                except (ValueError, OSError) as exc:
                    result["settlement_status"] = "needs_review"
                    result["settlement_error"] = str(exc)
                    # No receipt/outbox exists for new requests until the bill is durable.
                    # Older versions may already have saved a physical receipt; retain it.
                    result["receipt_saved"] = bool(existing)
                    with self.writer.database() as db:
                        db.execute(
                            "UPDATE receipt_previews SET result=? WHERE id=?",
                            (json.dumps(result), identity),
                        )
                    result["operations"] = [
                        o
                        for o in StockOperations(self.writer).list()
                        if o["receipt_id"] == identity
                    ]
                    return result
            self.orders.receive(
                request, prepared=True, recovery_required=result.get("recovery_required", False)
            )
            result["receipt_saved"] = True
            with self.writer.database() as db:
                db.execute(
                    "UPDATE receipt_previews SET result=? WHERE id=?",
                    (json.dumps(result), identity),
                )
                operation_ids = [
                    r["id"]
                    for r in db.execute(
                        "SELECT id FROM inventory_operations WHERE receipt_id=?", (identity,)
                    )
                ]
        operations = StockOperations(self.writer)
        for op_id in operation_ids:
            sent = operations.send(op_id)
            if sent["status"] in ("unknown", "sending"):
                operations.reconcile(op_id)
        result["operations"] = [operations.get(op_id) for op_id in operation_ids]
        return result

    def close_settlement(self, identity):
        """Cancel an unapplied bill so the same form can be corrected and previewed again."""
        identity = str(UUID(identity))
        with self.writer.guard(), self.writer.database() as db:
            row = db.execute("SELECT * FROM receipt_previews WHERE id=?", (identity,)).fetchone()
            if not row:
                raise LedgerError("收货预览不存在，请先恢复原收货请求")
            existing = db.execute("SELECT 1 FROM receipts WHERE id=?", (identity,)).fetchone()
            result = json.loads(row["result"])
            if result.get("batch_id"):
                raise LedgerError("请通过原批次核对或取消账单")
            financial = result["financial"]
            if not financial:
                raise LedgerError("本次没有待处理结算")
            request = db.execute(
                "SELECT status FROM requests WHERE id=?", (financial["request_id"],)
            ).fetchone()
            if not request or request["status"] not in ("preview", "cancelled", "done"):
                raise LedgerError("账务执行状态需核对，不能停止重试")
            if request["status"] == "done":
                if not existing:
                    raise LedgerError("账单已保存，请恢复原收货请求完成入库，不能重新记账")
                result["settlement_status"] = "done"
            else:
                db.execute(
                    "UPDATE requests SET status='cancelled' WHERE id=?", (financial["request_id"],)
                )
                result["settlement_status"] = "abandoned"
                if not existing:
                    result["cancelled"] = True
            result["receipt_saved"] = bool(existing)
            db.execute(
                "UPDATE receipt_previews SET result=? WHERE id=?", (json.dumps(result), identity)
            )
        result["operations"] = [
            o for o in StockOperations(self.writer).list() if o["receipt_id"] == identity
        ]
        return result
