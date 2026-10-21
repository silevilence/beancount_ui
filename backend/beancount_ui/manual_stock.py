"""Manual inventory actions: explicit preview, stock units, no accounting side effects."""

from datetime import date
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .fulfillment_models import ItemInput
from .ledger import LedgerError
from .stock_operations import StockOperations, enqueue


class StockAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    instance_id: str
    product_id: int = Field(gt=0)
    action: Literal["add", "open", "consume", "transfer"]
    amount: Decimal = Field(gt=0, max_digits=20, decimal_places=8)
    stock_id: str = Field(default="", max_length=100)
    location_id: int = Field(gt=0)
    target_location_id: int | None = Field(default=None, gt=0)
    purchased_date: date | None = None
    best_before_date: date | None = None
    price: Decimal | None = Field(default=None, ge=0, max_digits=20, decimal_places=8)
    currency: str = ""
    independent_purchase: bool = False

    @field_validator("amount", "price", mode="before")
    @classmethod
    def exact(cls, value):
        return ItemInput.exact(value)


def open_target(product, source_location_id):
    target = product.get("default_consume_location_id")
    if int(product.get("move_on_open", 0)) and target and str(target) != str(source_location_id):
        return int(target)
    return None


def validate_operation(grocy, op):
    product = grocy.request(f"objects/products/{op['product_id']}", instance_id=op["instance_id"])
    if int(product.get("enable_tare_weight_handling", 0)) or int(product.get("no_own_stock", 0)):
        raise LedgerError("皮重或无自有库存产品请在 Grocy 操作")
    if str(product["qu_id_stock"]) != str(op["stock_unit_id"]):
        raise LedgerError("库存单位已变化，请重新核对")
    payload = op["payload"]
    if op["action"] == "open" and "open_target_location_id" in op:
        if open_target(product, op["source_location_id"]) != op["open_target_location_id"]:
            raise LedgerError("开封自动转移设置已变化，请重新预览")
    if op["action"] == "add":
        if grocy.request("system/config")["CURRENCY"] != op["currency"]:
            raise LedgerError("Grocy 币种已变化，请重新确认单价")
        return
    entries = grocy.request(
        f"stock/products/{op['product_id']}/entries", instance_id=op["instance_id"]
    )
    candidates = [
        e
        for e in entries
        if str(e["location_id"]) == str(op["source_location_id"])
        and (not payload.get("stock_entry_id") or e["stock_id"] == payload["stock_entry_id"])
        and (op["action"] != "open" or not int(e.get("open", 0)))
    ]
    if sum((Decimal(str(e["amount"])) for e in candidates), Decimal(0)) < Decimal(
        payload["amount"]
    ):
        raise LedgerError("所选位置／批次可操作数量不足")
    if op["action"] == "open" and not payload.get("stock_entry_id"):
        raise LedgerError("开封需要明确选择未开封批次")


class ManualStock:
    def __init__(self, writer):
        self.writer = writer
        self.operations = StockOperations(writer)
        self.grocy = self.operations.grocy

    def preview(self, request: StockAction):
        identity = str(request.request_id)
        original = request.model_dump(mode="json")
        with self.writer.guard(), self.grocy.lock:
            with self.writer.database() as db:
                exists = db.execute(
                    "SELECT id FROM inventory_operations WHERE id=?", (identity,)
                ).fetchone()
            if exists:
                existing = self.operations.get(identity)
                if existing.get("request") != original:
                    raise LedgerError("库存操作编号已用于其他内容")
                return existing
            for existing in self.operations.list():
                if (
                    existing.get("manual")
                    and existing["instance_id"] == request.instance_id
                    and existing["product_id"] == request.product_id
                    and existing["status"] in ("sending", "unknown", "conflict")
                ):
                    raise LedgerError("该产品已有结果待核对的手动操作，请先处理原请求")
            product = self.grocy.request(
                f"objects/products/{request.product_id}", instance_id=request.instance_id
            )
            payload = {"amount": str(request.amount)}
            if request.action == "add":
                if not request.independent_purchase:
                    raise LedgerError("订单采购请通过确认收货入库；手动入库需确认与订单收货无关")
                if (
                    request.price is None
                    or not request.purchased_date
                    or not request.best_before_date
                ):
                    raise LedgerError("手动入库需要确认价格、购买日期和保质期")
                payload.update(
                    price=str(request.price),
                    purchased_date=str(request.purchased_date),
                    best_before_date=str(request.best_before_date),
                    location_id=request.location_id,
                    transaction_type="purchase",
                    note="beancount-ui-receipt:" + identity,
                )
            else:
                if request.stock_id:
                    payload["stock_entry_id"] = request.stock_id
                if request.action == "consume":
                    payload.update(location_id=request.location_id, transaction_type="consume")
                if request.action == "transfer":
                    if (
                        not request.target_location_id
                        or request.target_location_id == request.location_id
                    ):
                        raise LedgerError("请选择不同的目标位置")
                    payload.update(
                        location_id_from=request.location_id,
                        location_id_to=request.target_location_id,
                    )
            doc = {
                "id": identity,
                "receipt_id": "",
                "instance_id": request.instance_id,
                "product_id": request.product_id,
                "action": request.action,
                "payload": payload,
                "manual": True,
                "stock_unit_id": product["qu_id_stock"],
                "currency": request.currency,
                "source_location_id": request.location_id,
                "request": original,
            }
            if request.action == "open":
                doc["open_target_location_id"] = open_target(product, request.location_id)
            validate_operation(self.grocy, doc)
            with self.writer.database() as db:
                enqueue(db, doc, "draft")
            return self.operations.get(identity)

    def commit(self, identity):
        with self.operations.operation_lock(identity):
            op = self.operations.get(identity)
            if not op.get("manual"):
                raise LedgerError("请从订单收货处理此库存操作")
            if op["status"] == "draft":
                self.operations.record(identity, "pending")
        result = self.operations.send(identity)
        return (
            self.operations.reconcile(identity)
            if result["status"] in ("unknown", "sending")
            else result
        )
