from uuid import uuid4

import pytest
from beancount_ui.ledger import LedgerError, read_files
from beancount_ui.models import Mutation
from beancount_ui.query import transactions
from beancount_ui.writer import Writer


def edit_request(ledger, row, **kwargs):
    return Mutation.model_validate(
        {
            "request_id": str(uuid4()),
            "revision": ledger.refresh().revision,
            "operation": "edit",
            "transaction_id": row["id"],
            "raw": row["raw"],
            **kwargs,
        }
    )


def test_edit_and_delete_keep_location_metadata_and_neighbors(ledger):
    writer = Writer(ledger)
    row = next(r for r in transactions(ledger.refresh()) if r["narration"] == "午饭")
    before = read_files(ledger.settings.ledger_dir)
    request = edit_request(
        ledger,
        row,
        raw=None,
        entry={
            "date": "2026-10-01",
            "payee": "新商户",
            "narration": "改后",
            "amount": "30.10",
            "currency": "CNY",
            "category": "Expenses:Food",
            "payment": "Assets:Cash",
            "note": "交易备注",
        },
    )
    preview = writer.preview(request)
    assert set(preview["diffs"]) == {"txs/2026/08.bean"}
    writer.commit(preview["request_id"])
    rows = transactions(ledger.refresh())
    changed = next(r for r in rows if r["narration"] == "改后")
    assert changed["file"] == row["file"] and changed["date"] == "2026-10-01"
    assert "工作日套餐" in changed["raw"] and "交易备注" in changed["raw"]
    assert changed["postings"][0]["amount"] == "30.10"
    for name, content in before.items():
        if name != row["file"]:
            assert (ledger.settings.ledger_dir / name).read_bytes() == content
    preview = writer.preview(edit_request(ledger, changed, operation="delete", raw=None))
    writer.commit(preview["request_id"])
    writer.commit(preview["request_id"])
    assert not any(r["narration"] == "改后" for r in transactions(ledger.refresh()))
    assert not ledger.refresh().errors


def test_complex_raw_roundtrip_no_loss_and_invalid_edit(ledger):
    writer = Writer(ledger)
    row = next(r for r in transactions(ledger.refresh()) if r["narration"] == "证券成本")
    before = read_files(ledger.settings.ledger_dir)
    preview = writer.preview(edit_request(ledger, row))
    assert preview["diffs"] == {}
    writer.commit(preview["request_id"])
    assert before == read_files(ledger.settings.ledger_dir)
    with pytest.raises(LedgerError, match="高级编辑"):
        writer.preview(
            edit_request(
                ledger,
                row,
                raw=None,
                entry={
                    "date": "2026-08-21",
                    "amount": "10",
                    "category": "Expenses:Food",
                    "payment": "Assets:Cash",
                },
            )
        )
    with pytest.raises(LedgerError):
        writer.preview(edit_request(ledger, row, raw=row["raw"].replace("-10 USD", "-11 USD")))
    assert before == read_files(ledger.settings.ledger_dir)


def test_readonly_and_unknown_record(ledger):
    writer = Writer(ledger)
    row = next(r for r in transactions(ledger.refresh()) if r["readonly"])
    with pytest.raises(LedgerError, match="只读"):
        writer.preview(edit_request(ledger, row, operation="delete", raw=None))
    with pytest.raises(LedgerError, match="不存在"):
        writer.preview(edit_request(ledger, row, transaction_id="missing"))
