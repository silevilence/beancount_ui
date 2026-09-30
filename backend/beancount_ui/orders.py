"""Explicitly confirmed order links and bounded settlement/refund amounts."""

import json
from decimal import Decimal

from .ledger import LedgerError
from .query import transactions


def quote(value):
    return json.dumps(value, ensure_ascii=False)


def orders(snapshot):
    rows = transactions(snapshot)
    result = []
    for row in rows:
        expense = [p for p in row["postings"] if p["account"].startswith("Expenses:")]
        funding = [
            p for p in row["postings"] if p["account"].startswith(("Assets:", "Liabilities:"))
        ]
        if not expense or len(funding) != 1 or Decimal(funding[0]["amount"]) >= 0:
            continue
        if len({p["currency"] for p in row["postings"]}) != 1:
            continue
        total = -Decimal(funding[0]["amount"])
        if sum(Decimal(p["amount"]) for p in expense) != total:
            continue
        key = row["metadata"].get("order-id", row["id"])
        events = [r for r in rows if r["metadata"].get("order-ref") == key]
        settled = Decimal(0)
        refund_paid = Decimal(0)
        refund_unpaid = Decimal(0)
        refunded = {}
        for event in events:
            kind = event["metadata"].get("order-action")
            amount = Decimal(str(event["metadata"].get("order-amount", "0")))
            if kind == "settle":
                settled += amount
            elif kind == "refund_paid":
                refund_paid += amount
            elif kind == "refund_unpaid":
                refund_unpaid += amount
            for p in event["postings"]:
                if p["account"].startswith("Expenses:"):
                    refunded[p["account"]] = refunded.get(p["account"], Decimal(0)) - Decimal(
                        p["amount"]
                    )
        categories = {}
        for p in expense:
            categories[p["account"]] = categories.get(p["account"], Decimal(0)) + Decimal(
                p["amount"]
            )
        result.append(
            {
                "id": row["id"],
                "key": key,
                "date": row["date"],
                "payee": row["payee"],
                "narration": row["narration"],
                "currency": funding[0]["currency"],
                "account": funding[0]["account"],
                "mode": row["metadata"].get("order-action", "historical"),
                "total": str(total),
                "settled": str(settled),
                "refunded": str(refund_paid + refund_unpaid),
                "unpaid": str(total - settled - refund_unpaid),
                "paid_available": str(settled - refund_paid),
                "direct_available": str(total - refund_paid),
                "categories": {
                    k: str(v - refunded.get(k, Decimal(0))) for k, v in categories.items()
                },
                "latest_date": max([row["date"]] + [r["date"] for r in events]),
            }
        )
    return result


def order_raw(action, snapshot, identity, basic_raw):
    if action.kind in ("paid", "deferred"):
        entry = action.purchase
        if entry is None:
            raise LedgerError("下单需要完整购物内容")
        if action.kind == "deferred" and not entry.payment.startswith("Liabilities:"):
            raise LedgerError("挂账下单必须选择待付款负债账户")
        raw = basic_raw(entry)
        head, body = raw.split("\n", 1)
        return (
            f"{head}\n  order-id: {quote(identity)}\n  order-action: {quote(action.kind)}\n{body}"
        )
    source = next((r for r in orders(snapshot) if r["id"] == action.source_id), None)
    if source is None:
        raise LedgerError("关联订单已变化，请重新选择并确认")
    if str(action.date) < source["latest_date"]:
        raise LedgerError("处理日期不能早于下单或已有结算退款日期")
    total, refunded = Decimal(source["total"]), Decimal(source["refunded"])
    if action.kind in ("settle", "refund_unpaid"):
        if source["mode"] == "paid" or not source["account"].startswith("Liabilities:"):
            raise LedgerError("该订单不属于待付款负债")
        if action.amount > Decimal(source["unpaid"]):
            raise LedgerError("金额超过未结清负债")
    if action.kind.startswith("refund"):
        if action.amount > total - refunded:
            raise LedgerError("退款超过原订单剩余金额")
        if action.category not in source["categories"] or action.amount > Decimal(
            source["categories"][action.category]
        ):
            raise LedgerError("退款必须沿用原费用类别且不能超过该类别剩余金额")
    if action.kind == "refund_paid":
        available = (
            source["paid_available"]
            if source["mode"] == "deferred" or Decimal(source["settled"])
            else source["direct_available"]
        )
        if action.amount > Decimal(available):
            raise LedgerError("退款超过已付款金额；未结算部分请选择负债冲回")
    currency, amount = source["currency"], action.amount
    labels = {
        "settle": "确认收货结算",
        "refund_paid": "已付款退款",
        "refund_unpaid": "未结算负债冲回",
    }
    raw = (
        f"{action.date} * {quote(source['payee'])} {quote(labels[action.kind])}\n"
        f"  order-ref: {quote(source['key'])}\n  order-action: {quote(action.kind)}\n"
        f"  order-amount: {amount:f}\n  memo: {quote(action.note)}\n"
    )
    if action.kind == "settle":
        if action.account == source["account"]:
            raise LedgerError("结算账户不能与待付款账户相同")
        return (
            raw
            + f"  {source['account']} {amount:f} {currency}\n"
            + f"  {action.account} {-amount:f} {currency}\n"
        )
    target = source["account"] if action.kind == "refund_unpaid" else action.account
    return raw + f"  {action.category} {-amount:f} {currency}\n  {target} {amount:f} {currency}\n"
