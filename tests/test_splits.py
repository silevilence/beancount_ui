import pytest
from beancount_ui.ledger import LedgerError
from beancount_ui.models import EntryInput
from beancount_ui.query import transactions
from beancount_ui.writer import Writer
from test_writer import mutation


def test_split_discount_memos_edit_roundtrip(ledger):
    request = mutation(ledger)
    values = request.entry.model_dump(mode="json")
    values.update(
        amount="28.00",
        splits=[
            {"category": "Expenses:Food", "amount": "20", "note": "蔬菜"},
            {"category": "Expenses:Phone", "amount": "10", "note": "配件"},
            {"category": "Expenses:Discount", "amount": "-2", "note": "优惠券"},
        ],
    )
    request.entry = EntryInput.model_validate(values)
    writer = Writer(ledger)
    preview = writer.preview(request)
    writer.commit(preview["request_id"])
    row = next(r for r in transactions(ledger.refresh()) if r["payee"] == "测试商户")
    assert not row["simple"]
    assert [p["amount"] for p in row["postings"]] == ["20", "10", "-2", "-28.00"]
    assert '    memo: "蔬菜"' in row["raw"] and '    memo: "优惠券"' in row["raw"]
    edited = row["raw"].replace("配件", "配件更正")
    writer.commit(
        writer.preview(
            mutation(ledger, operation="edit", transaction_id=row["id"], entry=None, raw=edited)
        )["request_id"]
    )
    assert (
        'memo: "配件更正"'
        in next(r for r in transactions(ledger.refresh()) if r["payee"] == "测试商户")["raw"]
    )
    request = mutation(ledger)
    values["amount"] = "26"
    request.entry = EntryInput.model_validate(values)
    with pytest.raises(LedgerError, match="合计"):
        writer.preview(request)
