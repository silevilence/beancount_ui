from copy import deepcopy

import pytest
from beancount_ui.grocy import Grocy, GrocyError
from beancount_ui.stock_operations import StockReconciler
from test_stock_operations import operation as operation


def remote_state(service, doc, monkeypatch, *, consumed=False):
    purchase = {
        "id": 1,
        "transaction_id": "tx",
        "product_id": 1,
        "stock_id": "batch",
        "amount": "3",
        "transaction_type": "purchase",
        "undone": 0,
        **{k: v for k, v in doc["payload"].items() if k not in ("amount", "transaction_type")},
    }
    history = [purchase]
    if consumed:
        history.append(
            purchase
            | {"id": 2, "transaction_id": "consume", "transaction_type": "consume", "amount": "-2"}
        )
    state = {
        "matches": [purchase],
        "transaction": [purchase],
        "history": history,
        "entries": [
            {"stock_id": "unrelated", "amount": "5", "location_id": 1},
            {"stock_id": "batch", "amount": "1" if consumed else "3", "location_id": 1},
        ],
        "posts": 0,
    }

    def request(self, path, method="GET", payload=None, **kwargs):
        if method == "POST":
            state["posts"] += 1
            raise GrocyError("timeout", "响应丢失")
        if "note%3D" in path:
            return deepcopy(state["matches"])
        if "stock_id%3D" in path:
            return deepcopy(state["history"])
        if "stock/transactions/" in path:
            return deepcopy(state["transaction"])
        if path.endswith("/entries"):
            return deepcopy(state["entries"])
        raise AssertionError(path)

    monkeypatch.setattr(Grocy, "request", request)
    return state


@pytest.mark.parametrize("consumed", [False, True])
def test_lost_response_reconciles_original_even_when_total_is_six(operation, monkeypatch, consumed):
    service, doc = operation
    state = remote_state(service, doc, monkeypatch, consumed=consumed)
    service.send(doc["id"])
    assert service.reconcile(doc["id"])["status"] == "success"
    service.send(doc["id"])
    assert state["posts"] == 1


def test_no_log_never_means_safe_resend_even_when_total_matches(operation, monkeypatch):
    service, doc = operation
    state = remote_state(service, doc, monkeypatch)
    state["matches"] = []
    state["entries"] = [{"stock_id": "unrelated", "amount": "8", "location_id": 1}]
    service.send(doc["id"])
    for _ in range(3):
        assert service.reconcile(doc["id"])["status"] == "unknown"
        service.send(doc["id"])
    assert state["posts"] == 1
    state["matches"] = [state["transaction"][0]]
    state["entries"].append({"stock_id": "batch", "amount": "3", "location_id": 1})
    assert service.reconcile(doc["id"])["status"] == "success"


@pytest.mark.parametrize(
    "problem", ["partial", "multiple", "undone", "missing_stock", "missing_history", "price"]
)
def test_conflicts_never_replay(operation, monkeypatch, problem):
    service, doc = operation
    state = remote_state(service, doc, monkeypatch)
    if problem == "partial":
        state["transaction"][0]["amount"] = "2"
    elif problem == "multiple":
        state["matches"].append(state["matches"][0] | {"id": 2, "transaction_id": "other"})
    elif problem == "undone":
        state["transaction"][0]["undone"] = 1
    elif problem == "missing_stock":
        state["entries"] = []
    elif problem == "missing_history":
        state["history"] = []
    elif problem == "price":
        state["transaction"][0]["price"] = "99"
    result = service.reconcile(doc["id"])
    assert result["status"] == ("undone" if problem == "undone" else "conflict")
    service.send(doc["id"])
    assert state["posts"] == 0


def test_multiple_logs_one_transaction_and_transfer_explained(operation, monkeypatch):
    service, doc = operation
    state = remote_state(service, doc, monkeypatch)
    first = state["transaction"][0] | {"amount": "1"}
    second = first | {"id": 2, "amount": "2"}
    state["matches"] = state["transaction"] = [first, second]
    state["history"] = [
        first,
        second,
        first | {"id": 3, "transaction_type": "transfer_from", "amount": "-1"},
        first | {"id": 4, "transaction_type": "transfer_to", "amount": "1", "location_id": 2},
    ]
    state["entries"] = [
        {"stock_id": "batch", "amount": "2", "location_id": 1},
        {"stock_id": "batch", "amount": "1", "location_id": 2},
    ]
    assert service.reconcile(doc["id"])["status"] == "success"


def test_query_failure_and_restore_only_reconcile(operation, monkeypatch):
    service, doc = operation

    def fail(*args, **kwargs):
        raise GrocyError("timeout", "查询失败")

    monkeypatch.setattr(Grocy, "request", fail)
    worker = StockReconciler(service.writer)
    worker.start()
    worker.stop()
    assert service.get(doc["id"])["status"] == "unknown"
    assert service.reconcile(doc["id"])["status"] == "unknown"
    assert service.get(doc["id"])["attempts"] == 0
    with pytest.raises(ValueError, match="禁止重发"):
        service.manual_retry(doc["id"], "已核对服务端停止且没有库存变化", True, True)
