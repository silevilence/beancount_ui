import json
from datetime import date
from decimal import Decimal
from typing import Literal

from beancount.core import data
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .ledger import LedgerError
from .models import EntryInput
from .query import accounts_at


class FinanceInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["transfer", "repayment", "balance"]
    date: date
    account: str
    target: str = ""
    amount: Decimal = Field(max_digits=24, decimal_places=8)
    currency: str = Field(default="CNY", pattern=r"^[A-Z][A-Z0-9._-]{0,23}$")
    fee: Decimal = Field(default=Decimal(0), ge=0, max_digits=24, decimal_places=8)
    fee_account: str = ""
    note: str = Field(default="", max_length=2000)

    @field_validator("amount", "fee", mode="before")
    @classmethod
    def exact(cls, value):
        return EntryInput.exact_amount(value)


def compose_finance(snapshot, request):
    if snapshot.errors:
        raise LedgerError("账本有错误，请先修复后核对")
    accounts = {a["name"] for a in accounts_at(snapshot, request.date)}
    if request.account not in accounts or not request.account.startswith(
        ("Assets:", "Liabilities:")
    ):
        raise LedgerError("请选择日期有效的资产或负债账户")
    amount, currency = request.amount, request.currency
    if request.kind == "balance":
        actual = sum(
            (
                p.units.number
                for e in snapshot.entries
                if isinstance(e, data.Transaction) and e.date < request.date
                for p in e.postings
                if (p.account == request.account or p.account.startswith(request.account + ":"))
                and p.units.currency == currency
            ),
            Decimal(0),
        )
        return {
            "business": "balance",
            "raw": f"{request.date} balance {request.account} {amount:f} {currency}\n",
            "expected": str(amount),
            "actual": str(actual),
            "difference": str(actual - amount),
        }
    if request.amount <= 0 or request.account == request.target:
        raise LedgerError("转账金额须大于零且转出、转入账户不同")
    if request.target not in accounts or not request.target.startswith(("Assets:", "Liabilities:")):
        raise LedgerError("请选择日期有效的转入账户")
    if request.kind == "repayment" and (
        not request.account.startswith("Assets:") or not request.target.startswith("Liabilities:")
    ):
        raise LedgerError("还款从资产账户转入信用负债账户")
    if request.fee and (
        request.fee_account not in accounts or not request.fee_account.startswith("Expenses:")
    ):
        raise LedgerError("手续费必须选择有效费用账户")
    label = "信用账户还款" if request.kind == "repayment" else "转账"
    raw = f'{request.date} * "{label}"\n  memo: {json.dumps(request.note, ensure_ascii=False)}\n'
    raw += f"  {request.target} {amount:f} {currency}\n"
    if request.fee:
        raw += f"  {request.fee_account} {request.fee:f} {currency}\n"
    raw += f"  {request.account} {-(amount + request.fee):f} {currency}\n"
    return {"business": "ordinary", "raw": raw}
