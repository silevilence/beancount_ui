"""Date-based views across all included files; amounts stay decimal strings."""

import hashlib
from collections import defaultdict
from datetime import date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from beancount.core import data

from .ledger import Ledger, Snapshot, git_info
from .posting_form import read_form


def source_span(snapshot: Snapshot, entry, lines: list[str]) -> tuple[str, int, int, str]:
    name = entry.meta["filename"]
    start = entry.meta["lineno"] - 1
    end = start + 1
    # Stop at a top-level directive/comment; trailing separators are not part of the record.
    for i in range(start + 1, len(lines)):
        if lines[i].strip() and not lines[i][0].isspace():
            break
        if lines[i].strip():
            end = i + 1
    return name, start, end, "".join(lines[start:end])


def transactions(snapshot: Snapshot) -> list[dict]:
    if snapshot.records is not None:
        return snapshot.records
    result = []
    lines_by_file = {}
    occurrences: dict[str, int] = defaultdict(int)
    for entry in snapshot.entries:
        if not isinstance(entry, data.Transaction):
            continue
        name = entry.meta["filename"]
        if name not in lines_by_file:
            lines_by_file[name] = snapshot.files[name].decode("utf-8-sig").splitlines(keepends=True)
        name, start, end, raw = source_span(snapshot, entry, lines_by_file[name])
        fingerprint = hashlib.sha256((name + "\0" + raw).encode()).hexdigest()
        ordinal = occurrences[fingerprint]
        occurrences[fingerprint] += 1
        identity = f"{fingerprint}:{ordinal}"
        postings = [
            {
                "account": p.account,
                "amount": str(p.units.number),
                "currency": p.units.currency,
                "note": str((p.meta or {}).get("memo", "")),
            }
            for p in entry.postings
        ]
        simple = (
            len(entry.postings) == 2
            and entry.postings[0].units.number > 0
            and all(p.cost is None and p.price is None for p in entry.postings)
            and entry.postings[0].units.currency == entry.postings[1].units.currency
            and entry.postings[0].units.number == -entry.postings[1].units.number
            and entry.postings[0].account.startswith("Expenses:")
            and entry.postings[1].account.startswith(("Assets:", "Liabilities:"))
        )
        kind = (
            "消费"
            if any(p.account.startswith("Expenses:") for p in entry.postings)
            else (
                "收入"
                if any(p.account.startswith("Income:") for p in entry.postings)
                else "转账 / 还款"
            )
        )
        result.append(
            {
                "id": identity,
                "metadata": {k: str(v) for k, v in entry.meta.items() if k.startswith("order-")},
                "date": str(entry.date),
                "payee": entry.payee or "",
                "narration": entry.narration,
                "tags": sorted(entry.tags),
                "kind": kind,
                "postings": postings,
                "file": name,
                "line": start + 1,
                "end": end,
                "raw": raw,
                "simple": simple,
                "posting_form": read_form(raw, len(entry.postings), validated_entry=entry),
                "readonly": name.startswith("gnucash/"),
                "note": str(entry.meta.get("memo", "")),
            }
        )
    snapshot.records = result
    return result


def accounts_at(snapshot: Snapshot, day: date) -> list[dict]:
    accounts = {}
    for entry in snapshot.entries:
        if entry.date > day:
            continue
        if isinstance(entry, data.Open):
            accounts[entry.account] = {"name": entry.account, "currencies": entry.currencies or []}
        elif isinstance(entry, data.Close):
            accounts.pop(entry.account, None)
    return sorted(accounts.values(), key=lambda account: account["name"])


def daily_view(ledger: Ledger, day: date | None = None, payee="", narration="", account=""):
    day = day or datetime.now(ZoneInfo("Asia/Shanghai")).date()
    latest = ledger.refresh()
    snapshot = ledger.last_valid or latest
    rows = (
        []
        if snapshot.errors
        else [row for row in transactions(snapshot) if row["date"] == str(day)]
    )
    totals: dict[str, Decimal] = defaultdict(Decimal)
    income: dict[str, Decimal] = defaultdict(Decimal)
    for row in rows:
        for posting in row["postings"]:
            if posting["account"].startswith("Expenses:"):
                totals[posting["currency"]] += Decimal(posting["amount"])
            if posting["account"].startswith("Income:"):
                income[posting["currency"]] -= Decimal(posting["amount"])
    filtered = [
        row
        for row in rows
        if payee.casefold() in row["payee"].casefold()
        and narration.casefold() in row["narration"].casefold()
        and any(account.casefold() in p["account"].casefold() for p in row["postings"])
    ]
    return {
        "identity": hashlib.sha256(str(ledger.settings.ledger_dir.resolve()).encode()).hexdigest(),
        "date": str(day),
        "revision": latest.revision,
        "view_revision": snapshot.revision,
        "stale": bool(latest.errors),
        "errors": latest.errors,
        "transactions": filtered,
        "expenses": {k: str(v) for k, v in totals.items()},
        "income": {k: str(v) for k, v in income.items()},
        "accounts": accounts_at(snapshot, day),
        "sync": git_info(ledger.settings.ledger_dir)["sync"],
    }
