from copy import deepcopy

import pytest
from beancount_ui.ledger import LedgerError, read_files
from beancount_ui.models import BatchMutation, PostingEntry
from beancount_ui.posting_form import read_form, render_form
from beancount_ui.query import transactions
from beancount_ui.writer import Writer
from pydantic import ValidationError
from test_writer import mutation


def test_loaded_form_matches_source_with_inherited_metadata(ledger):
    path = ledger.settings.ledger_dir / "main.beancount"
    with path.open("a", encoding="utf-8") as stream:
        stream.write(
            '\npushmeta memo: "inherited"\n'
            '2026-10-05 * "inherited memo"\n'
            "  Expenses:Food 1 CNY\n"
            "  Assets:Cash\n"
            "popmeta memo:\n"
        )
    snapshot = ledger.refresh()
    assert not snapshot.errors
    for row in transactions(snapshot):
        assert row["posting_form"] == read_form(row["raw"], len(row["postings"]))


def prepare(ledger):
    path = ledger.settings.ledger_dir / "main.beancount"
    with path.open("a", encoding="utf-8") as stream:
        stream.write(
            "\n2000-01-01 open Equity:Budget:Game\n"
            "2000-01-01 open Expenses:Games\n"
            "2000-01-01 open Assets:Bitcash\n"
        )


def budget():
    return {
        "date": "2026-09-30",
        "payee": "游戏商户",
        "narration": "预算消费",
        "note": "",
        "postings": [
            {"account": "Expenses:Food", "amount": "166", "currency": "CNY", "note": "商品"},
            {"account": "Assets:Cash", "amount": "-166", "currency": "CNY"},
            {"account": "Equity:Budget:Game", "amount": "-166", "currency": "CNY", "note": "预算"},
            {"account": "Equity:Opening", "amount": "166", "currency": "CNY"},
        ],
    }


def test_budget_create_reload_edit_and_noop(ledger):
    prepare(ledger)
    writer = Writer(ledger)
    request = mutation(ledger, entry=None, posting_entry=budget())
    writer.commit(writer.preview(request)["request_id"])
    row = next(r for r in transactions(ledger.refresh()) if r["narration"] == "预算消费")
    assert row["posting_form"]["postings"][2]["note"] == "预算"
    before = read_files(ledger.settings.ledger_dir)
    noop = mutation(
        ledger,
        entry=None,
        operation="edit",
        transaction_id=row["id"],
        posting_entry=row["posting_form"],
    )
    assert writer.preview(noop)["diffs"] == {}
    writer.commit(writer.preview(noop)["request_id"])
    assert read_files(ledger.settings.ledger_dir) == before
    edited = deepcopy(row["posting_form"])
    for p in edited["postings"]:
        p["amount"] = "77.77" if not p["amount"].startswith("-") else "-77.77"
    edited["postings"][2]["note"] = "Steam"
    writer.commit(
        writer.preview(
            mutation(
                ledger, entry=None, operation="edit", transaction_id=row["id"], posting_entry=edited
            )
        )["request_id"]
    )
    changed = next(r for r in transactions(ledger.refresh()) if r["narration"] == "预算消费")
    assert changed["file"] == row["file"]
    assert changed["postings"][2]["amount"] == "-77.77"
    assert changed["postings"][2]["note"] == "Steam"


def test_six_line_jpy_discount_batch_and_resize(ledger):
    prepare(ledger)
    form = {
        **budget(),
        "postings": [
            {"account": "Expenses:Games", "amount": amount, "currency": "JPY", "note": str(i)}
            for i, amount in enumerate(["1430", "1430", "1320", "2090", "-939"])
        ]
        + [{"account": "Assets:Bitcash", "amount": "-5331", "currency": "JPY"}],
    }
    writer = Writer(ledger)
    request = mutation(ledger, entry=None, posting_entry=form)
    batch = BatchMutation(
        request_id=request.request_id,
        revision=request.revision,
        items=[{"posting_entry": request.posting_entry}],
    )
    writer.commit(writer.preview(batch)["request_id"])
    row = next(r for r in transactions(ledger.refresh()) if r["payee"] == form["payee"])
    edited = deepcopy(row["posting_form"])
    edited["postings"].pop(1)
    edited["postings"][0]["amount"] = "2860"
    edited["postings"].insert(
        1, {"account": "Expenses:Games", "amount": "10", "currency": "JPY", "note": "追加"}
    )
    edited["postings"][-1]["amount"] = "-5341"
    writer.commit(
        writer.preview(
            mutation(
                ledger, entry=None, posting_entry=edited, operation="edit", transaction_id=row["id"]
            )
        )["request_id"]
    )
    changed = next(r for r in transactions(ledger.refresh()) if r["payee"] == form["payee"])
    assert [p["note"] for p in changed["postings"]] == ["0", "追加", "2", "3", "4", ""]
    assert not ledger.refresh().errors


def test_source_blocks_keep_flags_comments_metadata_inference_and_no_final_newline():
    raw = (
        '2026-09-30 ! "shop" "items" #tag ^link ; header\r\n'
        '  memo: "before" ; keep\r\n  custom: "keep"\r\n'
        '  ! Expenses:Food 1.00 CNY ; first\r\n    memo: "item" ; item-comment\r\n'
        "    other: 7\r\n  Expenses:Food 2 CNY\r\n  Assets:Cash"
    )
    form = read_form(raw)
    assert form["postings"][-1]["amount"] is None
    assert render_form(PostingEntry.model_validate(form), raw) == raw
    form["postings"][0]["amount"] = "2.10"
    form["postings"][0]["note"] = "changed"
    form["postings"][-1]["note"] = "new memo"
    form["note"] = "updated"
    form["payee"] = "new shop"
    changed = render_form(PostingEntry.model_validate(form), raw)
    for text in [
        "#tag ^link ; header",
        'custom: "keep"',
        "! Expenses:Food 2.10 CNY ; first",
        'memo: "changed" ; item-comment',
        "other: 7",
        'Assets:Cash\r\n    memo: "new memo"',
        'memo: "updated" ; keep',
    ]:
        assert text in changed
    assert read_form(changed) is not None
    assert '2026-09-30 ! "new shop" "items" #tag ^link ; header' in changed


@pytest.mark.parametrize(
    "change",
    [
        {"amount": "165"},
        {"account": "Assets:Missing"},
        {"currency": "USD"},
        {"amount": None, "currency": "CNY"},
        {"amount": "1", "currency": ""},
    ],
)
def test_invalid_form_cannot_write(ledger, change):
    prepare(ledger)
    form = budget()
    form["postings"][0].update(change)
    before = read_files(ledger.settings.ledger_dir)
    with pytest.raises(LedgerError):
        Writer(ledger).preview(mutation(ledger, entry=None, posting_entry=form))
    assert read_files(ledger.settings.ledger_dir) == before


def test_duplicate_source_and_unsupported_syntax():
    raw = '2026-09-30 * "test"\n  Expenses:Food 1 CNY\n  Assets:Cash -1 CNY\n'
    form = read_form(raw)
    form["postings"][1]["source_index"] = 0
    with pytest.raises(LedgerError, match="来源"):
        render_form(PostingEntry.model_validate(form), raw)
    for replacement in ["1 CNY @ 2 USD", "1 CNY {2 USD}"]:
        unsupported = raw.replace("1 CNY\n", replacement + "\n", 1)
        assert read_form(unsupported) is None
        with pytest.raises(LedgerError, match="原文"):
            render_form(PostingEntry.model_validate(form), unsupported)
    assert (
        read_form(raw.replace("Expenses:Food 1 CNY", "Expenses:Food 1 CNY\n    memo: 42")) is None
    )


def test_float_rejected():
    form = budget()
    form["postings"][0]["amount"] = 0.1
    with pytest.raises(ValidationError, match="字符串"):
        PostingEntry.model_validate(form)
