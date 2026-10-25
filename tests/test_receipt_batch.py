from uuid import uuid4

import pytest
from beancount_ui.fulfillment import Fulfillment
from beancount_ui.fulfillment_models import ReceiptBatchInput
from beancount_ui.receipt_batch import ReceiptBatch
from beancount_ui.writer import Writer
from test_fulfillment import receipt
from test_orders import purchase
from test_purchase_items import linked_purchase as linked_purchase


def batch(writer):
    rows = Fulfillment(writer).list()
    requests = []
    for row in rows:
        body = receipt(row).model_dump(mode="json")
        if row["source"]["mode"] == "deferred":
            body["settlement"] = {
                "date": "2026-09-30",
                "amount": row["source"]["unpaid"],
                "account": "Assets:Cash",
            }
        requests.append(body)
    return ReceiptBatchInput(request_id=uuid4(), receipts=requests)


def test_mixed_batch_has_one_bill_write_and_idempotent_receipts(ledger, monkeypatch):
    purchase(ledger)
    purchase(ledger)
    purchase(ledger, "paid")
    writer = Writer(ledger)
    service = ReceiptBatch(writer)
    body = batch(writer)
    before = ledger.refresh().revision
    p = service.preview(body)
    assert len(p["financial"]["items"]) == 2
    assert ledger.refresh().revision == before
    assert all(not o["receipts"] for o in Fulfillment(writer).list())
    assert service.preview(body) == p
    calls = []
    original = writer.commit

    def commit(identity):
        calls.append(identity)
        return original(identity)

    monkeypatch.setattr(writer, "commit", commit)
    result = service.commit(p["request_id"])
    assert result["status"] == "done"
    assert len(set(calls)) == 1
    assert all(o["payment_state"] == "paid" for o in Fulfillment(writer).list())
    after = ledger.refresh().revision
    assert service.commit(p["request_id"])["status"] == "done"
    assert ledger.refresh().revision == after
    assert all(len(o["receipts"]) == 1 for o in Fulfillment(writer).list())


def test_batch_partial_crash_recovers_without_rebilling(ledger, monkeypatch):
    purchase(ledger)
    purchase(ledger)
    writer = Writer(ledger)
    service = ReceiptBatch(writer)
    p = service.preview(batch(writer))
    original = service.flow.orders.receive
    failed_id = p["receipts"][1]["request_id"]

    def fail_once(request, **kwargs):
        if str(request.request_id) == failed_id:
            raise OSError("本地保存中断")
        return original(request, **kwargs)

    monkeypatch.setattr(service.flow.orders, "receive", fail_once)
    assert service.commit(p["request_id"])["status"] == "needs_review"
    after = ledger.refresh().revision
    assert all(o["payment_state"] == "paid" for o in Fulfillment(writer).list())
    with pytest.raises(ValueError, match="已有订单"):
        service.cancel(p["request_id"])
    restored = ReceiptBatch(Writer(ledger))
    assert restored.commit(p["request_id"])["status"] == "done"
    assert ledger.refresh().revision == after
    assert all(len(o["receipts"]) == 1 for o in Fulfillment(writer).list())


def test_stale_batch_bill_blocks_all_receipts_and_can_be_cancelled(ledger):
    purchase(ledger)
    purchase(ledger, "paid")
    writer = Writer(ledger)
    service = ReceiptBatch(writer)
    p = service.preview(batch(writer))
    purchase(ledger, "paid")
    with pytest.raises(ValueError, match="账本已被修改"):
        service.commit(p["request_id"])
    assert all(not o["receipts"] for o in Fulfillment(writer).list())
    assert service.cancel(p["request_id"])["status"] == "cancelled"
    with pytest.raises(ValueError, match="已取消"):
        service.commit(p["request_id"])
    with pytest.raises(ValueError, match="原批次"):
        service.flow.commit(p["receipts"][0]["request_id"])


def test_batch_revalidates_quantities_before_writing_any_bill(ledger):
    purchase(ledger)
    writer = Writer(ledger)
    service = ReceiptBatch(writer)
    p = service.preview(batch(writer))
    service.flow.orders.receive(receipt(service.flow.orders.list()[0]))
    before = ledger.refresh().revision
    with pytest.raises(ValueError, match="超过"):
        service.commit(p["request_id"])
    assert ledger.refresh().revision == before


def test_duplicate_orders_and_reused_batch_identity_are_rejected(ledger):
    purchase(ledger, "paid")
    writer = Writer(ledger)
    service = ReceiptBatch(writer)
    body = batch(writer)
    duplicate = body.model_copy(update={"receipts": body.receipts * 2})
    with pytest.raises(ValueError, match="重复选择订单"):
        service.preview(duplicate)
    p = service.preview(body)
    with pytest.raises(ValueError, match="不同内容"):
        service.preview(duplicate)
    assert service.cancel(p["request_id"])["status"] == "cancelled"


def test_batch_routes_and_receipt_options_use_configured_writer(ledger, linked_purchase):
    from beancount_ui.app import create_app
    from fastapi.testclient import TestClient

    purchase(ledger, "paid")
    client = TestClient(create_app(ledger.settings))
    options = client.get("/api/fulfillment/receipt/options")
    assert options.status_code == 200
    assert options.json()["locations"][0]["name"] == "厨房"
    body = batch(Writer(ledger)).model_dump(mode="json")
    preview = client.post("/api/fulfillment/receipt/batch/preview", json=body)
    assert preview.status_code == 200
    result = client.post(
        "/api/fulfillment/receipt/batch/commit", json={"request_id": body["request_id"]}
    )
    assert result.status_code == 200
    assert result.json()["status"] == "done"


def test_concurrent_batch_commit_or_cancel_cannot_interrupt_running_batch(ledger):
    from threading import Thread

    from filelock import FileLock

    purchase(ledger, "paid")
    writer = Writer(ledger)
    service = ReceiptBatch(writer)
    p = service.preview(batch(writer))
    messages = []

    def competing_actions():
        for action in (service.commit, service.cancel):
            try:
                action(p["request_id"])
            except ValueError as exc:
                messages.append(str(exc))

    with FileLock(str(writer.state / f"receipt-batch-{p['request_id']}.lock")):
        thread = Thread(target=competing_actions)
        thread.start()
        thread.join(timeout=5)
    assert len(messages) == 2 and all("正在处理" in m for m in messages)
    assert service.commit(p["request_id"])["status"] == "done"
