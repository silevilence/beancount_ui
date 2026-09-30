from datetime import date

import pytest
from beancount_ui.finance import FinanceInput, compose_finance
from beancount_ui.ledger import LedgerError, read_files
from beancount_ui.query import daily_view
from beancount_ui.writer import Writer
from test_writer import mutation


def finance(ledger, **overrides):
    return compose_finance(
        ledger.refresh(),
        FinanceInput.model_validate(
            {
                "kind": "repayment",
                "date": "2026-09-30",
                "account": "Assets:Cash",
                "target": "Liabilities:Card",
                "amount": "20",
                "fee": "1",
                "fee_account": "Expenses:Food",
                **overrides,
            }
        ),
    )


def test_repayment_fee_and_balance_boundary(ledger):
    writer = Writer(ledger)
    result = finance(ledger)
    preview = writer.preview(mutation(ledger, entry=None, **result))
    writer.commit(preview["request_id"])
    assert daily_view(ledger, date(2026, 9, 30))["expenses"] == {"CNY": "26.50"}
    before = finance(ledger, kind="balance", date="2026-09-30", amount="0")
    after = finance(ledger, kind="balance", date="2026-10-01", amount="0")
    assert before["actual"] != after["actual"]
    wrong = mutation(ledger, entry=None, business="balance", raw=after["raw"])
    files = read_files(ledger.settings.ledger_dir)
    with pytest.raises(LedgerError, match="Balance failed"):
        writer.preview(wrong)
    assert read_files(ledger.settings.ledger_dir) == files
    correct = finance(ledger, kind="balance", date="2026-10-01", amount=after["actual"])
    writer.commit(
        writer.preview(mutation(ledger, entry=None, business="balance", raw=correct["raw"]))[
            "request_id"
        ]
    )
    assert b"pad" not in (ledger.settings.ledger_dir / "txs/category/balance.bean").read_bytes()
    assert not ledger.refresh().errors
