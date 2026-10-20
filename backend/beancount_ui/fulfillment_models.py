"""Physical quantities and receipt requests are independent of ledger postings."""

from datetime import date
from decimal import ROUND_HALF_UP, Decimal, localcontext
from typing import Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_serializer,
    model_validator,
)


class ItemInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: UUID
    name: str = Field(min_length=1, max_length=200)
    quantity: Decimal = Field(gt=0, max_digits=20, decimal_places=8)
    unit: str = Field(default="件", min_length=1, max_length=50)
    product_id: int | None = Field(default=None, gt=0)
    instance_id: str = ""
    factor: Decimal = Field(default=Decimal(1), gt=0, max_digits=30, decimal_places=18)
    stock_unit: str = Field(default="件", max_length=50)
    purchase_unit_id: int | None = Field(default=None, gt=0)
    stock_unit_id: int | None = Field(default=None, gt=0)
    unit_price: Decimal | None = Field(default=None, ge=0, max_digits=20, decimal_places=8)
    currency: str = Field(default="", max_length=20)
    price_confirmed: bool = False
    allocated_amount: Decimal | None = Field(default=None, ge=0, max_digits=24, decimal_places=8)
    default_location_id: int | None = Field(default=None, gt=0)
    default_best_before_days: int | None = Field(default=None, ge=-1, le=36500)

    @model_serializer(mode="wrap")
    def preserve_legacy_request(self, handler):
        result = handler(self)
        if self.allocated_amount is None:
            result.pop("allocated_amount", None)
        return result

    @field_validator("quantity", "factor", "unit_price", "allocated_amount", mode="before")
    @classmethod
    def exact(cls, value):
        if value is not None and not isinstance(value, (str, Decimal)):
            raise ValueError("数量与价格必须使用十进制字符串")
        return value

    @model_validator(mode="after")
    def linked(self):
        if self.product_id and self.allocated_amount is not None:
            with localcontext() as context:
                context.prec = 60
                self.unit_price = (self.allocated_amount / (self.quantity * self.factor)).quantize(
                    Decimal("0.00000001"), rounding=ROUND_HALF_UP
                )
            if self.unit_price >= Decimal("1000000000000"):
                raise ValueError("计算后的库存单价超出支持范围，请核对金额与数量")
            self.price_confirmed = True
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
    unit_price: Decimal | None = Field(default=None, ge=0, max_digits=20, decimal_places=8)

    @field_validator("quantity", "unit_price", mode="before")
    @classmethod
    def exact(cls, value):
        return ItemInput.exact(value)


class SettlementInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date: date
    amount: Decimal = Field(gt=0, max_digits=24, decimal_places=8)
    account: str = Field(pattern=r"^(Assets|Liabilities):[^\s\";]+$")

    @field_validator("amount", mode="before")
    @classmethod
    def exact(cls, value):
        return ItemInput.exact(value)


class ReceiptInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    order_id: str
    received_date: date
    lines: list[ReceiptLine] = Field(min_length=1, max_length=100)
    settlement: SettlementInput | None = None
