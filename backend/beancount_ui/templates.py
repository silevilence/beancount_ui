"""Suggestions are derived from valid history, never inferred amounts or dates."""

from collections import Counter
from datetime import date

from .layout import matches_business_file
from .ledger import LedgerError, Snapshot
from .query import accounts_at, transactions


def recommendations(snapshot: Snapshot, day: date):
    if snapshot.errors:
        raise LedgerError("账本存在错误，不能推荐历史模板")
    active = {a["name"] for a in accounts_at(snapshot, day)}
    counts = Counter()
    for row in sorted(transactions(snapshot), key=lambda r: r["date"], reverse=True)[:500]:
        if row["date"] > str(day):
            continue
        postings = row["postings"]
        categories = [p for p in postings if p["account"].startswith(("Expenses:", "Income:"))]
        payments = [p for p in postings if p["account"].startswith(("Assets:", "Liabilities:"))]
        if len(postings) != 2 or len(categories) != 1 or len(payments) != 1:
            continue
        category, payment = categories[0], payments[0]
        if category["currency"] != payment["currency"]:
            continue
        business = next(
            (
                b
                for b in ("yuebao", "salary", "phone")
                if matches_business_file(row["file"], snapshot.business_files[b])
            ),
            "ordinary",
        )
        if business == "ordinary" and category["account"].startswith("Income:"):
            continue
        counts[
            (
                business,
                row["payee"],
                row["narration"],
                category["account"],
                payment["account"],
                category["currency"],
            )
        ] += 1
    return [
        {
            "business": key[0],
            "payee": key[1],
            "narration": key[2],
            "category": key[3] if key[3] in active else "",
            "payment": key[4] if key[4] in active else "",
            "currency": key[5],
            "uses": count,
        }
        for key, count in counts.most_common(20)
    ]
