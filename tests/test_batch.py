from uuid import uuid4

import pytest
from beancount_ui.app import create_app
from beancount_ui.ledger import LedgerError, read_files
from beancount_ui.models import BatchMutation
from beancount_ui.query import transactions
from beancount_ui.writer import Writer
from fastapi.testclient import TestClient


def batch(ledger, count=10):
    return BatchMutation.model_validate(
        {
            "request_id": str(uuid4()),
            "revision": ledger.refresh().revision,
            "items": [
                {
                    "raw": f'2026-09-29 * "batch-{i}"\n'
                    "  Expenses:Food 0.10 CNY\n  Assets:Cash -0.10 CNY\n"
                }
                for i in range(count)
            ],
        }
    )


def test_atomic_invalid_batch_and_retry(ledger):
    writer = Writer(ledger)
    before = read_files(ledger.settings.ledger_dir)
    request = batch(ledger)
    request.items[7].raw = request.items[7].raw.replace("-0.10", "-0.20")
    with pytest.raises(LedgerError, match="第 8 笔"):
        writer.preview(request)
    assert read_files(ledger.settings.ledger_dir) == before
    request.items[7].raw = request.items[7].raw.replace("-0.20", "-0.10")
    preview = writer.preview(request)
    assert len(preview["items"]) == 10
    writer.commit(preview["request_id"])
    Writer(ledger).commit(preview["request_id"])
    rows = [r for r in transactions(ledger.refresh()) if r["narration"].startswith("batch-")]
    assert len(rows) == 10 and {r["date"] for r in rows} == {"2026-09-29"}


def test_batch_api_and_crash(ledger, monkeypatch):
    client = TestClient(create_app(ledger.settings))
    request = batch(ledger, 2)
    response = client.post("/api/batch/preview", json=request.model_dump(mode="json"))
    assert response.status_code == 200
    writer = Writer(ledger)
    original = writer.write_part

    def interrupted(*args):
        original(*args)
        raise SystemExit()

    monkeypatch.setattr(writer, "write_part", interrupted)
    with pytest.raises(SystemExit):
        writer.commit(str(request.request_id))
    assert Writer(ledger).commit(str(request.request_id))["status"] == "done"
    assert (
        len([r for r in transactions(ledger.refresh()) if r["narration"].startswith("batch-")]) == 2
    )


def test_batch_checks_balance_assertions_on_final_snapshot(ledger):
    path = ledger.settings.ledger_dir / "txs/category/balance.bean"
    path.write_bytes(b"2020-01-03 balance Assets:Bank 1000 CNY\n")
    request = batch(ledger, 2)
    request.items[0].raw = '2020-01-02 * "transfer"\n  Assets:Cash 1 CNY\n  Assets:Bank -1 CNY\n'
    request.items[1].raw = '2020-01-02 * "return"\n  Assets:Cash -1 CNY\n  Assets:Bank 1 CNY\n'
    writer = Writer(ledger)
    writer.commit(writer.preview(request)["request_id"])
    assert not ledger.refresh().errors


def test_batch_income_checks_earlier_items_before_writing(ledger):
    writer = Writer(ledger)
    request = batch(ledger, 4)
    for item in (request.items[0], request.items[3]):
        item.business = "yuebao"
        item.raw = '2026-09-29 * "yield"\n  Assets:Yuebao 0.01 CNY\n  Income:Interest\n'
    with pytest.raises(LedgerError, match="第 4 笔.*已有"):
        writer.preview(request)
    assert ledger.refresh().revision == request.revision


def test_later_transfer_cannot_hide_an_unused_pad_in_an_earlier_prefix(ledger):
    path = ledger.settings.ledger_dir / "txs/category/balance.bean"
    with path.open("a", encoding="utf-8") as stream:
        stream.write(
            "\n2020-01-01 pad Assets:Yuebao Equity:Opening\n"
            "2020-01-03 balance Assets:Yuebao 1 CNY\n"
        )
    request = batch(ledger, 2)
    for item, amount in zip(request.items, (1, -1), strict=True):
        item.raw = f'2020-01-02 * "transfer"\n  Assets:Yuebao {amount} CNY\n  Assets:Cash\n'
    with pytest.raises(LedgerError, match="第 1 笔"):
        Writer(ledger).preview(request)


def test_committing_an_older_preview_uses_its_own_snapshot(ledger):
    from test_orders import purchase

    purchase(ledger)
    writer = Writer(ledger)
    first, second = batch(ledger, 2), batch(ledger, 3)
    preview = writer.preview(first)
    writer.preview(second)
    assert ledger.refresh().revision == first.revision
    writer.commit(preview["request_id"])
    actual = ledger.refresh()
    assert actual.revision == preview["revision"]
    assert sum(r["narration"].startswith("batch-") for r in transactions(actual)) == 2
    with pytest.raises(LedgerError, match="预览后账本已被修改"):
        writer.commit(str(second.request_id))
