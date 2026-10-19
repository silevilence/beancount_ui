from uuid import uuid4

import pytest
from beancount_ui.fulfillment import Fulfillment
from beancount_ui.grocy import Grocy, GrocyError
from beancount_ui.order_corrections import CorrectionInput, OrderCorrections
from beancount_ui.receipt_flow import ReceiptFlow
from beancount_ui.writer import Writer
from test_fulfillment import receipt
from test_orders import purchase
from test_stock_operations import operation as operation
from test_stock_reconciliation import remote_state


def test_partial_cancel_void_and_return_note_never_change_finance(ledger):
    purchase(ledger, "paid")
    writer = Writer(ledger)
    orders = Fulfillment(writer)
    service = OrderCorrections(writer)
    order = orders.list()[0]
    before = ledger.refresh().revision
    r = orders.receive(receipt(order, "0.4"))
    request = CorrectionInput(
        request_id=uuid4(),
        order_id=order["id"],
        action="cancel_remaining",
        item_id=order["items"][0]["id"],
        reason="未发货取消剩余",
    )
    service.apply(request)
    service.apply(request)
    assert orders.list()[0]["items"][0]["cancelled"] == "0.6"
    assert orders.list()[0]["items"][0]["remaining"] == "0.0"
    service.apply(
        CorrectionInput(
            request_id=uuid4(),
            order_id=order["id"],
            action="return_note",
            receipt_id=r["request_id"],
            reason="实际退货核对说明",
        )
    )
    assert orders.list()[0]["items"][0]["received"] == "0.4"
    service.apply(
        CorrectionInput(
            request_id=uuid4(),
            order_id=order["id"],
            action="void_receipt",
            receipt_id=r["request_id"],
            reason="误录收货作废",
        )
    )
    assert orders.list()[0]["items"][0]["remaining"] == "0.4"
    assert ledger.refresh().revision == before
    with pytest.raises(ValueError, match="收货历史"):
        service.apply(
            CorrectionInput(
                request_id=uuid4(), order_id=order["id"], action="release", reason="解除管理关联"
            )
        )


def test_changed_item_invalidates_previous_receipt_preview(ledger):
    purchase(ledger, "paid")
    writer = Writer(ledger)
    order = Fulfillment(writer).list()[0]
    request = receipt(order)
    p = ReceiptFlow(writer).preview(request)
    item = order["items"][0]
    replacement = {k: v for k, v in item.items() if k not in ("received", "remaining", "cancelled")}
    replacement["name"] = "更正的商品"
    OrderCorrections(writer).apply(
        CorrectionInput(
            request_id=uuid4(),
            order_id=order["id"],
            action="replace_unreceived",
            item_id=item["id"],
            replacement=replacement,
            reason="商品描述更正",
        )
    )
    with pytest.raises(ValueError, match="已更正"):
        ReceiptFlow(writer).commit(p["request_id"])


def test_undo_success_with_lost_response_is_never_repeated(operation, monkeypatch):
    service, doc = operation
    state = remote_state(service, doc, monkeypatch)
    service.reconcile(doc["id"])
    original = Grocy.request
    calls = []

    def undo(self, path, method="GET", payload=None, **kwargs):
        if path.endswith("/undo"):
            calls.append(path)
            state["transaction"][0]["undone"] = 1
            raise GrocyError("timeout", "撤销响应丢失")
        return original(self, path, method, payload, **kwargs)

    monkeypatch.setattr(Grocy, "request", undo)
    assert service.undo_receipt(doc["id"], "误录更正")["status"] == "undone"
    service.undo_receipt(doc["id"], "重复确认")
    assert len(calls) == 1


def test_consumed_batch_cannot_be_automatically_undone(operation, monkeypatch):
    service, doc = operation
    remote_state(service, doc, monkeypatch, consumed=True)
    service.reconcile(doc["id"])
    with pytest.raises(ValueError, match="后续操作"):
        service.undo_receipt(doc["id"], "误录更正")


def test_unreceived_release_retains_audit_and_ledger(ledger):
    purchase(ledger, "paid")
    writer = Writer(ledger)
    order = Fulfillment(writer).list()[0]
    before = ledger.refresh().revision
    result = OrderCorrections(writer).apply(
        CorrectionInput(
            request_id=uuid4(), order_id=order["id"], action="release", reason="先解除后更正原文"
        )
    )
    assert result["released_snapshot"]["id"] == order["id"]
    assert not Fulfillment(writer).list() and ledger.refresh().revision == before
