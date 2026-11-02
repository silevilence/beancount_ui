"""Read-only income/expense reports, using booked posting units without conversion."""

from calendar import monthrange
from datetime import date, timedelta
from decimal import Decimal
from fnmatch import translate
from time import monotonic
from typing import Literal

import regex
from beancount.core import data
from pydantic import BaseModel, Field

from .ledger import Ledger, LedgerError
from .query import transactions

Granularity = Literal["day", "week", "month"]


class StatisticsFilter(BaseModel):
    payee: str = Field(default="", max_length=500)
    narration: str = Field(default="", max_length=500)
    match: Literal["contains", "wildcard", "regex"] = "contains"
    group_by: Literal["account", "payee", "narration"] = "account"

    def matcher(self):
        patterns = []
        for value in (self.payee, self.narration):
            expression = translate(value) if self.match == "wildcard" else value
            if self.match == "contains":
                expression = regex.escape(value)
            if not value:
                expression = ""
            try:
                patterns.append(regex.compile(expression, regex.IGNORECASE))
            except regex.error as exc:
                raise ValueError(f"匹配表达式无效：{exc}") from exc
        elapsed = 0

        def matches(payee, narration):
            nonlocal elapsed
            started = monotonic()
            try:
                if elapsed > 2:
                    raise TimeoutError
                return all(
                    pattern.search(value or "", timeout=0.02) is not None
                    for pattern, value in zip(patterns, (payee, narration), strict=True)
                )
            except TimeoutError as exc:
                raise ValueError("匹配耗时过长，请简化表达式或缩小日期范围") from exc
            finally:
                elapsed += monotonic() - started

        return matches

    def group(self, account, payee, narration):
        if self.group_by == "payee":
            return payee or "（未填写商家）"
        if self.group_by == "narration":
            return narration or "（未填写摘要）"
        return account


def period_start(day: date, grain: Granularity) -> date:
    if grain == "week":
        return day - timedelta(days=day.weekday())
    if grain == "month":
        return day.replace(day=1)
    return day


def periods(start: date, end: date, grain: Granularity):
    if start > end:
        raise ValueError("开始日期不能晚于结束日期")
    if grain not in ("day", "week", "month"):
        raise ValueError("统计粒度必须为 day、week 或 month")
    result = []
    current = start
    while current <= end:
        first = period_start(current, grain)
        days = {"day": 1, "week": 7, "month": monthrange(first.year, first.month)[1]}[grain]
        last = date.fromordinal(min(first.toordinal() + days - 1, end.toordinal()))
        result.append((str(first), str(current), str(last)))
        if len(result) > 5000:
            raise ValueError("统计超过 5000 个时段，请缩短范围或切换为周、月")
        if last == end:
            break
        current = last + timedelta(days=1)
    return result


def account_kind(account: str) -> str | None:
    if account.startswith("Expenses:"):
        return "expenses"
    if account.startswith("Income:"):
        return "income"
    return None


def totals(income=Decimal(0), expenses=Decimal(0)) -> dict:
    return {
        "income": format(income, "f"),
        "expenses": format(expenses, "f"),
        "net": format(income - expenses, "f"),
    }


def report_snapshot(ledger: Ledger):
    latest = ledger.refresh()
    snapshot = ledger.last_valid or latest
    return snapshot, {
        "revision": latest.revision,
        "view_revision": snapshot.revision,
        "stale": bool(latest.errors),
        "available": not snapshot.errors,
        "errors": latest.errors,
    }


def statistics(
    ledger: Ledger,
    start: date,
    end: date,
    grain: Granularity,
    currency="",
    filters: StatisticsFilter | None = None,
):
    filters = filters or StatisticsFilter()
    matches = filters.matcher()
    intervals = periods(start, end, grain)
    snapshot, status = report_snapshot(ledger)
    entries = (
        []
        if snapshot.errors
        else [entry for entry in snapshot.entries if isinstance(entry, data.Transaction)]
    )
    currencies = sorted(
        set(snapshot.operating_currencies)
        | {p.units.currency for entry in entries for p in entry.postings if account_kind(p.account)}
    )
    if currency and currency not in currencies:
        raise ValueError("所选币种不在账本收支或展示币种中，请重新选择")
    currency = currency or next(iter(snapshot.operating_currencies or currencies), "")
    buckets = {
        key: {"start": first, "end": last, "income": Decimal(0), "expenses": Decimal(0), "count": 0}
        for key, first, last in intervals
    }
    categories = {"income": {}, "expenses": {}}
    for entry in entries:
        if not start <= entry.date <= end or not matches(entry.payee, entry.narration):
            continue
        bucket = buckets[str(period_start(entry.date, grain))]
        matched = False
        for posting in entry.postings:
            kind = account_kind(posting.account)
            if kind and posting.units.currency == currency:
                amount = posting.units.number * (-1 if kind == "income" else 1)
                bucket[kind] += amount
                group = filters.group(posting.account, entry.payee, entry.narration)
                categories[kind][group] = categories[kind].get(group, Decimal(0)) + amount
                matched = True
        bucket["count"] += int(matched)
    values = list(buckets.values())
    return {
        **status,
        "filters": filters.model_dump(),
        "start": str(start),
        "end": str(end),
        "grain": grain,
        "currency": currency,
        "currencies": currencies,
        "totals": totals(
            sum((b["income"] for b in values), Decimal(0)),
            sum((b["expenses"] for b in values), Decimal(0)),
        ),
        "count": sum(b["count"] for b in values),
        "categories": {
            kind: [
                {"account": account, "amount": format(amount, "f")}
                for account, amount in sorted(accounts.items(), key=lambda row: (-row[1], row[0]))
            ]
            for kind, accounts in categories.items()
        },
        "buckets": [{**b, **totals(b["income"], b["expenses"])} for b in values],
    }


def statistics_details(
    ledger: Ledger,
    start: date,
    end: date,
    currency: str,
    revision: str,
    account="",
    filters: StatisticsFilter | None = None,
):
    filters = filters or StatisticsFilter()
    matches = filters.matcher()
    if start > end:
        raise ValueError("开始日期不能晚于结束日期")
    snapshot, status = report_snapshot(ledger)
    if snapshot.revision != revision:
        raise LedgerError("账本已变化，请刷新统计后重新查看明细")
    rows = []
    for row in [] if snapshot.errors else transactions(snapshot):
        if not str(start) <= row["date"] <= str(end):
            continue
        if not matches(row["payee"], row["narration"]):
            continue
        contributions = []
        income, expenses = Decimal(0), Decimal(0)
        for posting in row["postings"]:
            kind = account_kind(posting["account"])
            if (
                not kind
                or posting["currency"] != currency
                or (
                    account
                    and filters.group(posting["account"], row["payee"], row["narration"]) != account
                )
            ):
                continue
            amount = Decimal(posting["amount"]) * (-1 if kind == "income" else 1)
            contributions.append({**posting, "kind": kind, "amount": format(amount, "f")})
            if kind == "income":
                income += amount
            else:
                expenses += amount
        if contributions:
            rows.append(
                {
                    "id": row["id"],
                    "date": row["date"],
                    "payee": row["payee"],
                    "narration": row["narration"],
                    "file": row["file"],
                    "line": row["line"],
                    "raw": row["raw"],
                    "contributions": contributions,
                    **totals(income, expenses),
                }
            )
    return {**status, "transactions": rows}
