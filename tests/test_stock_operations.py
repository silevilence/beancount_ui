from concurrent.futures import ThreadPoolExecutor
from threading import Event
from uuid import uuid4

import pytest
from beancount_ui.grocy import Grocy, GrocyError, GrocyInput
from beancount_ui.stock_operations import StockOperations, enqueue
from beancount_ui.writer import Writer


@pytest.fixture
def operation(ledger):
    writer = Writer(ledger)
    service = StockOperations(writer)
    service.grocy.save(GrocyInput(url="http://nas", api_key="secret", enabled=True))
    identity = str(uuid4())
    doc = {
        "id": identity,
        "receipt_id": "receipt",
        "instance_id": service.grocy.status()["instance_id"],
        "product_id": 1,
        "action": "add",
        "payload": {
            "amount": "3",
            "price": "5",
            "location_id": 1,
            "purchased_date": "2026-10-19",
            "best_before_date": "2026-11-19",
            "transaction_type": "purchase",
            "note": "beancount-ui-receipt:" + identity,
        },
    }
    with writer.database() as db:
        enqueue(db, doc)
    return service, doc


def test_durable_dispatch_and_full_response_no_duplicate(operation, monkeypatch):
    service, doc = operation
    calls = []
    logs = [{"id": 1, "transaction_id": "tx"}, {"id": 2, "transaction_id": "tx"}]
    monkeypatch.setattr(Grocy, "request", lambda *args, **kwargs: calls.append(args) or logs)
    result = service.send(doc["id"])
    assert result["evidence"]["response"] == logs
    assert result["status"] == "unknown"
    StockOperations(service.writer).send(doc["id"])
    assert len(calls) == 1
    with service.writer.database() as db, pytest.raises(ValueError, match="不同内容"):
        enqueue(db, doc | {"product_id": 2})


def test_single_sender_under_concurrency(operation, monkeypatch):
    service, doc = operation
    entered, release = Event(), Event()
    calls = []

    def remote(*args, **kwargs):
        calls.append(args)
        entered.set()
        assert release.wait(5)
        return []

    monkeypatch.setattr(Grocy, "request", remote)
    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(service.send, doc["id"])
        assert entered.wait(5)
        second = pool.submit(service.send, doc["id"])
        assert second.result(timeout=3)["status"] == "sending"
        release.set()
        first.result(timeout=5)
    assert len(calls) == 1


def test_crash_after_dispatch_never_resends(operation, monkeypatch):
    service, doc = operation

    def crash(*args, **kwargs):
        raise KeyboardInterrupt()

    monkeypatch.setattr(Grocy, "request", crash)
    with pytest.raises(KeyboardInterrupt):
        service.send(doc["id"])
    assert StockOperations(service.writer).send(doc["id"])["status"] == "sending"


@pytest.mark.parametrize("unsent", [True, False])
def test_only_proven_unsent_failures_allow_resend(operation, monkeypatch, unsent):
    service, doc = operation
    calls = []

    def fail(*args, **kwargs):
        calls.append(args)
        raise GrocyError("timeout", "断连", unsent=unsent)

    monkeypatch.setattr(Grocy, "request", fail)
    assert service.send(doc["id"])["status"] == ("failed" if unsent else "unknown")
    service.send(doc["id"])
    assert len(calls) == (2 if unsent else 1)
