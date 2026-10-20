"""Allowlisted Grocy master-data editing with durable request deduplication."""

import json
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from .grocy import Grocy, GrocyError
from .ledger import LedgerError


class NamedInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)


class LocationInput(NamedInput):
    is_freezer: Literal[0, 1] = 0


class UnitInput(NamedInput):
    name_plural: str = Field(default="", max_length=200)


class ProductInput(NamedInput):
    location_id: int = Field(gt=0)
    qu_id_purchase: int = Field(gt=0)
    qu_id_stock: int = Field(gt=0)
    min_stock_amount: Decimal = Field(default=Decimal(0), ge=0, max_digits=20, decimal_places=8)
    default_best_before_days: int = Field(default=0, ge=-1, le=36500)
    active: Literal[0, 1] = 1
    product_group_id: int | None = Field(default=None, gt=0)
    parent_product_id: int | None = Field(default=None, gt=0)
    no_own_stock: Literal[0, 1] = 0
    cumulate_min_stock_amount_of_sub_products: Literal[0, 1] = 0


class ConversionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    product_id: int | None = Field(default=None, gt=0)
    from_qu_id: int = Field(gt=0)
    to_qu_id: int = Field(gt=0)
    factor: Decimal = Field(gt=0, max_digits=30, decimal_places=18)


ENTITIES = {
    "products": ProductInput,
    "locations": LocationInput,
    "quantity_units": UnitInput,
    "shopping_locations": NamedInput,
    "product_groups": NamedInput,
    "quantity_unit_conversions": ConversionInput,
}


class EntityChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    instance_id: str
    entity: Literal[
        "products",
        "locations",
        "quantity_units",
        "shopping_locations",
        "quantity_unit_conversions",
        "product_groups",
    ]
    entity_id: int | None = Field(default=None, gt=0)
    delete: bool = False
    data: dict = Field(default_factory=dict, max_length=20)


class MasterData:
    def __init__(self, writer):
        self.writer = writer
        self.grocy = Grocy(writer.state)
        with writer.database() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS grocy_master_requests "
                "(id TEXT PRIMARY KEY, request TEXT, result TEXT)"
            )

    def change(self, request: EntityChange):
        if request.delete and not request.entity_id:
            raise ValueError("删除需要明确选择记录")
        payload = (
            None
            if request.delete
            else ENTITIES[request.entity]
            .model_validate(request.data)
            .model_dump(mode="json", exclude_unset=bool(request.entity_id))
        )
        if (
            request.entity == "products"
            and payload
            and request.entity_id
            and payload.get("parent_product_id") == request.entity_id
        ):
            raise ValueError("产品不能选择自己作为父产品")
        content = request.model_dump(mode="json")
        identity = str(request.request_id)
        with self.grocy.lock:
            with self.writer.database() as db:
                row = db.execute(
                    "SELECT * FROM grocy_master_requests WHERE id=?", (identity,)
                ).fetchone()
                if row:
                    if json.loads(row["request"]) != content:
                        raise LedgerError("资料操作编号已用于其他内容")
                    return json.loads(row["result"])
                result = {
                    "status": "unknown",
                    "message": "请求已开始，需核对远端记录；不自动重复执行",
                }
                db.execute(
                    "INSERT INTO grocy_master_requests VALUES (?,?,?)",
                    (identity, json.dumps(content), json.dumps(result)),
                )
            try:
                path = f"objects/{request.entity}" + (
                    f"/{request.entity_id}" if request.entity_id else ""
                )
                method = "DELETE" if request.delete else "PUT" if request.entity_id else "POST"
                response = self.grocy.request(
                    path, method, payload, instance_id=request.instance_id
                )
                result = {"status": "done", "response": response, "message": "Grocy 资料已保存"}
            except GrocyError as exc:
                result = {
                    "status": "unknown",
                    "message": str(exc) + "；请刷新核对。删除受库存、历史及其他资料引用限制。",
                }
            with self.writer.database() as db:
                db.execute(
                    "UPDATE grocy_master_requests SET result=? WHERE id=?",
                    (json.dumps(result), identity),
                )
            return result
