import json
import socket
from urllib.error import HTTPError, URLError

import pytest
from beancount_ui.app import create_app
from beancount_ui.grocy import Grocy, GrocyError, GrocyInput
from fastapi.testclient import TestClient


@pytest.fixture
def grocy(tmp_path):
    client = Grocy(tmp_path / "state")
    client.save(GrocyInput(url="http://nas/grocy/", api_key="secret", enabled=True))
    return client


def test_credentials_persistence_and_instance_binding(grocy):
    state = grocy.status()
    assert state["url"] == "http://nas/grocy"
    assert state["key_configured"] and "secret" not in json.dumps(state)
    assert Grocy(grocy.state).read()["api_key"] == "secret"
    grocy.bind(state["instance_id"])
    with pytest.raises(ValueError, match="已有商品"):
        grocy.save(GrocyInput(url="http://other", api_key="new", enabled=True))
    grocy.save(GrocyInput(url=state["url"], enabled=False, clear_key=True))
    assert not grocy.status()["key_configured"]
    with pytest.raises(GrocyError, match="停用"):
        grocy.request("stock")


def test_switch_clears_key_and_changes_identity(grocy):
    before = grocy.status()["instance_id"]
    state = grocy.save(GrocyInput(url="https://new/grocy"))
    assert not state["key_configured"] and state["instance_id"] != before


def test_full_stock_log_keyset_paging_preserves_external_and_undone(grocy, monkeypatch):
    from urllib.parse import parse_qs, urlsplit

    history = [
        {"id": str(i), "product_id": "8", "note": "来自 Grocy", "undone": "1"}
        for i in range(201, 0, -1)
    ]

    def request(path, method="GET", payload=None):
        assert method == "GET" and payload is None
        assert path.startswith("objects/stock_log?")
        params = parse_qs(urlsplit(path).query)
        assert params["order"] == ["id:desc"] and params["limit"] == ["101"]
        filters = params.get("query[]", [])
        assert "product_id=8" in filters
        before = next((int(value[3:]) for value in filters if value.startswith("id<")), 999)
        return [row for row in history if int(row["id"]) < before][:101]

    monkeypatch.setattr(grocy, "request", request)
    first = grocy.stock_log(product_id=8)
    assert len(first["entries"]) == 100 and first["next_before"] == 102
    history.insert(0, {"id": "202", "product_id": "8"})
    second = grocy.stock_log(before=first["next_before"], product_id=8)
    third = grocy.stock_log(before=second["next_before"], product_id=8)
    assert len(second["entries"]) == 100 and len(third["entries"]) == 1
    assert third["next_before"] is None
    assert first["entries"][0]["note"] == "来自 Grocy"
    assert first["entries"][0]["undone"] == "1"


def test_stock_log_query_validation_and_transport_error(ledger, monkeypatch):
    client = TestClient(create_app(ledger.settings))
    assert client.get("/api/grocy/stock-log?before=0").status_code == 422
    assert client.get("/api/grocy/stock-log?product_id=-1").status_code == 422

    def unavailable(*args, **kwargs):
        raise GrocyError("unreachable", "日志不可用")

    monkeypatch.setattr(Grocy, "stock_log", unavailable)
    assert "日志不可用" in client.get("/api/grocy/stock-log").text


@pytest.mark.parametrize("url", ["ftp://nas", "http://user:secret@nas", "http://nas/?key=secret"])
def test_url_secrets_rejected(url):
    with pytest.raises(ValueError):
        GrocyInput(url=url)


def test_transport_subpath_and_no_redirect(grocy, monkeypatch):
    class Reply:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def read(self, limit):
            return b'{"ok": true}'

    class Opener:
        def open(self, request, timeout):
            assert request.full_url == "http://nas/grocy/api/stock"
            assert request.get_header("Grocy-api-key") == "secret"
            assert timeout == 12
            return Reply()

    monkeypatch.setattr("beancount_ui.grocy.build_opener", lambda *args: Opener())
    assert grocy.request("stock") == {"ok": True}


@pytest.mark.parametrize(
    "exc,code,unsent",
    [
        (HTTPError("secret", 401, "secret", {}, None), "credentials", False),
        (HTTPError("secret", 403, "secret", {}, None), "permission", False),
        (HTTPError("secret", 500, "secret", {}, None), "remote_error", False),
        (HTTPError("secret", 302, "secret", {}, None), "remote_error", False),
        (TimeoutError("secret"), "timeout", False),
        (URLError(socket.gaierror("secret")), "unreachable", True),
    ],
)
def test_transport_failure_redacted(grocy, monkeypatch, exc, code, unsent):
    class Opener:
        def open(self, *args, **kwargs):
            raise exc

    monkeypatch.setattr("beancount_ui.grocy.build_opener", lambda *args: Opener())
    with pytest.raises(GrocyError) as raised:
        grocy.request("stock", "POST", {})
    assert raised.value.code == code and raised.value.unsent == unsent
    assert "secret" not in str(raised.value)


def test_check_reads_only_and_detects_version(grocy, monkeypatch):
    version = "4.7.1"
    paths = []

    def request(path, method="GET", payload=None, **kwargs):
        assert method == "GET" and payload is None
        paths.append(path)
        return {"grocy_version": {"Version": version}} if path == "system/info" else []

    monkeypatch.setattr(grocy, "request", request)
    assert grocy.check()["version"] == "4.7.1"
    assert "stock/volatile" in paths
    version = "5.0.0"
    assert not grocy.check()["compatible"]


def test_config_api_redaction(ledger):
    client = TestClient(create_app(ledger.settings))
    result = client.post(
        "/api/grocy/config", json={"url": "http://nas/grocy", "api_key": "secret", "enabled": True}
    )
    assert result.status_code == 200 and "secret" not in result.text
    invalid = client.post("/api/grocy/config", json={"api_key": {"secret": "secret"}})
    assert invalid.status_code == 422 and "secret" not in invalid.text


def test_inventory_reads_fresh_and_failure_is_not_empty(grocy, monkeypatch):
    calls = []

    def request(path):
        calls.append(path)
        return {"CURRENCY": "CNY"} if path == "system/config" else []

    monkeypatch.setattr(grocy, "request", request)
    assert grocy.inventory()["instance_id"] == grocy.status()["instance_id"]
    assert grocy.product(12)["entries"] == []
    assert "stock/products/12/entries" in calls
    monkeypatch.setattr(
        grocy, "request", lambda path: (_ for _ in ()).throw(GrocyError("timeout", "断连"))
    )
    with pytest.raises(GrocyError):
        grocy.inventory()
