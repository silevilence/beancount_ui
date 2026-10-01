"""Business configuration exercised through the real preview/commit boundary."""

import hashlib
import json
from datetime import date
from uuid import uuid4

import pytest
from beancount_ui.income import income_days
from beancount_ui.layout import Layout, default_layout
from beancount_ui.layout_config import configuration
from beancount_ui.ledger import LedgerError, read_files
from beancount_ui.models import BatchMutation
from beancount_ui.query import transactions
from beancount_ui.record_template import RecordTemplate, TemplateField, current_day
from beancount_ui.writer import Writer
from test_layout import enable
from test_writer import mutation

SOURCE = '{{date}} * "固定消费"\n  Expenses:Food {{amount}} CNY\n  Assets:Cash {{-amount}} CNY\n'


def template(**changes):
    fields = {
        "date": {"label": "交易日期", "type": "date", "mode": "input"},
        "amount": {"label": "金额", "type": "amount", "mode": "input"},
    }
    fields.update(changes)
    return {"source": SOURCE, "fields": fields}


def configure(writer, business="ordinary", **route):
    value = configuration(writer)["layout"]
    value["routes"][business] = {"target": "a.bean", "indexes": [], **route}
    enable(writer, Layout.model_validate(value))
    return configuration(writer)["version"]


def request(ledger, version, values=None, **changes):
    return mutation(
        ledger,
        entry=None,
        layout_version=version,
        values=values if values is not None else {"date": "2026-09-30", "amount": "12.30"},
        **changes,
    )


@pytest.mark.parametrize("business", ["ordinary", "phone", "salary", "yuebao", "balance"])
@pytest.mark.parametrize("source", ["record", "write"])
def test_all_businesses_accept_fixed_and_dated_paths(business, source):
    value = default_layout().model_dump()
    value["routes"][business] = {
        "target": "records/{year}/{month}/{day}.bean",
        "date_source": source,
        "indexes": ["fixed.bean", "years/{year}.bean", "months/{year}/{month}.bean"],
    }
    layout = Layout.model_validate(value)
    expected = ("2020", "12", "31") if source == "record" else ("2027", "01", "01")
    year, month, day = expected
    assert layout.chain(business, date(2020, 12, 31), date(2027, 1, 1)) == [
        "main.beancount",
        "fixed.bean",
        f"years/{year}.bean",
        f"months/{year}/{month}.bean",
        f"records/{year}/{month}/{day}.bean",
    ]
    value["routes"][business] = {"target": "a.bean"}
    assert Layout.model_validate(value).chain(business, date(2020, 1, 1)) == [
        "main.beancount",
        "a.bean",
    ]
    if source == "write":
        with pytest.raises(ValueError, match="实际写入日期"):
            layout.chain(business, date(2020, 1, 1))


def test_partial_template_enforced_and_committed_to_fixed_file(ledger):
    writer = Writer(ledger)
    version = configure(writer, template=template())
    before = read_files(writer.root)
    for payload, message in [
        ({"raw": '2026-09-30 * "绕过"', "entry": None}, "模板表单"),
        ({}, "模板表单"),
        (
            {
                "values": {"date": "2026-09-30", "amount": "1", "category": "Expenses:Phone"},
                "entry": None,
                "layout_version": version,
            },
            "未开放",
        ),
        ({"values": {"date": "2026-09-30", "amount": "1"}, "entry": None}, "配置已变化"),
    ]:
        with pytest.raises(LedgerError, match=message):
            writer.preview(mutation(ledger, **payload))
    preview = writer.preview(request(ledger, version))
    assert read_files(writer.root) == before
    assert preview["target"] == "a.bean"
    assert "Expenses:Food 12.30 CNY" in preview["items"][0]["raw"]
    assert "Assets:Cash -12.30 CNY" in preview["items"][0]["raw"]
    writer.commit(preview["request_id"])
    assert not ledger.refresh().errors
    row = next(r for r in transactions(ledger.refresh()) if r["narration"] == "固定消费")
    # Historical correction stays in place and doesn't apply today's template.
    edit = mutation(
        ledger,
        operation="edit",
        transaction_id=row["id"],
        entry=None,
        raw=row["raw"].replace("固定消费", "更正"),
    )
    assert writer.preview(edit)["target"] == "a.bean"


def test_today_fields_and_write_paths_freeze_until_commit(ledger, monkeypatch):
    monkeypatch.setattr("beancount_ui.writer.current_day", lambda: date(2026, 12, 31))
    writer = Writer(ledger)
    fixed = template(date={"label": "交易日期", "type": "date", "mode": "today"})
    version = configure(
        writer,
        template=fixed,
        target="journal/{year}/{month}/{day}.bean",
        date_source="write",
        indexes=["fixed.bean", "years/{year}.bean", "months/{year}/{month}.bean"],
    )
    preview = writer.preview(request(ledger, version, {"amount": "1"}))
    assert preview["target"] == "journal/2026/12/31.bean"
    assert preview["items"][0]["raw"].startswith("2026-12-31")
    assert 'include "../months/2026/12.bean"' in preview["diffs"]["years/2026.bean"]
    before = read_files(writer.root)
    monkeypatch.setattr("beancount_ui.writer.current_day", lambda: date(2027, 1, 1))
    with pytest.raises(LedgerError, match="跨日"):
        writer.commit(preview["request_id"])
    assert read_files(writer.root) == before
    renewed = writer.preview(request(ledger, version, {"amount": "1"}))
    assert renewed["target"] == "journal/2027/01/01.bean"
    result = writer.commit(renewed["request_id"])
    monkeypatch.setattr("beancount_ui.writer.current_day", lambda: date(2027, 1, 2))
    assert writer.commit(renewed["request_id"]) == result
    assert not ledger.refresh().errors


def test_write_date_does_not_change_backdated_record_and_dynamic_income_remains_known(
    ledger, monkeypatch
):
    monkeypatch.setattr("beancount_ui.writer.current_day", lambda: date(2027, 1, 1))
    writer = Writer(ledger)
    configure(
        writer,
        "yuebao",
        target="income/{year}/{month}/{day}.bean",
        date_source="write",
        indexes=["index.bean", "income/{year}/index.bean"],
    )
    raw = '2026-10-01 * "动态收益"\n  Assets:Yuebao 1 CNY\n  Income:Interest\n'
    preview = writer.preview(mutation(ledger, entry=None, business="yuebao", raw=raw))
    assert preview["target"] == "income/2027/01/01.bean"
    assert preview["items"][0]["raw"].startswith("2026-10-01")
    writer.commit(preview["request_id"])
    configure(writer, "yuebao", target="other-yield.bean")
    with pytest.raises(LedgerError, match="已有余额宝收益"):
        writer.preview(mutation(ledger, entry=None, business="yuebao", raw=raw))
    assert (
        income_days(ledger.refresh(), date(2026, 10, 1), date(2026, 10, 1))[0]["records"][0][
            "narration"
        ]
        == "动态收益"
    )


def test_custom_business_batch_and_changed_definition(ledger):
    writer = Writer(ledger)
    version = configure(writer, "lunch", label="午餐", kind="ordinary", template=template())
    single = request(ledger, version, business="lunch")
    batch = BatchMutation(
        request_id=uuid4(),
        revision=single.revision,
        items=[{"business": "lunch", "values": single.values, "layout_version": version}],
    )
    preview = writer.preview(batch)
    assert preview["items"][0]["target"] == "a.bean"
    version2 = configure(writer, "lunch", template=template(), label="工作餐")
    assert version != version2
    with pytest.raises(LedgerError, match="布局已变化"):
        writer.commit(preview["request_id"])
    with pytest.raises(LedgerError, match="配置已变化"):
        writer.preview(single)
    with pytest.raises(LedgerError, match="记账语义"):
        configure(writer, "lunch", kind="salary")
    with pytest.raises(LedgerError, match="不存在"):
        writer.preview(mutation(ledger, business="missing"))
    with pytest.raises(LedgerError, match="未启用"):
        writer.preview(request(ledger, version2, business="phone"))


def test_complete_template_and_quoted_input_cannot_inject_directives(ledger):
    writer = Writer(ledger)
    config = {
        "source": "{{date}} {{flag}} {{payee}} {{note}} {{tag}}\n"
        "  {{category}} {{amount}} {{currency}}\n"
        "  {{payment}} {{-amount}} {{currency}}\n",
        "fields": {},
    }
    defs = {
        "date": ("date", "fixed", "2026-09-30"),
        "flag": ("token", "fixed", "!"),
        "payee": ("text", "input", ""),
        "note": ("text", "input", ""),
        "tag": ("token", "input", "#lunch"),
        "category": ("account", "input", "Expenses:Food"),
        "payment": ("account", "input", "Assets:Cash"),
        "amount": ("amount", "input", "1"),
        "currency": ("currency", "input", "CNY"),
    }
    config["fields"] = {
        key: {"label": key, "type": kind, "mode": mode, "value": value}
        for key, (kind, mode, value) in defs.items()
    }
    version = configure(writer, template=config)
    preview = writer.preview(
        request(
            ledger, version, {"payee": '商户"\n2026-10-01 open Assets:Evil', "note": "中文\\备注"}
        )
    )
    writer.commit(preview["request_id"])
    row = next(r for r in transactions(ledger.refresh()) if r["payee"].startswith("商户"))
    assert row["tags"] == ["lunch"]
    assert row["narration"] == "中文\\备注"
    assert not ledger.refresh().errors
    for values in [
        {"date": "2020-01-01"},
        {"category": 'Assets:Cash\ninclude "evil.bean"'},
        {"amount": "NaN"},
        {"payee": "x" * 2001},
    ]:
        with pytest.raises(LedgerError):
            writer.preview(request(ledger, version, values))


@pytest.mark.parametrize(
    "source,fields",
    [
        (SOURCE, {}),
        (SOURCE.replace("{{date}}", "{{bad syntax}}"), template()["fields"]),
        (SOURCE.replace('"固定消费"', '"{{amount}}"'), template()["fields"]),
        (SOURCE + "; {{amount}}\n", template()["fields"]),
        (SOURCE.replace("{{date}}", "{{-date}}"), template()["fields"]),
        (SOURCE.replace("{{amount}} CNY", "{{amount}}CNY"), template()["fields"]),
        (SOURCE + 'include "evil.bean"\n', template()["fields"]),
        (SOURCE + SOURCE, template()["fields"]),
    ],
)
def test_reject_invalid_templates(source, fields):
    with pytest.raises(ValueError):
        RecordTemplate(source=source, fields=fields)


def test_field_modes_and_balance_template_validation():
    assert isinstance(current_day(), date)
    for field in [
        dict(type="text", mode="today"),
        dict(type="token"),
        dict(type="date", mode="fixed", value="2026-02-31"),
    ]:
        with pytest.raises(ValueError):
            TemplateField(label="字段", **field)
    fixed = RecordTemplate(source="; 注释\n2020-01-03 balance Assets:Bank 1000 CNY\n", fields={})
    value = default_layout().model_dump()
    value["routes"]["balance"]["template"] = fixed
    Layout.model_validate(value)
    value["routes"]["ordinary"]["template"] = fixed
    with pytest.raises(ValueError, match="一条完整交易"):
        Layout.model_validate(value)


@pytest.mark.parametrize("batch", [False, True])
def test_old_request_fingerprint_remains_retryable(ledger, batch):
    writer = Writer(ledger)
    single = mutation(ledger)
    payload = (
        BatchMutation(
            request_id=single.request_id, revision=single.revision, items=[{"entry": single.entry}]
        )
        if batch
        else single
    )
    data = payload.model_dump(mode="json")
    for item in data["items"] if batch else [data]:
        del item["values"]
        del item["layout_version"]
    old_fingerprint = hashlib.sha256(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    preview = writer.preview(payload)
    with writer.database() as db:
        stored = db.execute(
            "SELECT fingerprint FROM requests WHERE id=?", (str(payload.request_id),)
        ).fetchone()[0]
    assert stored == old_fingerprint
    assert writer.preview(payload) == preview
