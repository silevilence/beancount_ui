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


@pytest.mark.parametrize(
    "days,expected", [(7, "2026-10-07"), (0, "2026-09-30"), (-1, "2999-12-31")]
)
def test_receipt_product_defaults_and_named_location(ledger, linked_purchase, days, expected):
    purchase_request, data = linked_purchase
    data["products"][0].update(default_best_before_days=days, location_id=2)
    writer = Writer(ledger)
    writer.commit(writer.preview(purchase_request)["request_id"])
    p = ReceiptFlow(writer).preview(receipt(Fulfillment(writer).list()[0]))
    assert p["actions"][0]["best_before_date"] == expected
    assert p["actions"][0]["location_id"] == 2
    assert p["actions"][0]["location_name"] == "储物间"


def test_receipt_manual_expiry_overrides_product_default(ledger, linked_purchase):
    purchase_request, data = linked_purchase
    data["products"][0].update(default_best_before_days=7, location_id=1)
    writer = Writer(ledger)
    writer.commit(writer.preview(purchase_request)["request_id"])
    body = receipt(Fulfillment(writer).list()[0]).model_dump(mode="json")
    body["lines"][0].update(best_before_date="2027-01-01", location_id=2)
    p = ReceiptFlow(writer).preview(ReceiptInput.model_validate(body))
    assert p["actions"][0]["best_before_date"] == "2027-01-01"
    assert p["actions"][0]["location_name"] == "储物间"


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


def test_settlement_failure_does_not_receive_or_enqueue_stock(ledger):
    source = purchase(ledger)
    writer = Writer(ledger)
    service = ReceiptFlow(writer)
    request = receipt(Fulfillment(writer).list()[0]).model_dump(mode="json") | {
        "settlement": {"date": "2026-09-30", "amount": "100", "account": "Assets:Cash"}
    }
    p = service.preview(ReceiptInput.model_validate(request))
    process(ledger, source, "settle", "20")
    result = service.commit(p["request_id"])
    assert not result["receipt_saved"] and result["settlement_status"] == "needs_review"
    assert Fulfillment(writer).list()[0]["items"][0]["remaining"] == "1"
    assert result["operations"] == []


def test_deferred_receipt_requires_bill_in_same_request(ledger):
    purchase(ledger)
    writer = Writer(ledger)
    with pytest.raises(ValueError, match="先用后付.*账单"):
        ReceiptFlow(writer).preview(receipt(Fulfillment(writer).list()[0]))


@pytest.mark.parametrize("mode", ["paid", "deferred"])
def test_linked_receipt_keeps_physical_fact_when_remote_response_lost(
    ledger, linked_purchase, monkeypatch, mode
):
    purchase_request, _ = linked_purchase
    purchase_request.order.kind = mode
    if mode == "deferred":
        purchase_request.order.purchase.payment = "Liabilities:Card"
        purchase_request.order.account = "Liabilities:Card"
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
        settlement=(
            {"date": "2026-09-30", "amount": "60", "account": "Assets:Cash"}
            if mode == "deferred"
            else None
        ),
    )
    service = ReceiptFlow(writer)
    preview = service.preview(request)
    assert preview["actions"][0]["stock_amount"] == "12"
    posts = []

    def fail(self, path, method="GET", payload=None, **kwargs):
        if method == "GET" and "stock_log" in path:
            return []
        if method == "POST":
            posts.append(path)
        raise GrocyError("timeout", "响应丢失")

    monkeypatch.setattr(Grocy, "request", fail)
    before = ledger.refresh().revision
    result = service.commit(preview["request_id"])
    assert result["receipt_saved"] and result["operations"][0]["status"] == "unknown"
    assert result["settlement_status"] == ("done" if mode == "deferred" else "none")
    after = ledger.refresh().revision
    assert (after == before) == (mode == "paid")
    service.commit(preview["request_id"])
    assert ledger.refresh().revision == after
    assert len(posts) == 1
    restored = Fulfillment(Writer(ledger)).list()[0]
    assert restored["items"][0]["remaining"] == "1" and len(restored["receipts"]) == 1
    quantities = Fulfillment(writer).purchase_quantities(order["items"][0]["instance_id"])
    assert quantities["1"]["pending"] == "12"
    assert quantities["1"]["received_unsynced"] == "12"


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


def test_failed_bill_can_be_corrected_in_same_receipt_form(ledger):
    source = purchase(ledger)
    writer = Writer(ledger)
    flow = ReceiptFlow(writer)
    order = Fulfillment(writer).list()[0]
    request = receipt(order, "0.4").model_dump(mode="json") | {
        "settlement": {"date": "2026-09-30", "amount": "100", "account": "Assets:Cash"}
    }
    p = flow.preview(ReceiptInput.model_validate(request))
    process(ledger, source, "settle", "20")
    assert flow.commit(p["request_id"])["settlement_status"] == "needs_review"
    assert flow.close_settlement(p["request_id"])["settlement_status"] == "abandoned"
    before = ledger.refresh().revision
    with pytest.raises(ValueError, match="已取消"):
        flow.commit(p["request_id"])
    with pytest.raises(ValueError, match="取消"):
        writer.commit(p["financial"]["request_id"])
    assert ledger.refresh().revision == before
    corrected = receipt(Fulfillment(writer).list()[0]).model_dump(mode="json") | {
        "settlement": {"date": "2026-09-30", "amount": "80", "account": "Assets:Cash"}
    }
    remaining = flow.preview(ReceiptInput.model_validate(corrected))
    assert flow.commit(remaining["request_id"])["receipt_saved"]
    assert Fulfillment(writer).list()[0]["receipt_state"] == "received"


def test_linked_deferred_bill_failure_cannot_enqueue_inventory(
    ledger, linked_purchase, monkeypatch
):
    request, _ = linked_purchase
    request.order.kind = "deferred"
    request.order.purchase.payment = "Liabilities:Card"
    request.order.account = "Liabilities:Card"
    writer = Writer(ledger)
    writer.commit(writer.preview(request)["request_id"])
    order = Fulfillment(writer).list()[0]
    body = receipt(order).model_dump(mode="json") | {
        "settlement": {"date": "2026-09-30", "amount": "120", "account": "Assets:Cash"}
    }
    body["lines"][0].update(location_id=1, best_before_date="2027-01-01")
    flow = ReceiptFlow(writer)
    p = flow.preview(ReceiptInput.model_validate(body))

    def fail(_):
        raise ValueError("账本发生变化")

    monkeypatch.setattr(writer, "commit", fail)
    result = flow.commit(p["request_id"])
    assert not result["receipt_saved"]
    from beancount_ui.stock_operations import StockOperations

    assert StockOperations(writer).list() == []
    assert Fulfillment(writer).list()[0]["receipts"] == []


def test_bill_saved_before_receipt_crash_resumes_without_duplicate(ledger, monkeypatch):
    purchase(ledger)
    writer = Writer(ledger)
    flow = ReceiptFlow(writer)
    body = receipt(Fulfillment(writer).list()[0]).model_dump(mode="json") | {
        "settlement": {"date": "2026-09-30", "amount": "100", "account": "Assets:Cash"}
    }
    p = flow.preview(ReceiptInput.model_validate(body))
    receive = flow.orders.receive

    def crash(*args, **kwargs):
        assert Fulfillment(writer).list()[0]["payment_state"] == "paid"
        raise OSError("收货保存中断")

    monkeypatch.setattr(flow.orders, "receive", crash)
    with pytest.raises(OSError, match="中断"):
        flow.commit(p["request_id"])
    after = ledger.refresh().revision
    with pytest.raises(ValueError, match="账单已保存"):
        flow.close_settlement(p["request_id"])
    monkeypatch.setattr(flow.orders, "receive", receive)
    assert flow.commit(p["request_id"])["receipt_saved"]
    assert ledger.refresh().revision == after
    assert len(Fulfillment(writer).list()[0]["receipts"]) == 1
