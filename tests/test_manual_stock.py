from uuid import uuid4

import pytest
from beancount_ui.grocy import Grocy, GrocyError, GrocyInput
from beancount_ui.manual_stock import ManualStock, StockAction
from beancount_ui.writer import Writer


@pytest.fixture
def manual(ledger, monkeypatch):
    service = ManualStock(Writer(ledger))
    config = service.grocy.save(GrocyInput(url="http://nas", api_key="secret", enabled=True))
    remote = {"posts": [], "tare": 0, "logs": [], "lose": False}

    def request(self, path, method="GET", payload=None, **kwargs):
        if method == "POST":
            remote["posts"].append((path, payload))
            action = path.rsplit("/", 1)[-1]
            base = {
                "id": 1,
                "transaction_id": "tx",
                "product_id": 1,
                "stock_id": "batch",
                "location_id": 1,
                "undone": 0,
            }
            if action == "consume":
                remote["logs"] = [base | {"transaction_type": "consume", "amount": "-1"}]
            elif action == "open":
                remote["logs"] = [base | {"transaction_type": "product-opened", "amount": "1"}]
            elif action == "transfer":
                remote["logs"] = [
                    base | {"transaction_type": "transfer_from", "amount": "-1"},
                    base
                    | {"id": 2, "transaction_type": "transfer_to", "amount": "1", "location_id": 2},
                ]
            if remote["lose"]:
                raise GrocyError("timeout", "响应丢失")
            return remote["logs"]
        if path.startswith("objects/products/"):
            return {"id": 1, "qu_id_stock": 1, "enable_tare_weight_handling": remote["tare"]}
        if path.endswith("/entries"):
            return [{"stock_id": "batch", "location_id": 1, "amount": "3", "open": 0}]
        if path.startswith("stock/transactions/"):
            return remote["logs"]
        if path == "system/config":
            return {"CURRENCY": "CNY"}
        raise AssertionError(path)

    monkeypatch.setattr(Grocy, "request", request)
    body = {
        "request_id": uuid4(),
        "instance_id": config["instance_id"],
        "product_id": 1,
        "action": "consume",
        "amount": "1",
        "stock_id": "batch",
        "location_id": 1,
        "target_location_id": 2,
    }
    return service, body, remote


@pytest.mark.parametrize("action", ["consume", "open", "transfer"])
def test_manual_preview_commit_and_repeat(manual, action):
    service, body, remote = manual
    request = StockAction(**(body | {"action": action}))
    p = service.preview(request)
    assert p["status"] == "draft" and not remote["posts"]
    assert service.commit(p["id"])["status"] == "success"
    service.commit(p["id"])
    assert len(remote["posts"]) == 1


def test_lost_movement_response_is_not_reconstructed_from_stock(manual):
    service, body, remote = manual
    p = service.preview(StockAction(**body))
    remote["lose"] = True
    assert service.commit(p["id"])["status"] == "unknown"
    service.commit(p["id"])
    assert len(remote["posts"]) == 1


def test_tare_and_excess_quantity_rejected(manual):
    service, body, remote = manual
    with pytest.raises(ValueError, match="不足"):
        service.preview(StockAction(**(body | {"amount": "4"})))
    remote["tare"] = 1
    with pytest.raises(ValueError, match="皮重"):
        service.preview(StockAction(**body))


def test_add_requires_explicit_independent_purchase_and_price(manual):
    service, body, remote = manual
    with pytest.raises(ValueError, match="订单采购"):
        service.preview(StockAction(**(body | {"action": "add"})))
    with pytest.raises(ValueError, match="价格"):
        service.preview(StockAction(**(body | {"action": "add", "independent_purchase": True})))
