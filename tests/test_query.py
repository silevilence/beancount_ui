from datetime import date

from beancount_ui.query import daily_view, transactions


def test_daily_aggregation_and_filters(ledger):
    view = daily_view(ledger, date(2026, 9, 30))
    assert len(view["transactions"]) == 4
    assert view["expenses"] == {"CNY": "25.50"}
    assert view["income"] == {"CNY": "100.12"}
    assert len(daily_view(ledger, date(2026, 9, 30), payee="食堂")["transactions"]) == 1
    assert len(daily_view(ledger, date(2026, 9, 30), narration="收益")["transactions"]) == 1
    assert len(daily_view(ledger, date(2026, 9, 30), account="Yuebao")["transactions"]) == 1
    assert daily_view(ledger)["date"]


def test_external_change_and_stale_view(ledger):
    original = daily_view(ledger, date(2026, 9, 30))
    path = ledger.settings.ledger_dir / "txs/2026/08.bean"
    path.write_bytes(path.read_bytes().replace(b"25.50", b"35.50"))
    changed = daily_view(ledger, date(2026, 9, 30))
    assert changed["expenses"] == {"CNY": "35.50"}
    assert changed["revision"] != original["revision"]
    path.write_bytes(path.read_bytes() + b'\n2026-09-30 * "broken"\n  Assets:Missing 1 CNY\n')
    stale = daily_view(ledger, date(2026, 9, 30))
    assert stale["stale"] and stale["errors"]
    assert stale["view_revision"] == changed["revision"]
    assert stale["expenses"] == changed["expenses"]


def test_identity_not_line_number_and_complex_flag(ledger):
    rows = transactions(ledger.refresh())
    path = ledger.settings.ledger_dir / "txs/2026/08.bean"
    path.write_bytes(b"; inserted comment\n" + path.read_bytes())
    after = transactions(ledger.refresh())
    assert [r["id"] for r in rows] == [r["id"] for r in after]
    assert not next(r for r in after if r["narration"] == "证券成本")["simple"]
    assert next(r for r in after if r["narration"] == "午饭")["simple"]


def test_account_close_date(ledger):
    path = ledger.settings.ledger_dir / "gnucash/gnucash.beancount"
    path.write_bytes(path.read_bytes() + b"\n2026-10-01 close Expenses:Food\n")
    assert "Expenses:Food" not in {
        a["name"] for a in daily_view(ledger, date(2026, 10, 1))["accounts"]
    }
