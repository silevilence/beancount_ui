from beancount_ui.query import transactions
from beancount_ui.writer import Writer
from test_writer import mutation


def test_advanced_semantics_and_unchanged_raw(ledger):
    raw = """2026-10-01 * "海外" "复杂样例" #sample ^receipt
  memo: "交易备注"
  receipt: "R-1"
  Expenses:Online 100 JPY @@ 5 CNY
    memo: "外币商品"
  Expenses:Discount -1 CNY
    memo: "优惠"
  Assets:Cash
  Equity:Opening 2 CNY
  Equity:Opening -2 CNY
"""
    writer = Writer(ledger)
    result = writer.preview(mutation(ledger, entry=None, raw=raw))
    writer.commit(result["request_id"])
    row = next(r for r in transactions(ledger.refresh()) if r["payee"] == "海外")
    assert not row["simple"] and row["raw"] == raw
    same = writer.preview(
        mutation(ledger, entry=None, operation="edit", transaction_id=row["id"], raw=row["raw"])
    )
    assert same["diffs"] == {}
    writer.commit(same["request_id"])
    updated = raw.replace("交易备注", "补充备注")
    writer.commit(
        writer.preview(
            mutation(ledger, entry=None, operation="edit", transaction_id=row["id"], raw=updated)
        )["request_id"]
    )
    row = next(r for r in transactions(ledger.refresh()) if r["payee"] == "海外")
    assert "@@ 5 CNY" in row["raw"] and "Assets:Cash\n" in row["raw"]
    zero = '2026-10-02 * "零值"\n  Expenses:Food 0 CNY\n  Assets:Cash 0 CNY\n'
    preview = writer.preview(mutation(ledger, entry=None, raw=zero))
    assert "零金额" in preview["warnings"][0]
    writer.commit(preview["request_id"])
    assert (
        next(r for r in transactions(ledger.refresh()) if r["narration"] == "零值")["postings"][0][
            "amount"
        ]
        == "0"
    )
