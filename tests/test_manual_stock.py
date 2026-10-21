from uuid import uuid4

import pytest
from beancount_ui.grocy import Grocy, GrocyError, GrocyInput
from beancount_ui.manual_stock import ManualStock, StockAction
from beancount_ui.writer import Writer


@pytest.fixture
def manual(ledger, monkeypatch):
    service = ManualStock(Writer(ledger))
    config = service.grocy.save(GrocyInput(url="http://nas", api_key="secret", enabled=True))
    remote = {"posts": [], "tare": 0, "logs": [], "lose": False, "move_on_open": 0}

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
                if remote["move_on_open"]:
                    remote["logs"] += [
                        base | {"id": 2, "transaction_type": "transfer_from", "amount": "-1"},
                        base
                        | {
                            "id": 3,
                            "transaction_type": "transfer_to",
                            "amount": "1",
                            "location_id": 2,
                        },
                    ]
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
            return {
                "id": 1,
                "qu_id_stock": 1,
                "enable_tare_weight_handling": remote["tare"],
                "move_on_open": remote["move_on_open"],
                "default_consume_location_id": 2,
            }
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


def test_open_with_automatic_transfer_is_successful_and_sent_once(manual):
    service, body, remote = manual
    remote["move_on_open"] = 1
    p = service.preview(StockAction(**(body | {"action": "open"})))
    assert service.commit(p["id"])["status"] == "success"
    service.commit(p["id"])
    assert remote["posts"] == [
        ("stock/products/1/open", {"amount": "1", "stock_entry_id": "batch"})
    ]


def test_changed_open_transfer_setting_is_rejected_before_sending(manual):
    service, body, remote = manual
    p = service.preview(StockAction(**(body | {"action": "open"})))
    remote["move_on_open"] = 1
    result = service.commit(p["id"])
    assert result["status"] == "failed"
    assert "设置已变化" in result["error"]
    assert not remote["posts"]


@pytest.mark.parametrize("change", ["amount", "destination", "missing", "batch", "unexpected"])
def test_open_transfer_logs_must_match_preview(manual, change):
    service, body, remote = manual
    remote["move_on_open"] = 1
    p = service.preview(StockAction(**(body | {"action": "open"})))
    service.operations.record(p["id"], "pending")
    service.operations.send(p["id"])
    if change == "amount":
        remote["logs"][-1]["amount"] = "2"
    elif change == "destination":
        remote["logs"][-1]["location_id"] = 3
    elif change == "missing":
        remote["logs"].pop()
    elif change == "batch":
        remote["logs"][-1]["stock_id"] = "other"
    else:
        remote["logs"][-1]["transaction_type"] = "consume"
    assert service.operations.reconcile(p["id"])["status"] == "conflict"
    assert len(remote["posts"]) == 1


def test_open_transfer_lost_response_does_not_resend(manual):
    service, body, remote = manual
    remote.update(move_on_open=1, lose=True)
    p = service.preview(StockAction(**(body | {"action": "open"})))
    assert service.commit(p["id"])["status"] == "unknown"
    assert service.commit(p["id"])["status"] == "unknown"
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
