"""Representative large-ledger feedback loop; no private ledger data required."""

from time import perf_counter
from uuid import uuid4

import pytest
from beancount.core import data
from beancount_ui.app import create_app
from fastapi.testclient import TestClient


def test_order_validation_indexes_references_once(ledger):
    from beancount_ui.orders import validate_order_totals
    from beancount_ui.query import transactions

    class CountedMetadata(dict):
        reads = 0

        def get(self, key, default=None):
            if key == "order-ref":
                CountedMetadata.reads += 1
            return super().get(key, default)

    snapshot = ledger.refresh()
    base = next(r for r in transactions(snapshot) if r["simple"])
    snapshot.records = [{**base, "id": str(i), "metadata": CountedMetadata()} for i in range(200)]
    validate_order_totals(snapshot)
    assert CountedMetadata.reads <= 400


def test_loaded_transactions_do_not_reparse_each_source(ledger, monkeypatch):
    from beancount.parser import parser
    from beancount_ui.query import transactions

    snapshot = ledger.refresh()
    assert any(isinstance(e, data.Transaction) for e in snapshot.entries)

    def reparse(*args, **kwargs):
        raise AssertionError("already validated transaction parsed again")

    monkeypatch.setattr(parser, "parse_string", reparse)
    assert any(row["posting_form"] for row in transactions(snapshot))


@pytest.mark.parametrize("batch", [False, True], ids=["single", "backfill"])
def test_large_ledger_preview_and_save(ledger, batch):
    root = ledger.settings.ledger_dir
    # Historical imports contain thousands of directives in one source file.
    with (root / "main.beancount").open("a", encoding="utf-8") as stream:
        stream.write('\ninclude "history.bean"\n')
    (root / "history.bean").write_text(
        '2026-01-01 * "sample"\n  Expenses:Food 1 CNY\n  Assets:Cash -1 CNY\n' * 13000,
        encoding="utf-8",
    )
    with TestClient(create_app(ledger.settings)) as client:
        initial = client.get("/api/journal?day=2026-10-05")
        assert initial.status_code == 200
        request = {
            "request_id": str(uuid4()),
            "revision": initial.json()["revision"],
            "entry": {
                "date": "2026-10-05",
                "payee": "Timing",
                "narration": "sample",
                "amount": "1",
                "currency": "CNY",
                "category": "Expenses:Food",
                "payment": "Assets:Cash",
            },
        }
        started = perf_counter()
        payload = (
            {
                "request_id": request["request_id"],
                "revision": request["revision"],
                "items": [{"entry": request["entry"]}],
            }
            if batch
            else request
        )
        preview = client.post("/api/batch/preview" if batch else "/api/preview", json=payload)
        preview_time = perf_counter() - started
        assert preview.status_code == 200, preview.text
        started = perf_counter()
        saved = client.post("/api/commit", json={"request_id": request["request_id"]})
        commit_time = perf_counter() - started
        assert saved.status_code == 200, saved.text
        started = perf_counter()
        view = client.get("/api/journal?day=2026-10-05")
        refresh_time = perf_counter() - started
        assert view.status_code == 200
        assert len(view.json()["transactions"]) == 1
        print(
            f"{'backfill' if batch else 'single'}: preview={preview_time:.3f}s "
            f"commit={commit_time:.3f}s refresh={refresh_time:.3f}s"
        )
        # Broad wall-clock ceiling tolerates coverage/CI overhead; the operation
        # count and no-reparse tests above provide deterministic regression gates.
        assert preview_time < 10, "preview should not take tens of seconds"
        assert refresh_time < 10, "save refresh should not take tens of seconds"
