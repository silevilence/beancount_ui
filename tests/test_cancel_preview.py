from uuid import uuid4

from beancount_ui.app import create_app
from beancount_ui.writer import Writer
from fastapi.testclient import TestClient
from test_writer import mutation


def test_cancel_stale_preview_does_not_write_and_blocks_old_commit(ledger):
    writer = Writer(ledger)
    client = TestClient(create_app(ledger.settings))
    preview = writer.preview(mutation(ledger))
    other = writer.preview(mutation(ledger, raw=None))
    writer.commit(other["request_id"])
    before = ledger.refresh().revision
    body = {"request_id": preview["request_id"]}
    assert client.post("/api/preview/cancel", json=body).json()["status"] == "cancelled"
    assert client.post("/api/commit", json=body).status_code == 409
    assert ledger.refresh().revision == before
    assert client.post("/api/preview/cancel", json=body).json()["status"] == "cancelled"
    assert (
        client.post("/api/preview/cancel", json={"request_id": other["request_id"]}).json()[
            "status"
        ]
        == "done"
    )
    assert client.post("/api/preview/cancel", json={"request_id": str(uuid4())}).status_code == 409
