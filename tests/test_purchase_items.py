from uuid import uuid4

import pytest
from beancount_ui.fulfillment import Fulfillment
from beancount_ui.grocy import Grocy, GrocyInput
from beancount_ui.models import OrderInput
from beancount_ui.writer import Writer
from test_writer import mutation


@pytest.fixture
def linked_purchase(ledger, monkeypatch):
    grocy = Grocy(ledger.settings.state_dir)
    grocy.save(GrocyInput(url="http://nas", api_key="secret", enabled=True))
    data = {
        "instance_id": grocy.status()["instance_id"],
        "currency": "CNY",
        "products": [{"id": 1, "name": "水", "qu_id_stock": 1, "qu_id_purchase": 2}],
        "conversions": [{"product_id": 1, "from_qu_id": 2, "to_qu_id": 1, "factor": "12"}],
    }
    monkeypatch.setattr(Grocy, "inventory", lambda self: data)
    monkeypatch.setattr(
        Grocy,
        "receipt_options",
        lambda self: (
            data
            | {
                "locations": [{"id": 1, "name": "厨房"}, {"id": 2, "name": "储物间"}],
                "default_location_id": None,
                "default_best_before_days": None,
            }
        ),
    )
    request = mutation(ledger)
    entry = request.entry.model_dump(mode="json") | {"amount": "120"}
    request.entry = None
    request.order = OrderInput(
        kind="paid",
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
                "product_id": 1,
                "instance_id": data["instance_id"],
                "factor": "12",
                "stock_unit": "瓶",
                "purchase_unit_id": 2,
                "stock_unit_id": 1,
                "unit_price": "5",
                "currency": "CNY",
                "price_confirmed": True,
            }
        ],
    )
    return request, data


def test_purchase_snapshot_only_after_commit(ledger, linked_purchase):
    request, data = linked_purchase
    writer = Writer(ledger)
    result = writer.preview(request)
    assert not Fulfillment(writer).list()
    assert not (writer.state / "grocy-bindings.locked").exists()
    writer.commit(result["request_id"])
    item = Fulfillment(writer).list()[0]["items"][0]
    assert item["quantity"] == "2" and item["factor"] == "12" and item["unit_price"] == "5"
    assert item["received"] == "0"
    assert (writer.state / "grocy-bindings.locked").exists()


def test_product_conversion_or_disappearance_blocks_commit(ledger, linked_purchase):
    request, data = linked_purchase
    writer = Writer(ledger)
    result = writer.preview(request)
    data["conversions"][0]["factor"] = "10"
    with pytest.raises(ValueError, match="换算"):
        writer.commit(result["request_id"])
    assert not Fulfillment(writer).list()
    data["conversions"][0]["factor"] = "12"
    data["products"] = []
    with pytest.raises(ValueError, match="失效"):
        writer.commit(result["request_id"])


def test_grocy_currency_is_ignored_and_allocation_calculates_price(ledger, linked_purchase):
    request, data = linked_purchase
    data["currency"] = "USD"
    body = request.order.model_dump(mode="json")
    body["items"][0].update(allocated_amount="120", unit_price="999", price_confirmed=False)
    request.order = OrderInput.model_validate(body)
    assert request.order.items[0].unit_price == 5
    writer = Writer(ledger)
    preview = writer.preview(request)
    writer.commit(preview["request_id"])
    item = Fulfillment(writer).list()[0]["items"][0]
    assert item["currency"] == "CNY"
    assert item["unit_price"] == "5.00000000"


@pytest.mark.parametrize("field,value", [("no_own_stock", "1"), ("active", "0")])
def test_unstockable_or_inactive_product_rejected(ledger, linked_purchase, field, value):
    request, data = linked_purchase
    data["products"][0][field] = value
    with pytest.raises(ValueError, match="无自有库存|停用"):
        Writer(ledger).preview(request)


def test_multi_product_allocation_must_equal_order_total(linked_purchase):
    request, _ = linked_purchase
    body = request.order.model_dump(mode="json")
    body["items"][0]["allocated_amount"] = "80"
    body["items"].append(body["items"][0] | {"id": str(uuid4()), "allocated_amount": "40"})
    result = OrderInput.model_validate(body)
    assert str(result.items[0].unit_price) == "3.33333333"
    body["items"][1]["allocated_amount"] = "41"
    with pytest.raises(ValueError, match="合计"):
        OrderInput.model_validate(body)
    body["items"][1]["allocated_amount"] = None
    with pytest.raises(ValueError, match="每个商品"):
        OrderInput.model_validate(body)


def test_legacy_items_keep_serialized_request_shape(linked_purchase):
    request, _ = linked_purchase
    item = request.order.items[0]
    assert "allocated_amount" not in item.model_dump(mode="json")
    assert "allocated_amount" not in request.model_dump(mode="json")["order"]["items"][0]
