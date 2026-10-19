"""Preview physical receipt and optional settlement, then retain each independent outcome."""

import json
from datetime import date, timedelta
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

    def preview(self, request: ReceiptInput):
        identity = str(request.request_id)
        original = request.model_dump(mode="json")
        with self.writer.guard(), self.writer.database() as db:
            saved = db.execute("SELECT * FROM receipt_previews WHERE id=?", (identity,)).fetchone()
            if saved:
                if json.loads(saved["request"]) != original:
                    raise LedgerError("收货预览编号已用于不同内容")
                return json.loads(saved["result"])
            doc = next((o for o in self.orders.list() if o["id"] == request.order_id), None)
            if not doc or doc["source_changed"]:
                raise LedgerError("原订单发生变化，请先核对")
            from decimal import Decimal

            if str(request.received_date) < doc["source"]["date"]:
                raise LedgerError("收货日期不能早于购买日期")
            if len({line.item_id for line in request.lines}) != len(request.lines):
                raise LedgerError("收货商品不能重复")
            prepared = request.model_dump(mode="json")
            config = Grocy(self.writer.state).read()
            actions = []
            for line in prepared["lines"]:
                item = next((i for i in doc["items"] if i["id"] == line["item_id"]), None)
                if not item or Decimal(line["quantity"]) > Decimal(item["remaining"]):
                    raise LedgerError("收货数量超过剩余待收数量")
                if item["product_id"]:
                    if item["instance_id"] != config["instance_id"]:
                        raise LedgerError("Grocy 实例不一致，需先核对关联")
                    line["location_id"] = (
                        line["location_id"]
                        or config.get("default_location_id")
                        or item.get("default_location_id")
                    )
                    if not line["location_id"]:
                        raise LedgerError("请明确本次入库位置")
                    if not line["best_before_date"]:
                        days = config.get("default_best_before_days")
                        if days is None:
                            days = item.get("default_best_before_days")
                        if days is None:
                            raise LedgerError("请明确本次保质期日期")
                        line["best_before_date"] = str(
                            date(2999, 12, 31)
                            if days == -1
                            else request.received_date + timedelta(days=days)
                        )
                    line["unit_price"] = (
                        line["unit_price"] if line["unit_price"] is not None else item["unit_price"]
                    )
                actions.append(
                    {
                        "name": item["name"],
                        "quantity": line["quantity"],
                        "unit": item["unit"],
                        "stock_amount": str(Decimal(line["quantity"]) * Decimal(item["factor"])),
                        "product_id": item["product_id"],
                        "currency": item["currency"],
                        **line,
                    }
                )
            financial = None
            if request.settlement:
                if doc["source"]["mode"] != "deferred":
                    raise LedgerError("已付款订单收货不需要新增结算")
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

    def commit(self, identity):
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
            with self.writer.database() as db:
                existing = db.execute("SELECT 1 FROM receipts WHERE id=?", (identity,)).fetchone()
            if not existing:
                order = next((o for o in self.orders.list() if o["id"] == request.order_id), None)
                if not order or any(
                    {
                        k: v
                        for k, v in item.items()
                        if k not in ("received", "remaining", "cancelled")
                    }
                    != result["item_snapshots"].get(item["id"])
                    for item in order["items"]
                ):
                    raise LedgerError("收货预览后商品关联已更正，请重新预览")
            # The physical fact and outbox are committed together before optional external steps.
            self.orders.receive(request, prepared=True)
            result["receipt_saved"] = True
            result["settlement_error"] = ""
            if result["financial"]:
                try:
                    self.writer.commit(result["financial"]["request_id"])
                    result["settlement_status"] = "done"
                except (ValueError, OSError) as exc:
                    result["settlement_status"] = "needs_review"
                    result["settlement_error"] = str(exc)
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
