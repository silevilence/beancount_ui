from datetime import date
from decimal import Decimal

import pytest
from beancount_ui.ledger import LedgerError, read_files
from beancount_ui.models import OrderInput
from beancount_ui.orders import orders
from beancount_ui.query import daily_view, transactions
from beancount_ui.writer import Writer
from test_writer import mutation


def purchase(ledger, mode="deferred"):
    request = mutation(ledger)
    entry = request.entry.model_dump(mode="json")
    entry.update(amount="100", payment="Liabilities:Card", payee="淘宝")
    action = {
        "kind": mode,
        "purchase": entry,
        "date": entry["date"],
        "amount": "100",
        "account": entry["payment"],
    }
    request.entry = None
    request.order = OrderInput.model_validate(action)
    writer = Writer(ledger)
    writer.commit(writer.preview(request)["request_id"])
    return next(r for r in orders(ledger.refresh()) if r["payee"] == "淘宝")


def process(ledger, source, kind, amount):
    request = mutation(ledger, entry=None)
    request.order = OrderInput.model_validate(
        {
            "kind": kind,
            "source_id": source["id"],
            "date": "2026-09-30",
            "amount": amount,
            "account": "Assets:Cash",
            "category": "Expenses:Food",
        }
    )
    writer = Writer(ledger)
    return writer.commit(writer.preview(request)["request_id"])


def test_partial_then_remaining_settlement_no_extra_expense(ledger):
    row = purchase(ledger)
    expenses = daily_view(ledger, date(2026, 9, 30))["expenses"]
    process(ledger, row, "settle", "30")
    assert (
        Decimal(next(r for r in orders(ledger.refresh()) if r["id"] == row["id"])["unpaid"]) == 70
    )
    process(ledger, row, "settle", "70")
    assert daily_view(ledger, date(2026, 9, 30))["expenses"] == expenses
    with pytest.raises(LedgerError, match="未结清"):
        process(ledger, row, "settle", "1")
    process(ledger, row, "refund_paid", "20")
    assert Decimal(daily_view(ledger, date(2026, 9, 30))["expenses"]["CNY"]) == Decimal("105.50")


def test_order_details_include_original_memo_and_source(ledger):
    row = purchase(ledger)
    assert row["note"] == "备注"
    assert row["file"] == "txs/2026/09.bean"
    assert row["line"] > 0
    assert row["identified"]
    assert 'memo: "备注"' in row["raw"]
    assert "Expenses:Food" in row["raw"]


@pytest.mark.parametrize("transaction_note", ["", '  memo: "订单总备注"\n'])
def test_historical_order_details_include_posting_memo(ledger, transaction_note):
    path = ledger.settings.ledger_dir / "txs/2026/08.bean"
    with path.open("a", encoding="utf-8") as stream:
        stream.write(
            '\n2026-09-27 * "淘宝" "88VIP每日红包"\n'
            + transaction_note
            + "  Expenses:Food 10 CNY\n"
            '    memo: "发带"\n'
            "  Expenses:Food 2 CNY\n"
            '    memo: "配件"\n'
            "  Liabilities:Card -12 CNY\n"
        )
    before = read_files(ledger.settings.ledger_dir)
    snapshot = ledger.refresh()
    assert not snapshot.errors
    row = next(r for r in orders(snapshot) if r["narration"] == "88VIP每日红包")
    assert row["note"] == (
        ("订单总备注\n" if transaction_note else "") + "Expenses:Food：发带\nExpenses:Food：配件"
    )
    transaction = next(r for r in transactions(snapshot) if r["id"] == row["id"])
    assert transaction["note"] == ("订单总备注" if transaction_note else "")
    assert 'memo: "发带"' in row["raw"]
    assert read_files(ledger.settings.ledger_dir) == before


def test_settlement_uses_selected_processing_date(ledger):
    row = purchase(ledger)
    request = mutation(ledger, entry=None)
    request.order = OrderInput.model_validate(
        {
            "kind": "settle",
            "source_id": row["id"],
            "date": "2026-10-02",
            "amount": "12",
            "account": "Assets:Cash",
        }
    )
    writer = Writer(ledger)
    writer.commit(writer.preview(request)["request_id"])
    settlement = next(
        r for r in transactions(ledger.refresh()) if r["metadata"].get("order-action") == "settle"
    )
    assert settlement["date"] == "2026-10-02"
    assert settlement["raw"].startswith("2026-10-02")


def test_unpaid_refund_and_direct_paid_refund(ledger):
    row = purchase(ledger)
    before = read_files(ledger.settings.ledger_dir)
    with pytest.raises(LedgerError, match="已付款"):
        process(ledger, row, "refund_paid", "10")
    assert read_files(ledger.settings.ledger_dir) == before
    process(ledger, row, "refund_unpaid", "25")
    process(ledger, row, "settle", "75")
    assert Decimal(next(r for r in orders(ledger.refresh()) if r["id"] == row["id"])["unpaid"]) == 0
    paid = purchase(ledger, "paid")
    paid = next(r for r in orders(ledger.refresh()) if r["mode"] == "paid")
    process(ledger, paid, "refund_paid", "100")
    with pytest.raises(LedgerError):
        process(ledger, paid, "settle", "1")
