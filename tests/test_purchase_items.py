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


def test_product_conversion_or_currency_change_blocks_commit(ledger, linked_purchase):
    request, data = linked_purchase
    writer = Writer(ledger)
    result = writer.preview(request)
    data["conversions"][0]["factor"] = "10"
    with pytest.raises(ValueError, match="换算"):
        writer.commit(result["request_id"])
    assert not Fulfillment(writer).list()
    data["conversions"][0]["factor"] = "12"
    data["currency"] = "USD"
    with pytest.raises(ValueError, match="币种"):
        writer.commit(result["request_id"])
    data["products"] = []
    with pytest.raises(ValueError, match="失效"):
        writer.commit(result["request_id"])
