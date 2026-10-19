import json
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from beancount_ui.app import create_app
from beancount_ui.fulfillment import Fulfillment
from beancount_ui.fulfillment_models import ReceiptInput
from beancount_ui.grocy import Grocy, GrocyError, GrocyInput
from beancount_ui.manual_stock import StockAction
from beancount_ui.order_corrections import CorrectionInput, OrderCorrections
from beancount_ui.stock_operations import StockOperations
from beancount_ui.writer import Writer
from fastapi.testclient import TestClient
from test_fulfillment import receipt
from test_grocy import grocy as grocy
from test_manual_stock import manual as manual
from test_orders import purchase
from test_purchase_items import linked_purchase as linked_purchase
from test_writer import mutation


def test_completed_and_unlinked_commit_do_not_wait_for_grocy(ledger, linked_purchase):
    request, _ = linked_purchase
    writer = Writer(ledger)
    completed = writer.commit(writer.preview(request)["request_id"])
    plain = writer.preview(mutation(ledger))
    # A separate thread holds the actual cross-instance file lock.
    with Grocy(writer.state).lock, ThreadPoolExecutor(1) as pool:
        assert pool.submit(writer.commit, completed["request_id"]).result(timeout=5) == completed
        assert pool.submit(writer.commit, plain["request_id"]).result(timeout=5)["status"] == "done"


def test_check_reports_partial_permission_and_keeps_other_results(grocy, monkeypatch):
    def remote(path, **kwargs):
        if path == "system/info":
            return {"grocy_version": {"Version": "4.7.1"}}
        if path == "objects/products":
            raise GrocyError("permission", "Grocy 权限不足")
        if path == "stock":
            raise GrocyError("timeout", "Grocy 请求超时")
        return []

    monkeypatch.setattr(grocy, "request", remote)
    result = grocy.check()
    assert result["compatible"]
    assert result["checks"]["objects/products"]["code"] == "permission"
    assert result["checks"]["stock"]["code"] == "timeout"
    assert result["checks"]["stock/volatile"]["available"]


def test_draft_does_not_bind_and_cannot_send_to_changed_instance(manual):
    service, body, remote = manual
    draft = service.preview(StockAction(**body))
    assert not (service.writer.state / "grocy-bindings.locked").exists()
    service.grocy.save(GrocyInput(url="http://another", api_key="other", enabled=True))
    result = service.commit(draft["id"])
    assert result["status"] == "failed" and result["evidence"]["unsent"]
    assert not remote["posts"]
    assert not (service.writer.state / "grocy-bindings.locked").exists()


def test_committed_manual_action_binds_instance(manual):
    service, body, _ = manual
    draft = service.preview(StockAction(**body))
    service.commit(draft["id"])
    with pytest.raises(ValueError, match="已有商品"):
        service.grocy.save(GrocyInput(url="http://another", api_key="other", enabled=True))


def test_bindings_api_explains_linked_products_without_credentials(ledger, linked_purchase):
    writer = Writer(ledger)
    writer.commit(writer.preview(linked_purchase[0])["request_id"])
    response = TestClient(create_app(ledger.settings)).get("/api/grocy/bindings")
    result = response.json()
    assert result["locked"] and result["items"][0]["product_id"] == 1
    assert result["operations"] == [] and "secret" not in response.text


@pytest.mark.parametrize("legacy", [False, True])
def test_fully_received_item_can_be_corrected_only_after_void(ledger, legacy):
    purchase(ledger, "paid")
    writer = Writer(ledger)
    service = OrderCorrections(writer)
    orders = Fulfillment(writer)
    order = orders.list()[0]
    saved = orders.receive(receipt(order))
    if legacy:
        saved.pop("item_snapshots")
        with writer.database() as db:
            db.execute(
                "UPDATE receipts SET payload=? WHERE id=?", (json.dumps(saved), saved["request_id"])
            )
    before = ledger.refresh().revision
    original = {
        k: v
        for k, v in order["items"][0].items()
        if k not in ("received", "remaining", "cancelled")
    }
    correction = CorrectionInput(
        request_id=uuid4(),
        order_id=order["id"],
        action="replace_unreceived",
        item_id=original["id"],
        replacement=original | {"name": "更正商品", "quantity": "2"},
        reason="误录实物商品更正",
    )
    with pytest.raises(ValueError, match="有效收货"):
        service.apply(correction)
    with pytest.raises(ValueError, match="收货历史"):
        service.apply(
            CorrectionInput(
                request_id=uuid4(),
                order_id=order["id"],
                action="release",
                reason="不能删除有效收货",
            )
        )
    service.apply(
        CorrectionInput(
            request_id=uuid4(),
            order_id=order["id"],
            action="void_receipt",
            receipt_id=saved["request_id"],
            reason="误录收货作废",
        )
    )
    result = service.apply(correction)
    assert result["previous_item"] == original
    assert service.apply(correction) == result
    current = orders.list()[0]
    assert current["items"][0]["remaining"] == "2"
    assert current["receipts"][0]["voided"] and ledger.refresh().revision == before
    assert current["receipts"][0]["item_snapshots"][original["id"]]["name"] == original["name"]


def test_remote_undo_is_not_counted_as_unsynced_receipt(ledger, linked_purchase):
    writer = Writer(ledger)
    writer.commit(writer.preview(linked_purchase[0])["request_id"])
    service = Fulfillment(writer)
    order = service.list()[0]
    service.receive(
        ReceiptInput(
            request_id=uuid4(),
            order_id=order["id"],
            received_date="2026-09-30",
            lines=[
                {
                    "item_id": order["items"][0]["id"],
                    "quantity": "1",
                    "unit_price": "5",
                    "location_id": 1,
                    "best_before_date": "2027-01-01",
                }
            ],
        ),
        prepared=True,
    )
    operations = StockOperations(writer)
    identity = operations.list()[0]["id"]
    instance = linked_purchase[1]["instance_id"]
    assert service.purchase_quantities(instance)["1"]["received_unsynced"] == "12"
    operations.record(identity, "undone")
    assert service.purchase_quantities(instance)["1"]["received_unsynced"] == "0"
    bindings = service.bindings()
    assert bindings["operations"][0]["status"] == "undone"
    assert not bindings["operations"][0]["needs_review"]
