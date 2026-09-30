from datetime import date

import pytest
from beancount_ui.app import create_app
from beancount_ui.ledger import LedgerError, read_files
from beancount_ui.models import OrderInput
from beancount_ui.orders import orders
from beancount_ui.query import transactions
from beancount_ui.writer import Writer
from fastapi.testclient import TestClient
from test_orders import process, purchase
from test_writer import mutation


def test_external_order_metadata_is_diagnosable(ledger):
    row = purchase(ledger)
    process(ledger, row, "settle", "1")
    path = ledger.settings.ledger_dir / "txs/2026/09.bean"
    path.write_text(
        path.read_text(encoding="utf-8").replace("order-amount: 1", 'order-amount: "bad"'),
        encoding="utf-8",
    )
    with pytest.raises(LedgerError, match="元数据无效"):
        orders(ledger.refresh())


def test_order_correction_cannot_orphan_refunds(ledger):
    row = purchase(ledger)
    process(ledger, row, "settle", "100")
    process(ledger, row, "refund_paid", "20")
    writer = Writer(ledger)
    before = read_files(ledger.settings.ledger_dir)
    with pytest.raises(LedgerError, match="已有结算"):
        writer.preview(mutation(ledger, operation="delete", transaction_id=row["id"], entry=None))
    settlement = next(
        r for r in transactions(ledger.refresh()) if r["metadata"].get("order-action") == "settle"
    )
    with pytest.raises(LedgerError, match="先撤销退款"):
        writer.preview(
            mutation(ledger, operation="delete", transaction_id=settlement["id"], entry=None)
        )
    with pytest.raises(LedgerError, match="删除后重新选择"):
        writer.preview(
            mutation(
                ledger,
                operation="edit",
                transaction_id=settlement["id"],
                entry=None,
                raw=settlement["raw"].replace("100", "90"),
            )
        )
    assert read_files(ledger.settings.ledger_dir) == before


def test_api_business_endpoints_and_error_paths(ledger):
    client = TestClient(create_app(ledger.settings))
    assert client.get("/api/orders").status_code == 200
    assert len(client.get("/api/income/days?start=2026-09-24&end=2026-09-30").json()) == 7
    assert client.get("/api/income/days?start=2026-09-30&end=2026-09-24").status_code == 409
    base = {
        "kind": "transfer",
        "date": "2026-09-30",
        "account": "Assets:Cash",
        "target": "Assets:Bank",
        "amount": "1",
        "fee": "0",
    }
    assert client.post("/api/finance/compose", json=base).status_code == 200
    for change in [
        {"account": "Assets:Missing"},
        {"target": "Assets:Cash"},
        {"amount": "0"},
        {"target": "Income:Salary"},
        {"kind": "repayment"},
        {"fee": "1", "fee_account": "Income:Salary"},
    ]:
        assert client.post("/api/finance/compose", json={**base, **change}).status_code == 409
    path = ledger.settings.ledger_dir / "main.beancount"
    path.write_bytes(path.read_bytes() + b"\ninvalid\n")
    for url in [
        "/api/orders",
        "/api/templates?day=2026-09-30",
        "/api/income/days?start=2026-09-29&end=2026-09-30",
    ]:
        assert client.get(url).status_code == 409
    assert client.post("/api/finance/compose", json=base).status_code == 409


def test_orders_reject_wrong_accounts_date_category_and_manual_metadata(ledger):
    row = purchase(ledger)
    writer = Writer(ledger)
    base = {
        "kind": "settle",
        "source_id": row["id"],
        "date": "2026-09-30",
        "amount": "1",
        "account": "Assets:Cash",
    }
    request = mutation(ledger, entry=None, operation="edit", transaction_id=row["id"])
    request.order = OrderInput.model_validate(base)
    with pytest.raises(LedgerError, match="只能创建"):
        writer.preview(request)
    for change in [
        {"source_id": "missing"},
        {"date": "2026-09-29"},
        {"account": "Liabilities:Card"},
        {"kind": "refund_unpaid", "category": "Expenses:Missing"},
    ]:
        request = mutation(ledger, entry=None)
        request.order = OrderInput.model_validate({**base, **change})
        with pytest.raises(LedgerError):
            writer.preview(request)
    raw = (
        '2026-10-01 * "manual"\n  order-ref: "fake"\n  Expenses:Food 1 CNY\n  Assets:Cash -1 CNY\n'
    )
    with pytest.raises(LedgerError, match="元数据"):
        writer.preview(mutation(ledger, entry=None, raw=raw))


def test_income_edit_duplicate_and_order_metadata_immutable(ledger):
    writer = Writer(ledger)
    raw = '2026-10-01 * "收益"\n  Assets:Yuebao 1 CNY\n  Income:Interest\n'
    writer.commit(
        writer.preview(mutation(ledger, entry=None, raw=raw, business="yuebao"))["request_id"]
    )
    row = next(
        r
        for r in transactions(ledger.refresh())
        if r["file"].endswith("yuebao.bean") and r["date"] == str(date(2026, 10, 1))
    )
    with pytest.raises(LedgerError, match="已有余额宝"):
        writer.preview(
            mutation(
                ledger,
                entry=None,
                operation="edit",
                transaction_id=row["id"],
                raw=raw.replace("2026-10-01", "2026-09-30"),
            )
        )
    order = purchase(ledger)
    original = next(r for r in transactions(ledger.refresh()) if r["id"] == order["id"])
    with pytest.raises(LedgerError, match="元数据"):
        writer.preview(
            mutation(
                ledger,
                entry=None,
                operation="edit",
                transaction_id=order["id"],
                raw=original["raw"].replace('"deferred"', '"paid"'),
            )
        )
