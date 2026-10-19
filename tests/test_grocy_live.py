"""Opt-in acceptance against an EMPTY disposable loopback Grocy instance.

Run: GROCY_TEST_URL=http://127.0.0.1:18993 uv run pytest tests/test_grocy_live.py -s
The server must disable authentication for this isolated test or accept test-only-key.
Never point this test at an existing household database.
"""

import os
import sqlite3
from decimal import Decimal
from uuid import uuid4

import pytest
from beancount_ui.fulfillment import Fulfillment
from beancount_ui.fulfillment_models import ReceiptInput
from beancount_ui.grocy import Grocy, GrocyError, GrocyInput
from beancount_ui.grocy_master import EntityChange, MasterData
from beancount_ui.manual_stock import ManualStock, StockAction
from beancount_ui.models import OrderInput
from beancount_ui.receipt_flow import ReceiptFlow
from beancount_ui.stock_operations import StockReconciler
from beancount_ui.writer import Writer
from test_writer import mutation

URL = os.environ.get("GROCY_TEST_URL", "")
pytestmark = pytest.mark.skipif(not URL, reason="requires disposable Grocy via GROCY_TEST_URL")


def test_real_grocy_purchase_receipt_movements_and_restore(ledger, tmp_path, monkeypatch):
    assert URL.startswith("http://127.0.0.1:"), "Only a disposable loopback server is allowed"
    writer = Writer(ledger)
    grocy = Grocy(writer.state)
    config = grocy.save(GrocyInput(url=URL, api_key="test-only-key", enabled=True))
    instance = config["instance_id"]
    version = grocy.check()["version"]
    master = MasterData(writer)
    prefix = "acceptance-" + str(uuid4())[:8]

    def create(entity, data):
        result = master.change(
            EntityChange(request_id=uuid4(), instance_id=instance, entity=entity, data=data)
        )
        assert result["status"] == "done", result
        return int(result["response"]["created_object_id"])

    location = create("locations", {"name": prefix + "-kitchen"})
    target = create("locations", {"name": prefix + "-fridge", "is_freezer": 1})
    bottle = create("quantity_units", {"name": prefix + "-bottle"})
    case = create("quantity_units", {"name": prefix + "-case"})
    create("shopping_locations", {"name": prefix + "-store"})
    product = create(
        "products",
        {
            "name": prefix + "-water",
            "location_id": location,
            "qu_id_purchase": case,
            "qu_id_stock": bottle,
            "min_stock_amount": "6",
            "default_best_before_days": 30,
        },
    )
    conversion = next(
        c
        for c in grocy.request("objects/quantity_unit_conversions")
        if int(c["product_id"] or 0) == product and int(c["from_qu_id"]) == case
    )
    converted = master.change(
        EntityChange(
            request_id=uuid4(),
            instance_id=instance,
            entity="quantity_unit_conversions",
            entity_id=int(conversion["id"]),
            data={"product_id": product, "from_qu_id": case, "to_qu_id": bottle, "factor": "12"},
        )
    )
    assert converted["status"] == "done", converted
    request = mutation(ledger)
    entry = request.entry.model_dump(mode="json") | {"amount": "120", "payment": "Liabilities:Card"}
    request.entry = None
    request.order = OrderInput(
        kind="deferred",
        purchase=entry,
        date=entry["date"],
        amount="120",
        account=entry["payment"],
        items=[
            {
                "id": str(uuid4()),
                "name": "水",
                "quantity": "2",
                "unit": "箱",
                "product_id": product,
                "instance_id": instance,
                "factor": "12",
                "stock_unit": "瓶",
                "purchase_unit_id": case,
                "stock_unit_id": bottle,
                "unit_price": "5",
                "currency": "CNY",
                "price_confirmed": True,
                "default_location_id": location,
                "default_best_before_days": 30,
            }
        ],
    )
    writer.commit(writer.preview(request)["request_id"])
    orders = Fulfillment(writer)
    order = orders.list()[0]
    assert not grocy.product(product)["entries"]
    assert orders.purchase_quantities(instance)[str(product)]["pending"] == "24"
    flow = ReceiptFlow(writer)
    p = flow.preview(
        ReceiptInput(
            request_id=uuid4(),
            order_id=order["id"],
            received_date="2026-10-19",
            lines=[{"item_id": order["items"][0]["id"], "quantity": "1"}],
            settlement={"date": "2026-10-19", "amount": "120", "account": "Assets:Cash"},
        )
    )
    first = flow.commit(p["request_id"])
    assert first["settlement_status"] == "done", first
    assert first["operations"][0]["status"] == "success", first["operations"]
    stock_id = grocy.product(product)["entries"][0]["stock_id"]
    manual = ManualStock(writer)
    for action, amount in [("open", "1"), ("transfer", "2"), ("consume", "3")]:
        stock_id = next(
            e["stock_id"]
            for e in grocy.product(product)["entries"]
            if int(e["location_id"]) == location and Decimal(str(e["amount"])) >= Decimal(amount)
        )
        op = manual.preview(
            StockAction(
                request_id=uuid4(),
                instance_id=instance,
                product_id=product,
                action=action,
                amount=amount,
                location_id=location,
                target_location_id=target,
                stock_id=stock_id,
            )
        )
        result = manual.commit(op["id"])
        assert result["status"] == "success", result
        assert manual.commit(op["id"])["status"] == "success"
    assert manual.operations.reconcile(first["operations"][0]["id"])["status"] == "success"
    second_preview = flow.preview(
        ReceiptInput(
            request_id=uuid4(),
            order_id=order["id"],
            received_date="2026-10-19",
            lines=[{"item_id": order["items"][0]["id"], "quantity": "1"}],
        )
    )
    backup = tmp_path / "preview-only.sqlite3"
    with writer.database() as db, sqlite3.connect(backup) as destination:
        db.backup(destination)
    original = Grocy.request
    writes = []

    def lose(self, path, method="GET", payload=None, **kwargs):
        result = original(self, path, method, payload, **kwargs)
        if method == "POST" and path.endswith("/add"):
            writes.append(path)
            raise GrocyError("timeout", "injected lost response after real commit")
        return result

    monkeypatch.setattr(Grocy, "request", lose)
    second = flow.commit(second_preview["request_id"])
    assert second["operations"][0]["status"] == "success", second["operations"]
    assert len(writes) == 1
    # Restore the older app DB while leaving the later Grocy purchase intact.
    with sqlite3.connect(backup) as source, writer.database() as destination:
        source.backup(destination)
    restarted = Writer(ledger)
    reconciler = StockReconciler(restarted)
    reconciler.start()
    reconciler.stop()
    recovered = ReceiptFlow(restarted).commit(second_preview["request_id"])
    assert recovered["operations"][0]["status"] == "success", recovered
    assert len(writes) == 1
    assert sum(Decimal(str(e["amount"])) for e in grocy.product(product)["entries"]) == 21
    assert Fulfillment(restarted).list()[0]["receipt_state"] == "received"
    assert not ledger.refresh().errors
    print(
        f"Grocy {version}: master data, 24 bottles @ 5 CNY, split receipt, settlement, "
        "open/transfer/consume, lost response, preview-only backup restore passed"
    )
