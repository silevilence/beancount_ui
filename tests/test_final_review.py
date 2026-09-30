import subprocess
from datetime import date
from uuid import uuid4

import pytest
from beancount_ui.app import create_app
from beancount_ui.config import Settings
from beancount_ui.ledger import LedgerError, load_snapshot, read_files
from beancount_ui.models import Mutation
from beancount_ui.query import transactions
from beancount_ui.writer import Writer
from fastapi.testclient import TestClient


def request(ledger, **overrides):
    return Mutation.model_validate(
        {
            "request_id": str(uuid4()),
            "revision": ledger.refresh().revision,
            "raw": '2027-02-01 * "crash"\n  Expenses:Food 1 CNY\n  Assets:Cash -1 CNY\n',
            **overrides,
        }
    )


def test_actual_process_exit_recovery(ledger):
    writer = Writer(ledger)
    preview = writer.preview(request(ledger))
    script = """
import os, sys
from pathlib import Path
from beancount_ui.config import Settings
from beancount_ui.ledger import Ledger
from beancount_ui.writer import Writer
writer=Writer(Ledger(Settings(Path(sys.argv[1]), Path(sys.argv[2]))))
original=writer.write_part
def die(*args):
    original(*args)
    os._exit(19)
writer.write_part=die
writer.commit(sys.argv[3])
"""
    completed = subprocess.run(
        [
            "uv",
            "run",
            "python",
            "-c",
            script,
            str(ledger.settings.ledger_dir),
            str(ledger.settings.state_dir),
            preview["request_id"],
        ],
        capture_output=True,
        timeout=30,
    )
    assert completed.returncode == 19, completed.stderr
    client = TestClient(create_app(ledger.settings))
    assert client.get("/api/ledger").json()["writable"]
    assert Writer(ledger).commit(preview["request_id"])["status"] == "done"
    assert sum(row["narration"] == "crash" for row in transactions(ledger.refresh())) == 1


def test_http_boundaries_and_errors(ledger, monkeypatch):
    client = TestClient(create_app(ledger.settings))
    assert client.get("/api/ledger", headers={"Host": "evil.example"}).status_code == 400
    assert (
        client.post("/api/preview", headers={"Origin": "https://evil.example"}, json={}).status_code
        == 403
    )
    assert client.get("/api/health", headers={"Origin": "http://127.0.0.1:5173"}).status_code == 200
    assert client.post("/api/commit", json={"request_id": str(uuid4())}).status_code == 409
    monkeypatch.delenv("BEANCOUNT_LEDGER_DIR", raising=False)
    assert TestClient(create_app()).get("/api/ledger").status_code == 422
    monkeypatch.setenv("BEANCOUNT_LEDGER_DIR", str(ledger.settings.ledger_dir))
    monkeypatch.setenv("BEANCOUNT_STATE_DIR", str(ledger.settings.state_dir))
    assert TestClient(create_app()).get("/api/ledger").status_code == 200


def test_invalid_startup_is_a_diagnostic_not_a_crash(ledger):
    path = ledger.settings.ledger_dir / "txs/2026/08.bean"
    path.write_bytes(path.read_bytes() + b'\n2026-09-30 * "oops"\n  Assets:Cash\n  Expenses:Food\n')
    client = TestClient(create_app(ledger.settings))
    result = client.get("/api/journal?day=2026-09-30")
    assert result.status_code == 200
    assert result.json()["stale"] and result.json()["transactions"] == []
    with pytest.raises(LedgerError, match="存在错误"):
        Writer(ledger).preview(request(ledger))


def test_unknown_content_and_directory_protection(ledger, tmp_path):
    with pytest.raises(LedgerError, match="越界"):
        load_snapshot({"../outside.bean": b"; nope"})
    original = ledger.settings
    from beancount_ui.ledger import Ledger

    Writer(ledger)
    with pytest.raises(LedgerError, match="其他账本"):
        Writer(Ledger(Settings(tmp_path / "other", original.state_dir)))


def test_noop_basic_edit_and_inferred_metadata(ledger):
    path = ledger.settings.ledger_dir / "txs/2026/08.bean"
    path.write_bytes(
        path.read_bytes()
        + b'\n2026-09-30 ! "shop" "memo" #tag ^link\n  memo: "before"\n'
        + b'  custom: "keep"\n  Expenses:Food 2 CNY ; item\n'
        + b'    memo: "posting"\n  Assets:Cash'
    )
    row = next(r for r in transactions(ledger.refresh()) if r["payee"] == "shop")
    entry = {
        "date": "2026-09-30",
        "payee": "shop",
        "narration": "memo",
        "amount": "2",
        "currency": "CNY",
        "category": "Expenses:Food",
        "payment": "Assets:Cash",
        "note": "before",
    }
    writer = Writer(ledger)
    before = read_files(ledger.settings.ledger_dir)
    preview = writer.preview(
        request(ledger, operation="edit", transaction_id=row["id"], raw=None, entry=entry)
    )
    assert preview["diffs"] == {}
    writer.commit(preview["request_id"])
    assert before == read_files(ledger.settings.ledger_dir)
    entry.update(amount="3", note="after")
    preview = writer.preview(
        request(ledger, operation="edit", transaction_id=row["id"], raw=None, entry=entry)
    )
    writer.commit(preview["request_id"])
    content = path.read_text(encoding="utf-8")
    assert "#tag ^link" in content and 'custom: "keep"' in content and 'memo: "posting"' in content
    assert 'memo: "after"' in content and "Expenses:Food 3 CNY ; item" in content
    assert content.endswith("  Assets:Cash\n")
    assert not ledger.refresh().errors


def test_salary_scope_new_and_ambiguous():
    from beancount_ui.layout import insert_new

    files = {}
    insert_new(files, "salary", date(2026, 9, 30), '2026-09-30 * "salary"\n')
    assert b"pushtag #salary" in files["txs/category/salary.bean"]
    files["txs/category/salary.bean"] = (
        b"pushtag #salary\npoptag #salary\npushtag #salary\npoptag #salary\n"
    )
    with pytest.raises(LedgerError, match="范围不明确"):
        insert_new(files, "salary", date(2026, 9, 30), '2026-09-30 * "salary"\n')
