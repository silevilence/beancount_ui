"""Physical quantities and receipt requests are independent of ledger postings."""

from datetime import date
from decimal import Decimal
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ItemInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: UUID = Field(default_factory=uuid4)
    name: str = Field(min_length=1, max_length=200)
    quantity: Decimal = Field(gt=0, max_digits=20, decimal_places=8)
    unit: str = Field(default="件", min_length=1, max_length=50)
    product_id: int | None = Field(default=None, gt=0)
    instance_id: str = ""
    factor: Decimal = Field(default=Decimal(1), gt=0, max_digits=20, decimal_places=8)
    stock_unit: str = Field(default="件", max_length=50)
    purchase_unit_id: int | None = Field(default=None, gt=0)
    stock_unit_id: int | None = Field(default=None, gt=0)
    unit_price: Decimal | None = Field(default=None, ge=0, max_digits=20, decimal_places=8)
    currency: str = Field(default="", max_length=20)
    price_confirmed: bool = False

    @field_validator("quantity", "factor", "unit_price", mode="before")
    @classmethod
    def exact(cls, value):
        if value is not None and not isinstance(value, (str, Decimal)):
            raise ValueError("数量与价格必须使用十进制字符串")
        return value

    @model_validator(mode="after")
    def linked(self):
        if self.product_id and (
            not self.instance_id
            or not self.purchase_unit_id
            or not self.stock_unit_id
            or self.unit_price is None
            or not self.currency
            or not self.price_confirmed
        ):
            raise ValueError("关联产品需要实例、单位换算及明确确认的库存单价和币种")
        return self


class ClaimInput(BaseModel):
    request_id: UUID
    revision: str
    source_id: str
    mode: Literal["paid", "deferred"]
    items: list[ItemInput] = Field(min_length=1, max_length=100)


class ReceiptLine(BaseModel):
    model_config = ConfigDict(extra="forbid")
    item_id: UUID
    quantity: Decimal = Field(gt=0, max_digits=20, decimal_places=8)
    location_id: int | None = Field(default=None, gt=0)
    best_before_date: date | None = None

    @field_validator("quantity", mode="before")
    @classmethod
    def exact(cls, value):
        return ItemInput.exact(value)


class ReceiptInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    order_id: str
    received_date: date
    lines: list[ReceiptLine] = Field(min_length=1, max_length=100)
