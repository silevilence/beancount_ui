from datetime import timedelta

from .ledger import LedgerError
from .query import transactions


def income_days(snapshot, start, end):
    if snapshot.errors:
        raise LedgerError("账本有错误，无法核对收益")
    if not 0 <= (end - start).days <= 365:
        raise LedgerError("日期范围应为 1—366 天")
    rows = [r for r in transactions(snapshot) if r["file"] == "txs/category/yuebao.bean"]
    return [
        {
            "date": str(start + timedelta(days=i)),
            "records": [r for r in rows if r["date"] == str(start + timedelta(days=i))],
        }
        for i in range((end - start).days + 1)
    ]
