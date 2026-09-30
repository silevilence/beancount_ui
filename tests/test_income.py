from datetime import date
from uuid import uuid4

import pytest
from beancount_ui.income import income_days
from beancount_ui.ledger import LedgerError, read_files
from beancount_ui.models import BatchMutation
from beancount_ui.query import daily_view
from beancount_ui.writer import Writer


def test_week_gaps_no_duplicate_and_category_route(ledger):
    days = income_days(ledger.refresh(), date(2026, 9, 24), date(2026, 9, 30))
    assert len(days) == 7 and len(days[-1]["records"]) == 1
    items = [
        {
            "business": "yuebao",
            "raw": f'{row["date"]} * "补录收益"\n  Assets:Yuebao 0.01 CNY\n  Income:Interest\n',
        }
        for row in days
    ]
    request = BatchMutation(request_id=uuid4(), revision=ledger.refresh().revision, items=items)
    before = read_files(ledger.settings.ledger_dir)
    writer = Writer(ledger)
    with pytest.raises(LedgerError, match="第 7 笔.*已有"):
        writer.preview(request)
    assert read_files(ledger.settings.ledger_dir) == before
    request.items.pop()
    preview = writer.preview(request)
    assert set(preview["diffs"]) == {"txs/category/yuebao.bean"}
    writer.commit(preview["request_id"])
    for day in range(24, 30):
        assert daily_view(ledger, date(2026, 9, day))["income"] == {"CNY": "0.01"}
    assert all(
        len(r["records"]) == 1
        for r in income_days(ledger.refresh(), date(2026, 9, 24), date(2026, 9, 30))
    )
