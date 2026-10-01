from datetime import date
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class SplitInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    category: str = Field(pattern=r"^Expenses:[^\s\";]+$")
    amount: Decimal = Field(max_digits=24, decimal_places=8)
    note: str = Field(default="", max_length=2000)

    @field_validator("amount", mode="before")
    @classmethod
    def exact_amount(cls, value):
        if not isinstance(value, str):
            raise ValueError("金额必须以十进制字符串提交")
        return value


class EntryInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date: date
    payee: str = Field(default="", max_length=200)
    narration: str = Field(default="", max_length=500)
    amount: Decimal = Field(gt=0, max_digits=24, decimal_places=8)
    currency: str = Field(default="CNY", pattern=r"^[A-Z][A-Z0-9._-]{0,23}$")
    category: str = Field(pattern=r"^(Expenses|Income):[^\s\";]+$")
    payment: str = Field(pattern=r"^(Assets|Liabilities):[^\s\";]+$")
    note: str = Field(default="", max_length=2000)
    splits: list[SplitInput] = Field(default_factory=list, max_length=100)

    @field_validator("amount", mode="before")
    @classmethod
    def exact_amount(cls, value):
        if not isinstance(value, str):
            raise ValueError("金额必须以十进制字符串提交")
        return value


class OrderInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["paid", "deferred", "settle", "refund_paid", "refund_unpaid"]
    purchase: EntryInput | None = None
    source_id: str = ""
    date: date
    amount: Decimal = Field(gt=0, max_digits=24, decimal_places=8)
    account: str = Field(pattern=r"^(Assets|Liabilities):[^\s\";]+$")
    category: str = ""
    note: str = Field(default="", max_length=2000)

    @field_validator("amount", mode="before")
    @classmethod
    def exact_amount(cls, value):
        return EntryInput.exact_amount(value)


class Mutation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    operation: Literal["create", "edit", "delete"] = "create"
    business: str = Field(default="ordinary", pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    transaction_id: str | None = None
    entry: EntryInput | None = None
    raw: str | None = Field(default=None, max_length=100000)
    order: OrderInput | None = None
    values: dict[str, str] | None = Field(default=None, max_length=100)
    layout_version: str | None = None


class CommitInput(BaseModel):
    request_id: UUID


class BatchItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    business: str = Field(default="ordinary", pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    entry: EntryInput | None = None
    raw: str | None = Field(default=None, max_length=100000)
    order: OrderInput | None = None
    values: dict[str, str] | None = Field(default=None, max_length=100)
    layout_version: str | None = None


class BatchMutation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    items: list[BatchItem] = Field(min_length=1, max_length=100)
