"""Representative multi-day release acceptance on the sanitized MyBill layout."""

from datetime import date
from decimal import Decimal
from runpy import run_path
from uuid import uuid4

from beancount_ui.app import create_app
from beancount_ui.finance import FinanceInput, compose_finance
from beancount_ui.ledger import Ledger, read_files
from beancount_ui.models import BatchMutation
from beancount_ui.query import daily_view, transactions
from beancount_ui.sync import Sync
from beancount_ui.writer import Writer
from conftest import git
from fastapi.testclient import TestClient
from test_orders import process, purchase
from test_sync import backup, connect
from test_writer import mutation


def test_container_gate_api_sequence_and_server_restart(sync):
    gate = run_path("scripts/container_smoke.py")
    with TestClient(create_app(sync.settings)) as client:
        request, journal = gate["prepare_requests"](client)
        assert journal["expenses"] == {"CNY": "44.10"}
    with TestClient(create_app(sync.settings)) as restarted:
        gate["recover_request"](restarted, request)


def test_multiday_month_boundary_business_totals_and_restart(sync):
    connect(sync)
    settings = sync.settings
    original = read_files(sync.root)
    changed = set()
    # A user returns on successive days; each day saves two entries and an actual yield.
    for day in [date(2026, 9, 28), date(2026, 9, 29), date(2026, 10, 1), date(2026, 10, 2)]:
        sync = Sync(Writer(Ledger(settings)))
        before = read_files(sync.root)
        items = [
            {
                "raw": f'{day} * "phase-four-{n}"\n'
                "  Expenses:Food 1.25 CNY\n  Assets:Cash -1.25 CNY\n"
            }
            for n in range(2)
        ] + [
            {
                "business": "yuebao",
                "raw": f'{day} * "actual yield"\n  Assets:Yuebao 0.02 CNY\n  Income:Interest\n',
            }
        ]
        p = sync.writer.preview(
            BatchMutation(
                request_id=uuid4(),
                revision=sync.ledger.refresh().revision,
                items=items,
            )
        )
        assert read_files(sync.root) == before
        changed.update(p["diffs"])
        sync.writer.commit(p["request_id"])
        # New application instance receives the same request after a lost response.
        Writer(Ledger(settings)).commit(p["request_id"])
        view = daily_view(sync.ledger, day)
        assert view["expenses"] == {"CNY": "2.50"}
        assert view["income"] == {"CNY": "0.02"}
        assert backup(sync)["sync"] == "已同步"

    ledger, writer = sync.ledger, sync.writer
    # Backfill into an older month plus salary, phone, foreign currency and multiple postings.
    items = [
        {"raw": '2026-08-20 * "backfill"\n  Expenses:Food 3 CNY\n  Assets:Cash -3 CNY\n'},
        {
            "business": "salary",
            "raw": '2026-10-02 * "salary"\n  Assets:Bank 100 CNY\n  Income:Salary\n',
        },
        {
            "business": "phone",
            "raw": '2026-10-02 * "phone"\n  Expenses:Phone 20 CNY\n  Assets:Cash -20 CNY\n',
        },
        {
            "raw": '2026-10-02 * "foreign split"\n  Expenses:Online 100 JPY @@ 5 CNY\n'
            "  Expenses:Discount -1 CNY\n  Assets:Cash -4 CNY\n"
        },
    ]
    p = writer.preview(
        BatchMutation(
            request_id=uuid4(),
            revision=ledger.refresh().revision,
            items=items,
        )
    )
    changed.update(p["diffs"])
    writer.commit(p["request_id"])
    view = daily_view(ledger, date(2026, 10, 2))
    assert {k: Decimal(v) for k, v in view["expenses"].items()} == {
        "CNY": Decimal("21.50"),
        "JPY": Decimal(100),
    }
    assert Decimal(view["income"]["CNY"]) == Decimal("100.02")
    # A purchase, partial settlement, unpaid reversal, final settlement and paid refund.
    order = purchase(ledger)
    process(ledger, order, "settle", "30")
    process(ledger, order, "refund_unpaid", "20")
    process(ledger, order, "settle", "50")
    process(ledger, order, "refund_paid", "10")
    changed.add("txs/2026/09.bean")
    assert Decimal(daily_view(ledger, date(2026, 9, 30))["expenses"]["CNY"]) == Decimal("95.50")
    # Balance assertions use the full snapshot and never invent a balancing transaction.
    balance = compose_finance(
        ledger.refresh(),
        FinanceInput(
            kind="balance",
            date=date(2026, 10, 3),
            account="Assets:Cash",
            amount="0",
        ),
    )
    balance = compose_finance(
        ledger.refresh(),
        FinanceInput(
            kind="balance",
            date=date(2026, 10, 3),
            account="Assets:Cash",
            amount=balance["actual"],
        ),
    )
    p = writer.preview(mutation(ledger, entry=None, business="balance", raw=balance["raw"]))
    changed.update(p["diffs"])
    writer.commit(p["request_id"])
    assert not Ledger(settings).refresh().errors
    assert backup(sync)["sync"] == "已同步"
    assert (
        len([r for r in transactions(ledger.refresh()) if r["narration"].startswith("phase-four-")])
        == 8
    )
    for name, content in original.items():
        if name not in changed:
            assert (sync.root / name).read_bytes() == content
    assert git(sync.root, "rev-parse", "HEAD") == git(
        git(sync.root, "remote", "get-url", "origin"),
        "rev-parse",
        "master-1",
    )
