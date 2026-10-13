from datetime import date
from decimal import Decimal

import pytest
from beancount_ui.app import create_app
from beancount_ui.query import daily_view
from beancount_ui.statistics import periods, statistics, statistics_details
from fastapi.testclient import TestClient


@pytest.fixture
def report_ledger(ledger):
    root = ledger.settings.ledger_dir
    (root / "main.beancount").write_text(
        """option "operating_currency" "CNY"
include "reports.bean"
2020-01-01 open Assets:Cash
2020-01-01 open Liabilities:Card
2020-01-01 open Expenses:Food
2020-01-01 open Expenses:Food:Lunch
2020-01-01 open Expenses:Discount
2020-01-01 open Expenses:Fee
2020-01-01 open Income:Salary
2020-01-01 open Income:Interest
2020-01-01 open Equity:Budget
""",
        encoding="utf-8",
    )
    (root / "reports.bean").write_text(
        """2025-12-31 * "商户" "跨年待付款"
  Expenses:Food 100 CNY
  Liabilities:Card -100 CNY
2026-01-01 * "工资"
  Assets:Cash 1000.12 CNY
  Income:Salary
2026-01-02 * "结算与手续费"
  Liabilities:Card 100 CNY
  Expenses:Fee 2 CNY
  Assets:Cash -102 CNY
2026-01-03 * "退款"
  Expenses:Food -20 CNY
  Assets:Cash 20 CNY
2026-01-04 * "多分类与预算"
  Expenses:Food 10 CNY
  Expenses:Food 5 CNY
  Expenses:Food:Lunch 8 CNY
  Expenses:Discount -3 CNY
  Assets:Cash -20 CNY
  Equity:Budget 20 CNY
  Equity:Budget -20 CNY
2026-01-05 * "仅还款"
  Liabilities:Card 50 CNY
  Assets:Cash -50 CNY
2026-01-06 * "收入冲回"
  Income:Salary 100 CNY
  Assets:Cash -100 CNY
2026-01-06 * "收益"
  Income:Interest -0.123456789 CNY
  Assets:Cash
2026-01-07 * "外币费用"
  Expenses:Food 100 JPY @ 0.05 CNY
  Assets:Cash -5 CNY
2026-02-01 * "后月"
  Expenses:Food 7 CNY
  Assets:Cash -7 CNY
""",
        encoding="utf-8",
    )
    (root / "unreferenced.bean").write_text(
        """2026-01-01 * "不应计入"
  Expenses:Food 999 CNY
  Assets:Cash -999 CNY
""",
        encoding="utf-8",
    )
    assert not ledger.refresh().errors
    return ledger


@pytest.mark.parametrize("grain", ["day", "week", "month"])
def test_report_totals_and_contributions(report_ledger, grain):
    report = statistics(report_ledger, date(2025, 12, 31), date(2026, 1, 31), grain)
    assert report["available"] and not report["stale"]
    assert report["currencies"] == ["CNY", "JPY"]
    assert report["currency"] == "CNY"
    assert report["totals"] == {
        "income": "900.243456789",
        "expenses": "102",
        "net": "798.243456789",
    }
    assert report["count"] == 7
    for kind, total in report["totals"].items():
        assert sum(Decimal(b[kind]) for b in report["buckets"]) == Decimal(total)
    details = statistics_details(
        report_ledger,
        date(2025, 12, 31),
        date(2026, 1, 31),
        "CNY",
        report["view_revision"],
    )
    assert len(details["transactions"]) == 7
    assert all(row["raw"] and row["file"] == "reports.bean" for row in details["transactions"])
    for kind, total in report["totals"].items():
        assert sum(Decimal(r[kind]) for r in details["transactions"]) == Decimal(total)


def test_daily_agrees_and_foreign_units_not_payment_value(report_ledger):
    report = statistics(report_ledger, date(2026, 1, 1), date(2026, 1, 7), "day")
    for bucket in report["buckets"]:
        daily = daily_view(report_ledger, date.fromisoformat(bucket["start"]))
        for kind in ("income", "expenses"):
            assert Decimal(bucket[kind]) == Decimal(daily[kind].get("CNY", "0"))
    foreign = statistics(report_ledger, date(2026, 1, 1), date(2026, 1, 31), "week", "JPY")
    assert foreign["totals"] == {"income": "0", "expenses": "100", "net": "-100"}
    assert foreign["count"] == 1
    refund = statistics(report_ledger, date(2026, 1, 3), date(2026, 1, 3), "day")
    assert refund["totals"] == {"income": "0", "expenses": "-20", "net": "20"}


@pytest.mark.parametrize(
    ("start", "end", "grain", "expected"),
    [
        (
            "2025-12-31",
            "2026-01-06",
            "week",
            [
                ("2025-12-29", "2025-12-31", "2026-01-04"),
                ("2026-01-05", "2026-01-05", "2026-01-06"),
            ],
        ),
        (
            "2024-02-28",
            "2024-03-01",
            "month",
            [
                ("2024-02-01", "2024-02-28", "2024-02-29"),
                ("2024-03-01", "2024-03-01", "2024-03-01"),
            ],
        ),
        ("9999-12-31", "9999-12-31", "week", [("9999-12-27", "9999-12-31", "9999-12-31")]),
        ("0001-01-01", "0001-01-01", "day", [("0001-01-01", "0001-01-01", "0001-01-01")]),
    ],
)
def test_period_boundaries(start, end, grain, expected):
    assert periods(date.fromisoformat(start), date.fromisoformat(end), grain) == expected


def test_empty_periods_and_invalid_queries(report_ledger):
    report = statistics(report_ledger, date(2026, 3, 1), date(2026, 3, 3), "day")
    assert len(report["buckets"]) == 3 and report["count"] == 0
    assert all(b["net"] == "0" and b["count"] == 0 for b in report["buckets"])
    client = TestClient(create_app(report_ledger.settings))
    for params in [
        {"start": "2026-01-02", "end": "2026-01-01"},
        {"start": "bad", "end": "2026-01-01"},
        {"start": "2026-01-01", "end": "2026-01-02", "grain": "year"},
        {"start": "2026-01-01", "end": "2026-01-02", "currency": "USD"},
        {"start": "2000-01-01", "end": "2026-01-01"},
    ]:
        assert client.get("/api/statistics", params=params).status_code == 422
    with pytest.raises(ValueError, match="粒度"):
        periods(date(2026, 1, 1), date(2026, 1, 1), "year")


def test_refresh_stale_and_detail_revision(report_ledger):
    client = TestClient(create_app(report_ledger.settings))
    query = {"start": "2026-01-01", "end": "2026-01-31", "grain": "month"}
    original = client.get("/api/statistics", params=query).json()
    path = report_ledger.settings.ledger_dir / "reports.bean"
    path.write_text(
        path.read_text(encoding="utf-8").replace("1000.12", "2000.12"), encoding="utf-8"
    )
    changed = client.get("/api/statistics", params=query).json()
    assert changed["view_revision"] != original["view_revision"]
    details = {
        "start": query["start"],
        "end": query["end"],
        "currency": "CNY",
        "revision": original["view_revision"],
    }
    assert client.get("/api/statistics/details", params=details).status_code == 409
    path.write_text(
        path.read_text(encoding="utf-8") + '\n2026-01-01 * "broken"\n  Assets:Missing 1 CNY\n',
        encoding="utf-8",
    )
    stale = client.get("/api/statistics", params=query).json()
    assert stale["stale"] and stale["available"] and stale["errors"]
    assert stale["totals"] == changed["totals"]
    assert stale["view_revision"] == changed["view_revision"]
    details["revision"] = changed["view_revision"]
    response = client.get("/api/statistics/details", params=details).json()
    assert response["stale"] and response["transactions"]
    invalid = (
        TestClient(create_app(report_ledger.settings)).get("/api/statistics", params=query).json()
    )
    assert invalid["stale"] and not invalid["available"] and invalid["count"] == 0


def test_empty_ledger_and_missing_operating_currency(report_ledger):
    path = report_ledger.settings.ledger_dir / "main.beancount"
    path.write_text("", encoding="utf-8")
    report = statistics(report_ledger, date(2026, 1, 1), date(2026, 1, 1), "day")
    assert report["available"] and report["currency"] == "" and report["currencies"] == []
