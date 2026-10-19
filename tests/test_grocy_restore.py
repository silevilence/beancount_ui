"""Backups may predate a dispatch even when their local status says draft."""

from uuid import uuid4

import pytest
from beancount_ui.fulfillment import Fulfillment
from beancount_ui.fulfillment_models import ReceiptInput
from beancount_ui.grocy import Grocy
from beancount_ui.receipt_flow import ReceiptFlow
from beancount_ui.stock_operations import StockReconciler
from beancount_ui.writer import Writer
from test_manual_stock import manual as manual
from test_purchase_items import linked_purchase as linked_purchase
from test_stock_operations import operation as operation
from test_stock_reconciliation import remote_state


def test_new_outbox_checks_for_preexisting_remote_operation(operation, monkeypatch):
    service, doc = operation
    remote = remote_state(service, doc, monkeypatch)
    assert service.send(doc["id"])["status"] == "success"
    assert remote["posts"] == 0


def test_preview_only_backup_never_replays_delayed_receipt(ledger, linked_purchase, monkeypatch):
    request, _ = linked_purchase
    writer = Writer(ledger)
    writer.commit(writer.preview(request)["request_id"])
    order = Fulfillment(writer).list()[0]
    flow = ReceiptFlow(writer)
    preview = flow.preview(
        ReceiptInput(
            request_id=uuid4(),
            order_id=order["id"],
            received_date="2026-09-30",
            lines=[
                {
                    "item_id": order["items"][0]["id"],
                    "quantity": "1",
                    "location_id": 1,
                    "best_before_date": "2027-01-01",
                }
            ],
        )
    )
    reconciler = StockReconciler(writer)
    reconciler.start()
    reconciler.stop()
    calls = []

    def no_logs(self, path, method="GET", payload=None, **kwargs):
        calls.append(method)
        return []

    monkeypatch.setattr(Grocy, "request", no_logs)
    result = flow.commit(preview["request_id"])
    assert result["operations"][0]["status"] == "unknown"
    assert "POST" not in calls
    assert Fulfillment(writer).list()[0]["items"][0]["remaining"] == "1"


def test_restored_manual_draft_never_dispatches(manual):
    from beancount_ui.manual_stock import StockAction

    service, body, remote = manual
    p = service.preview(StockAction(**body))
    reconciler = StockReconciler(service.writer)
    reconciler.start()
    reconciler.stop()
    assert service.commit(p["id"])["status"] == "unknown"
    assert remote["posts"] == []


def test_manual_resolution_requires_evidence_and_never_writes(operation, monkeypatch):
    service, doc = operation
    state = remote_state(service, doc, monkeypatch)
    state["matches"] = []
    with pytest.raises(ValueError):
        service.resolve(doc["id"], "太短", True, True)
    result = service.resolve(doc["id"], "已经在远端核对批次日志并停止原执行", True, True)
    assert result["status"] == "resolved"
    assert service.reconcile(doc["id"])["status"] == "resolved"
    assert state["posts"] == 0
