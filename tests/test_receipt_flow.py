from uuid import uuid4

import pytest
from beancount_ui.fulfillment import Fulfillment
from beancount_ui.fulfillment_models import ReceiptInput
from beancount_ui.grocy import Grocy, GrocyError
from beancount_ui.receipt_flow import ReceiptFlow
from beancount_ui.writer import Writer
from test_fulfillment import receipt
from test_orders import process, purchase
from test_purchase_items import linked_purchase as linked_purchase


def test_paid_receipt_creates_no_ledger_entry(ledger):
    purchase(ledger, "paid")
    writer = Writer(ledger)
    service = ReceiptFlow(writer)
    order = Fulfillment(writer).list()[0]
    request = receipt(order)
    before = ledger.refresh().revision
    preview = service.preview(request)
    assert preview["financial"] is None
    result = service.commit(preview["request_id"])
    assert result["receipt_saved"] and result["settlement_status"] == "none"
    service.commit(preview["request_id"])
    assert len(Fulfillment(writer).list()[0]["receipts"]) == 1
    assert ledger.refresh().revision == before


def test_receive_and_settle_then_retry_never_duplicates(ledger):
    purchase(ledger)
    writer = Writer(ledger)
    service = ReceiptFlow(writer)
    order = Fulfillment(writer).list()[0]
    request = receipt(order).model_dump(mode="json") | {
        "settlement": {"date": "2026-09-30", "amount": "100", "account": "Assets:Cash"}
    }
    p = service.preview(ReceiptInput.model_validate(request))
    result = service.commit(p["request_id"])
    assert result["settlement_status"] == "done"
    after = ledger.refresh().revision
    service.commit(p["request_id"])
    assert ledger.refresh().revision == after
    order = Fulfillment(writer).list()[0]
    assert order["receipt_state"] == "received" and order["payment_state"] == "paid"


def test_settlement_failure_does_not_discard_receipt(ledger):
    source = purchase(ledger)
    writer = Writer(ledger)
    service = ReceiptFlow(writer)
    request = receipt(Fulfillment(writer).list()[0]).model_dump(mode="json") | {
        "settlement": {"date": "2026-09-30", "amount": "100", "account": "Assets:Cash"}
    }
    p = service.preview(ReceiptInput.model_validate(request))
    process(ledger, source, "settle", "20")
    result = service.commit(p["request_id"])
    assert result["receipt_saved"] and result["settlement_status"] == "needs_review"
    assert Fulfillment(writer).list()[0]["items"][0]["remaining"] == "0"


def test_linked_receipt_keeps_physical_fact_when_remote_response_lost(
    ledger, linked_purchase, monkeypatch
):
    purchase_request, _ = linked_purchase
    writer = Writer(ledger)
    writer.commit(writer.preview(purchase_request)["request_id"])
    order = Fulfillment(writer).list()[0]
    request = ReceiptInput(
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
    service = ReceiptFlow(writer)
    preview = service.preview(request)
    assert preview["actions"][0]["stock_amount"] == "12"
    posts = []

    def fail(self, path, method="GET", payload=None, **kwargs):
        if method == "POST":
            posts.append(path)
        raise GrocyError("timeout", "响应丢失")

    monkeypatch.setattr(Grocy, "request", fail)
    result = service.commit(preview["request_id"])
    assert result["receipt_saved"] and result["operations"][0]["status"] == "unknown"
    service.commit(preview["request_id"])
    assert len(posts) == 1
    restored = Fulfillment(Writer(ledger)).list()[0]
    assert restored["items"][0]["remaining"] == "1" and len(restored["receipts"]) == 1


def test_two_previews_cannot_over_receive(ledger):
    purchase(ledger, "paid")
    writer = Writer(ledger)
    service = ReceiptFlow(writer)
    order = Fulfillment(writer).list()[0]
    a = service.preview(receipt(order))
    b = service.preview(receipt(order))
    service.commit(a["request_id"])
    with pytest.raises(ValueError, match="超过"):
        service.commit(b["request_id"])
