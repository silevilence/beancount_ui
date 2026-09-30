from datetime import date

from beancount_ui.app import create_app
from beancount_ui.templates import recommendations
from fastapi.testclient import TestClient


def test_templates_no_historical_amount_date_and_closed_accounts(ledger):
    rows = recommendations(ledger.refresh(), date(2026, 9, 30))
    assert {r["business"] for r in rows} >= {"ordinary", "salary", "yuebao"}
    assert all("amount" not in r and "date" not in r for r in rows)
    path = ledger.settings.ledger_dir / "gnucash/gnucash.beancount"
    path.write_bytes(path.read_bytes() + b"\n2026-10-01 close Expenses:Food\n")
    rows = TestClient(create_app(ledger.settings)).get("/api/templates?day=2026-10-02").json()
    assert next(r for r in rows if r["narration"] == "午饭")["category"] == ""
