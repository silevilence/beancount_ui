import subprocess

import pytest
from beancount_ui.advanced_query import QueryInput, advanced_query, execute_query
from beancount_ui.app import create_app
from beancount_ui.ledger import read_files
from fastapi.testclient import TestClient


def test_query_api_aggregation_precision_and_read_only(ledger):
    before = read_files(ledger.settings.ledger_dir)
    client = TestClient(create_app(ledger.settings))
    response = client.post(
        "/api/query",
        json={
            "query": "SELECT account, currency, sum(number) AS total "
            "GROUP BY account, currency ORDER BY account"
        },
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["columns"] == ["account", "currency", "total"]
    assert result["rows"] and all(isinstance(row[2], str) for row in result["rows"])
    precise = client.post(
        "/api/query", json={"query": "SELECT 0.123456789012345678 AS precise FROM #"}
    )
    assert precise.json()["rows"] == [["0.123456789012345678"]]
    assert read_files(ledger.settings.ledger_dir) == before


@pytest.mark.parametrize(
    "query",
    ["BALANCES", "JOURNAL 'Expenses:Food'", "SELECT date, position ORDER BY date DESC LIMIT 1"],
)
def test_supported_read_only_queries(ledger, query):
    snapshot = ledger.refresh()
    result = execute_query(snapshot.entries, snapshot.options, query)
    assert result["columns"] and result["rows"]


@pytest.mark.parametrize(
    "query",
    [
        "CREATE TABLE example (name str)",
        "INSERT INTO #postings VALUES (1)",
        "SELECT unknown_column",
        "SELECT 1;\nSELECT 2",
        "SELECT (",
    ],
)
def test_invalid_and_write_queries_fail(ledger, query):
    client = TestClient(create_app(ledger.settings))
    response = client.post("/api/query", json={"query": query})
    assert response.status_code == 422, response.text


def test_result_limit_and_stale_snapshot(ledger):
    snapshot = ledger.refresh()
    result = execute_query(snapshot.entries, snapshot.options, "SELECT date", limit=1)
    assert len(result["rows"]) == 1 and result["truncated"]
    path = ledger.settings.ledger_dir / ledger.entry
    path.write_text(path.read_text(encoding="utf-8") + "\ninvalid directive\n", encoding="utf-8")
    result = advanced_query(ledger, QueryInput(query="SELECT date LIMIT 1"))
    assert result["stale"] and result["available"]


def test_query_timeout(ledger, monkeypatch):
    ledger.refresh()

    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired("query", 10)

    monkeypatch.setattr("beancount_ui.advanced_query.subprocess.run", timeout)
    with pytest.raises(ValueError, match="10 秒"):
        advanced_query(ledger, QueryInput(query="SELECT date"))
