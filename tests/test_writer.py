from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from beancount_ui.app import create_app
from beancount_ui.ledger import LedgerError, read_files
from beancount_ui.models import Mutation
from beancount_ui.query import transactions
from beancount_ui.writer import Writer
from fastapi.testclient import TestClient


def mutation(ledger, **changes):
    values = {
        "request_id": str(uuid4()),
        "revision": ledger.refresh().revision,
        "entry": {
            "date": "2026-09-30",
            "payee": "测试商户",
            "narration": "晚饭",
            "amount": "0.10",
            "currency": "CNY",
            "category": "Expenses:Food",
            "payment": "Assets:Cash",
            "note": "备注",
        },
    }
    values.update(changes)
    return Mutation.model_validate(values)


def test_preview_commit_retry_and_new_month(ledger):
    writer = Writer(ledger)
    before = read_files(ledger.settings.ledger_dir)
    request = mutation(ledger)
    preview = writer.preview(request)
    assert preview["target"] == "txs/2026/09.bean"
    assert set(preview["diffs"]) == {"txs/2026/index.bean", "txs/2026/09.bean"}
    assert read_files(ledger.settings.ledger_dir) == before
    result = writer.commit(preview["request_id"])
    assert result["status"] == "done"
    assert writer.commit(preview["request_id"]) == result
    assert Writer(ledger).preview(request)["status"] == "done"
    rows = transactions(ledger.refresh())
    assert sum(row["payee"] == "测试商户" for row in rows) == 1
    for name, content in before.items():
        if name not in preview["diffs"]:
            assert (ledger.settings.ledger_dir / name).read_bytes() == content
    assert not ledger.refresh().errors


@pytest.mark.parametrize(
    "business,raw,target",
    [
        (
            "ordinary",
            '2027-01-02 * "跨年"\n  Expenses:Food 1 CNY\n  Assets:Cash -1 CNY\n',
            "txs/2027/01.bean",
        ),
        (
            "salary",
            '2026-09-30 * "奖金"\n  Assets:Bank 1 CNY\n  Income:Salary\n',
            "txs/category/salary.bean",
        ),
        (
            "yuebao",
            '2026-09-30 * "收益"\n  Assets:Yuebao 1 CNY\n  Income:Interest\n',
            "txs/category/yuebao.bean",
        ),
        (
            "phone",
            '2026-09-30 * "话费"\n  Expenses:Phone 1 CNY\n  Assets:Cash -1 CNY\n',
            "txs/category/phone.bean",
        ),
        ("balance", "2020-01-03 balance Assets:Bank 1000 CNY\n", "txs/category/balance.bean"),
    ],
)
def test_routes(ledger, business, raw, target):
    writer = Writer(ledger)
    preview = writer.preview(mutation(ledger, entry=None, raw=raw, business=business))
    writer.commit(preview["request_id"])
    assert preview["target"] == target
    assert not ledger.refresh().errors
    if business == "salary":
        assert (
            "salary"
            in next(row for row in transactions(ledger.refresh()) if row["narration"] == "奖金")[
                "tags"
            ]
        )


@pytest.mark.parametrize(
    "raw",
    [
        '2026-09-30 * "bad"\n  Expenses:Food 2 CNY\n  Assets:Cash -1 CNY\n',
        '2026-09-30 * "bad"\n  Expenses:Missing 1 CNY\n  Assets:Cash -1 CNY\n',
        'include "evil.bean"\n',
        '2026-09-30 * "one"\n  Expenses:Food 1 CNY\n  Assets:Cash -1 CNY\n2026-09-30 * "two"\n',
    ],
)
def test_invalid_candidate_unchanged(ledger, raw):
    before = read_files(ledger.settings.ledger_dir)
    with pytest.raises(LedgerError):
        Writer(ledger).preview(mutation(ledger, entry=None, raw=raw))
    assert read_files(ledger.settings.ledger_dir) == before


def test_external_change_and_id_collision(ledger):
    writer = Writer(ledger)
    request = mutation(ledger)
    preview = writer.preview(request)
    with pytest.raises(LedgerError, match="不同内容"):
        writer.preview(request.model_copy(update={"business": "phone"}))
    path = ledger.settings.ledger_dir / "main.beancount"
    path.write_bytes(path.read_bytes() + b"\n; user edit\n")
    before = read_files(ledger.settings.ledger_dir)
    with pytest.raises(LedgerError, match="修改"):
        writer.commit(preview["request_id"])
    assert read_files(ledger.settings.ledger_dir) == before
    with pytest.raises(LedgerError, match="变化"):
        writer.preview(request.model_copy(update={"request_id": uuid4()}))


def test_concurrent_writers_one_wins(ledger):
    writer = Writer(ledger)
    previews = [writer.preview(mutation(ledger)) for _ in range(2)]

    def save(preview):
        try:
            return Writer(ledger).commit(preview["request_id"])["status"]
        except LedgerError:
            return "conflict"

    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(save, previews)) == ["conflict", "done"]
    assert sum(row["payee"] == "测试商户" for row in transactions(ledger.refresh())) == 1


@pytest.mark.parametrize("stop_after", [1, 2, 3])
def test_crash_recovery_completes_once(ledger, monkeypatch, stop_after):
    writer = Writer(ledger)
    preview = writer.preview(
        mutation(
            ledger,
            entry=None,
            raw='2027-01-02 * "跨年"\n  Expenses:Food 1 CNY\n  Assets:Cash -1 CNY\n',
        )
    )
    original = writer.write_part
    count = 0

    def crash(name, before, after):
        nonlocal count
        original(name, before, after)
        count += 1
        if count == stop_after:
            raise SystemExit("simulated process death")

    monkeypatch.setattr(writer, "write_part", crash)
    with pytest.raises(SystemExit):
        writer.commit(preview["request_id"])
    replacement = Writer(ledger)
    with replacement.guard():
        assert not ledger.refresh().errors
    assert replacement.commit(preview["request_id"])["status"] == "done"
    assert sum(row["narration"] == "跨年" for row in transactions(ledger.refresh())) == 1


def test_recovery_preserves_external_edit(ledger, monkeypatch):
    writer = Writer(ledger)
    preview = writer.preview(mutation(ledger))

    def crash(*args):
        raise SystemExit()

    monkeypatch.setattr(writer, "write_part", crash)
    with pytest.raises(SystemExit):
        writer.commit(preview["request_id"])
    path = ledger.settings.ledger_dir / "txs/2026/index.bean"
    path.write_bytes(path.read_bytes() + b"\n; external change")
    before = read_files(ledger.settings.ledger_dir)
    with pytest.raises(LedgerError, match="外部修改"):
        Writer(ledger).commit(preview["request_id"])
    assert read_files(ledger.settings.ledger_dir) == before


def test_include_normalization_and_crlf_salary(ledger):
    path = ledger.settings.ledger_dir / "txs/2026/index.bean"
    path.write_bytes(b'include "./08.bean"\r\n')
    writer = Writer(ledger)
    request = mutation(ledger)
    request.entry.date = __import__("datetime").date(2026, 8, 30)
    preview = writer.preview(request)
    assert set(preview["diffs"]) == {"txs/2026/08.bean"}
    writer.commit(preview["request_id"])
    path = ledger.settings.ledger_dir / "txs/category/salary.bean"
    path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n"))
    preview = writer.preview(
        mutation(
            ledger,
            entry=None,
            business="salary",
            raw='2026-09-30 * "bonus"\n  Assets:Bank 1 CNY\n  Income:Salary\n',
        )
    )
    writer.commit(preview["request_id"])
    assert b"\r\n" in path.read_bytes()
    assert not ledger.refresh().errors


def test_api_and_decimal_validation(ledger):
    client = TestClient(create_app(ledger.settings))
    payload = mutation(ledger).model_dump(mode="json")
    payload["entry"]["amount"] = 0.1
    assert client.post("/api/preview", json=payload).status_code == 422
    payload["entry"]["amount"] = "0.1"
    preview = client.post("/api/preview", json=payload)
    assert preview.status_code == 200
    assert (
        client.post("/api/commit", json={"request_id": payload["request_id"]}).json()["status"]
        == "done"
    )
    assert client.get("/api/journal?day=2026-09-30").json()["expenses"] == {"CNY": "25.60"}
