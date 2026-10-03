from datetime import date
from uuid import uuid4

import pytest
from beancount_ui.app import create_app
from beancount_ui.income import income_days
from beancount_ui.layout import Layout, default_layout
from beancount_ui.layout_config import (
    LayoutInput,
    activate_layout,
    configuration,
    preview_layout,
)
from beancount_ui.ledger import Ledger, LedgerError, read_files
from beancount_ui.models import BatchMutation
from beancount_ui.query import transactions
from beancount_ui.templates import recommendations
from beancount_ui.writer import Writer
from conftest import git
from fastapi.testclient import TestClient
from test_orders import process, purchase
from test_sync import backup, connect
from test_writer import mutation


def custom(entry="main.beancount"):
    value = default_layout().model_dump()
    value["entry"] = entry
    value["routes"]["ordinary"] = {
        "target": "journal/{year}-{month}.bean",
        "indexes": ["index.bean", "indexes/{year}.bean"],
    }
    for business in ("salary", "yuebao", "phone", "balance"):
        value["routes"][business] = {
            "target": f"business/{business}.beancount",
            "indexes": ["index.bean", "indexes/business.bean"],
        }
    return Layout.model_validate(value)


def enable(writer, layout):
    request = LayoutInput(layout=layout, day=date(2026, 10, 1))
    preview = preview_layout(writer, request)
    activate_layout(writer, request.model_copy(update={"token": preview["token"]}))
    return preview


@pytest.mark.parametrize("layout", [default_layout(), custom()])
@pytest.mark.parametrize("day", [date(2026, 10, 3), date(2027, 1, 2)])
def test_layout_preview_diffs_only_use_selected_date(ledger, monkeypatch, layout, day):
    monkeypatch.setattr("beancount_ui.layout_config.current_day", lambda: day)
    writer = Writer(ledger)
    before = read_files(writer.root)
    request = LayoutInput(layout=layout, day=day)
    preview = preview_layout(writer, request)
    expected_paths = {
        name for business in layout.routes for name in layout.chain(business, day, day)
    }
    assert set(preview["diffs"]) <= expected_paths
    assert layout.chain("ordinary", day, day)[-1] in preview["diffs"]
    assert str(day.year + 1) not in "".join(preview["diffs"].values())
    activate_layout(writer, request.model_copy(update={"token": preview["token"]}))
    assert read_files(writer.root) == before


@pytest.mark.parametrize("alternate", [False, True])
def test_same_business_requests_across_layouts_and_restore(ledger, alternate):
    writer = Writer(ledger)
    before = read_files(writer.root)
    if alternate:
        result = enable(writer, custom())
        assert result["routes"][0]["target"] == "journal/2026-10.bean"
        assert "indexes/2026.bean" in result["diffs"]
        assert "indexes/2027.bean" not in result["diffs"]
        assert read_files(writer.root) == before
    items = [
        ("ordinary", '2027-01-02 * "跨年"\n  Expenses:Food 1 CNY\n  Assets:Cash -1 CNY\n'),
        ("salary", '2026-10-01 * "奖金"\n  Assets:Bank 1 CNY\n  Income:Salary\n'),
        ("yuebao", '2026-10-01 * "收益"\n  Assets:Yuebao 1 CNY\n  Income:Interest\n'),
        ("phone", '2026-10-01 * "话费"\n  Expenses:Phone 1 CNY\n  Assets:Cash -1 CNY\n'),
        ("balance", "2020-01-03 balance Assets:Bank 1000 CNY\n"),
    ]
    request = BatchMutation(
        request_id=uuid4(),
        revision=ledger.refresh().revision,
        items=[{"business": b, "raw": raw} for b, raw in items],
    )
    preview = writer.preview(request)
    writer.commit(preview["request_id"])
    expected = custom() if alternate else default_layout()
    assert [item["target"] for item in preview["items"]] == [
        expected.chain(b, date.fromisoformat(raw[:10]))[-1] for b, raw in items
    ]
    assert not ledger.refresh().errors
    bonus = next(r for r in transactions(ledger.refresh()) if r["narration"] == "奖金")
    assert "salary" in bonus["tags"]
    for name, content in before.items():
        if name not in preview["diffs"]:
            assert read_files(writer.root)[name] == content
    if alternate:
        # Separate processes and restart use the persisted layout, not in-memory settings.
        restarted = Ledger(ledger.settings)
        assert configuration(Writer(restarted))["layout"] == custom().model_dump()
        preserved = read_files(writer.root)
        enable(writer, default_layout())
        assert read_files(writer.root) == preserved
        preview = Writer(restarted).preview(mutation(restarted))
        assert preview["target"] == "txs/2026/09.bean"
        Writer(restarted).commit(preview["request_id"])
        assert len(transactions(restarted.refresh())) == len(transactions(ledger.refresh()))


def test_nested_entry_orders_and_sync_use_configured_entry(sync):
    ledger, writer = sync.ledger, sync.writer
    connect(sync)
    root = writer.root
    (root / "config").mkdir()
    (root / "config/book.bean").write_text('include "../main.beancount"\n')
    enable(writer, custom("config/book.bean"))
    assert ledger.status()["entry"] == "config/book.bean"
    request = mutation(ledger)
    preview = writer.preview(request)
    writer.commit(preview["request_id"])
    assert not ledger.refresh().errors
    assert "journal/2026-09.bean" in ledger.refresh().included
    source = purchase(ledger)
    assert source["file"] == "journal/2026-09.bean"
    assert process(ledger, source, "settle", "100")["target"] == "journal/2026-09.bean"
    assert sync.candidate([])[1].errors == []
    (root / "extra.bean").write_text("; extra\n")
    files, candidate = sync.candidate(["extra.bean"])
    assert 'include "../extra.bean"' in files["config/book.bean"].decode()
    assert "extra.bean" in candidate.included
    assert backup(sync)["sync"] == "已同步"
    # Pure include wrappers can be dropped when switching back; data stays included.
    enable(writer, default_layout())
    assert "journal/2026-09.bean" in ledger.refresh().included


def test_old_income_stays_recognized_after_switch_and_edit(ledger):
    writer = Writer(ledger)
    enable(writer, custom())
    request = mutation(
        ledger,
        entry=None,
        business="yuebao",
        raw=('2026-10-01 * "收益"\n  Assets:Yuebao 1 CNY\n  Income:Interest\n'),
    )
    writer.commit(writer.preview(request)["request_id"])
    enable(writer, default_layout())
    snapshot = ledger.refresh()
    row = income_days(snapshot, date(2026, 10, 1), date(2026, 10, 1))[0]["records"][0]
    assert row["file"] == "business/yuebao.beancount"
    assert any(r["business"] == "yuebao" for r in recommendations(snapshot, date(2026, 10, 2)))
    with pytest.raises(LedgerError, match="已有余额宝"):
        writer.preview(
            request.model_copy(update={"request_id": uuid4(), "revision": snapshot.revision})
        )
    revised = row["raw"].replace("1 CNY", "2 CNY")
    preview = writer.preview(
        mutation(ledger, operation="edit", transaction_id=row["id"], entry=None, raw=revised)
    )
    assert preview["target"] == row["file"]
    writer.commit(preview["request_id"])
    other = mutation(
        ledger, entry=None, business="yuebao", raw=request.raw.replace("10-01", "10-02")
    )
    writer.commit(writer.preview(other)["request_id"])
    row = next(
        r for r in transactions(ledger.refresh()) if r["file"] == "business/yuebao.beancount"
    )
    with pytest.raises(LedgerError, match="重复日期"):
        writer.preview(
            mutation(
                ledger,
                operation="edit",
                transaction_id=row["id"],
                entry=None,
                raw=row["raw"].replace("10-01", "10-02"),
            )
        )


@pytest.mark.parametrize(
    "target",
    [
        "../escape.bean",
        "/absolute.bean",
        "C:/drive.bean",
        "x\\y.bean",
        ".git/config.bean",
        "a/../b.bean",
        "a//b.bean",
        "a./b.bean",
        "con.bean",
        "NUL/a.bean",
        "x.txt",
        'quote".bean',
        "*.bean",
        "{hour}.bean",
        "{year}/{year}/{month}.bean",
        "gnucash/{year}/{month}.bean",
    ],
)
def test_reject_invalid_paths(target):
    config = custom().model_dump()
    config["routes"]["ordinary"]["target"] = target
    with pytest.raises(ValueError):
        Layout.model_validate(config)


@pytest.mark.parametrize("kind", ["business", "dated", "case", "index", "ancestor", "cycle"])
def test_reject_overlapping_rules_for_any_date(kind):
    config = custom().model_dump()
    if kind == "business":
        config["routes"]["salary"]["target"] = config["routes"]["phone"]["target"]
    elif kind == "dated":
        config["routes"]["salary"]["target"] = "journal/2099-12.bean"
    elif kind == "case":
        config["routes"]["salary"]["target"] = "BUSINESS/PHONE.beancount"
    elif kind == "index":
        config["routes"]["ordinary"]["indexes"].append("journal/{year}-{month}.bean")
    elif kind == "ancestor":
        config["routes"]["salary"]["target"] = "business/phone.beancount/child.bean"
    else:
        config["routes"]["salary"]["indexes"] = ["indexes/business.bean", "index.bean"]
    with pytest.raises(ValueError, match="冲突|循环"):
        Layout.model_validate(config)


def test_failed_activation_and_stale_previews_preserve_layout_and_files(ledger):
    writer = Writer(ledger)
    old_preview = writer.preview(mutation(ledger))
    before = read_files(writer.root)
    request = LayoutInput(layout=custom(), day=date(2026, 10, 1))
    preview = preview_layout(writer, request)
    with pytest.raises(LedgerError, match="预览"):
        activate_layout(writer, request)
    assert configuration(writer)["layout"] == default_layout().model_dump()
    assert read_files(writer.root) == before
    enable(writer, custom())
    with pytest.raises(LedgerError, match="布局已变化"):
        writer.commit(old_preview["request_id"])
    with pytest.raises(LedgerError, match="已变化"):
        activate_layout(writer, request.model_copy(update={"token": preview["token"]}))
    assert read_files(writer.root) == before
    config_before = (writer.state / "layout.json").read_bytes()
    invalid = custom().model_dump()
    invalid["routes"]["phone"]["target"] = "txs/category/yuebao.bean"
    with pytest.raises(ValueError, match="冲突"):
        enable(writer, Layout.model_validate(invalid))
    assert (writer.state / "layout.json").read_bytes() == config_before


def test_entry_validation_external_changes_and_corrupt_state(ledger):
    writer = Writer(ledger)
    with pytest.raises(LedgerError, match="入口文件必须已存在"):
        enable(writer, custom("absent.bean"))
    (writer.root / "empty.bean").write_text("; no historical data\n")
    with pytest.raises(LedgerError, match="历史"):
        enable(writer, custom("empty.bean"))
    (writer.root / "broken.bean").write_text('include "absent.bean"\n')
    with pytest.raises(LedgerError, match="校验失败"):
        enable(writer, custom("broken.bean"))
    request = LayoutInput(layout=custom(), day=date(2026, 10, 1))
    preview = preview_layout(writer, request)
    (writer.root / "external.bean").write_text("; external\n")
    with pytest.raises(LedgerError, match="已变化"):
        activate_layout(writer, request.model_copy(update={"token": preview["token"]}))
    (writer.state / "layout.json").write_text("{}")
    with pytest.raises(LedgerError, match="布局状态损坏"):
        ledger.refresh()


def test_layout_api_preview_activate_restart_and_validation(ledger):
    client = TestClient(create_app(ledger.settings))
    current = client.get("/api/layout").json()
    assert current["layout"] == current["default"]
    payload = {"layout": custom().model_dump(), "day": "2026-10-01"}
    preview = client.post("/api/layout/preview", json=payload)
    assert preview.status_code == 200, preview.text
    assert client.post("/api/layout/activate", json=payload).status_code == 409
    assert (
        client.post(
            "/api/layout/activate", json=payload | {"token": preview.json()["token"]}
        ).status_code
        == 200
    )
    assert (
        TestClient(create_app(ledger.settings)).get("/api/layout").json()["layout"]
        == payload["layout"]
    )
    payload["layout"]["routes"]["phone"]["target"] = "../bad.bean"
    rejected = client.post("/api/layout/activate", json=payload)
    assert rejected.status_code == 422
    assert "非法账本路径" in rejected.json()["detail"]
    assert isinstance(rejected.json()["detail"], str)


@pytest.mark.parametrize(
    "kind", ["file", "directory", "alias", "cycle", "duplicate", "next_year"]
)
def test_existing_paths_and_include_graph_conflicts(ledger, kind):
    writer = Writer(ledger)
    if kind == "file":
        (writer.root / "journal").write_text("occupied")
    elif kind == "directory":
        (writer.root / "business/yuebao.beancount").mkdir(parents=True)
    elif kind == "alias":
        (writer.root / "Journal").mkdir()
    elif kind == "cycle":
        (writer.root / "indexes").mkdir()
        (writer.root / "indexes/business.bean").write_text('include "../main.beancount"\n')
    elif kind == "next_year":
        (writer.root / "indexes").mkdir()
        (writer.root / "indexes/2027.bean").write_text('include "../main.beancount"\n')
    else:
        path = writer.root / "main.beancount"
        path.write_bytes(path.read_bytes() + b'\ninclude "index.bean"\n')
    before = read_files(writer.root)
    with pytest.raises(LedgerError, match="冲突|校验失败"):
        enable(writer, custom())
    assert read_files(writer.root) == before
    assert not (writer.state / "layout.json").exists()


@pytest.mark.parametrize("stop_after", [1, 2, 3])
def test_custom_layout_crash_recovery(ledger, monkeypatch, stop_after):
    writer = Writer(ledger)
    enable(writer, custom())
    preview = writer.preview(mutation(ledger))
    original = writer.write_part
    count = 0

    def crash(*args):
        nonlocal count
        original(*args)
        count += 1
        if count == stop_after:
            raise SystemExit("interrupted")

    monkeypatch.setattr(writer, "write_part", crash)
    with pytest.raises(SystemExit):
        writer.commit(preview["request_id"])
    restarted = Ledger(ledger.settings)
    replacement = Writer(restarted)
    assert replacement.commit(preview["request_id"])["status"] == "done"
    assert len([r for r in transactions(restarted.refresh()) if r["payee"] == "测试商户"]) == 1
    assert not restarted.refresh().errors


def test_entry_switch_preserves_valid_unpushed_history(sync):
    connect(sync)
    writer, ledger = sync.writer, sync.ledger
    writer.commit(writer.preview(mutation(ledger))["request_id"])
    git(writer.root, "add", ".")
    git(writer.root, "commit", "-m", "pending valid ledger")
    (writer.root / "config").mkdir()
    (writer.root / "config/book.bean").write_text('include "../main.beancount"\n')
    enable(writer, custom("config/book.bean"))
    writer.commit(writer.preview(mutation(ledger))["request_id"])
    assert backup(sync)["sync"] == "已同步"
    assert not ledger.refresh().errors
