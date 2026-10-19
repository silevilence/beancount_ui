from uuid import uuid4

import pytest
from beancount_ui.fulfillment import Fulfillment
from beancount_ui.fulfillment_models import ItemInput, ReceiptInput
from beancount_ui.ledger import LedgerError
from beancount_ui.models import Mutation
from beancount_ui.orders import orders
from beancount_ui.writer import Writer
from test_orders import process, purchase


def receipt(order, quantity="1", identity=None):
    return ReceiptInput(
        request_id=identity or uuid4(),
        order_id=order["id"],
        received_date="2026-09-30",
        lines=[{"item_id": order["items"][0]["id"], "quantity": quantity}],
    )


def test_receipts_independent_of_payment_persistent_and_idempotent(ledger):
    source = purchase(ledger)
    service = Fulfillment(Writer(ledger))
    process(ledger, source, "settle", "100")
    order = service.list()[0]
    assert order["payment_state"] == "paid" and order["receipt_state"] == "pending"
    request = receipt(order, "0.4")
    before = ledger.refresh().revision
    service.receive(request)
    service.receive(request)
    assert ledger.refresh().revision == before
    restored = Fulfillment(Writer(ledger)).list()[0]
    assert len(restored["receipts"]) == 1 and restored["receipt_state"] == "partial"
    assert restored["items"][0]["remaining"] == "0.6"
    with pytest.raises(LedgerError, match="超过"):
        service.receive(receipt(order, "0.7"))
    service.receive(receipt(order, "0.6"))
    assert service.list()[0]["receipt_state"] == "received"


def test_duplicate_receipt_id_different_payload_rejected(ledger):
    purchase(ledger, "paid")
    service = Fulfillment(Writer(ledger))
    request = receipt(service.list()[0], "0.4")
    service.receive(request)
    with pytest.raises(LedgerError, match="不同内容"):
        service.receive(receipt(service.list()[0], "0.2", request.request_id))


def test_history_claim_preview_then_durable_metadata(ledger):
    writer = Writer(ledger)
    source = next(r for r in orders(ledger.refresh()) if not r["identified"])
    request = Mutation(
        request_id=uuid4(),
        revision=ledger.refresh().revision,
        operation="edit",
        transaction_id=source["id"],
        raw="",
        claim_order="paid",
        claim_items=[ItemInput(name="食品", quantity="2"), ItemInput(name="其他", quantity="1")],
    )
    preview = writer.preview(request)
    assert not Fulfillment(writer).list()
    writer.commit(preview["request_id"])
    doc = Fulfillment(writer).list()[0]
    assert doc["id"] == source["key"] and doc["source"]["identified"]
    assert len(doc["items"]) == 2
    with pytest.raises(LedgerError, match="显式处理"):
        writer.preview(
            Mutation(
                request_id=uuid4(),
                revision=ledger.refresh().revision,
                operation="delete",
                transaction_id=doc["source"]["id"],
            )
        )


def test_external_order_edit_is_reported_and_receipt_blocked(ledger):
    purchase(ledger, "paid")
    service = Fulfillment(Writer(ledger))
    doc = service.list()[0]
    path = ledger.settings.ledger_dir / doc["source"]["file"]
    path.write_text(path.read_text(encoding="utf-8").replace('"淘宝"', '"其他"'), encoding="utf-8")
    assert service.list()[0]["source_changed"]
    with pytest.raises(LedgerError, match="原订单"):
        service.receive(receipt(doc))


def test_identical_price_orders_never_share_items(ledger):
    purchase(ledger)
    purchase(ledger)
    service = Fulfillment(Writer(ledger))
    rows = service.list()
    assert len({r["id"] for r in rows}) == 2
    service.receive(receipt(rows[0]))
    assert [r["receipt_state"] for r in service.list()] == ["received", "pending"]
