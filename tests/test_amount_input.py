from decimal import Decimal
from uuid import uuid4

import pytest
from beancount_ui.fulfillment_models import ItemInput, SettlementInput
from beancount_ui.models import EntryInput, PostingInput, PostingPrice, SplitInput
from beancount_ui.record_template import encode_value
from beancount_ui.writer import Writer
from pydantic import ValidationError
from test_writer import mutation


@pytest.mark.parametrize("value", [" 2,000.00000001 ", "\t2000.00000001\n"])
def test_amount_models_keep_decimal_precision(value):
    expected = Decimal("2000.00000001")
    assert PostingInput(account="Assets:Cash", amount=value).amount == expected
    assert PostingPrice(kind="total", amount=value, currency="CNY").amount == expected
    assert SplitInput(category="Expenses:Food", amount=value).amount == expected
    assert encode_value("amount", value) == str(expected)
    assert (
        ItemInput(id=uuid4(), name="商品", quantity="1", allocated_amount=value).allocated_amount
        == expected
    )
    assert (
        SettlementInput(date="2026-10-25", amount=value, account="Assets:Cash").amount == expected
    )


@pytest.mark.parametrize(
    "value", ["2,00", "1,00,000", "1,,000", ",100", "100,", "1.000,50", "1 000"]
)
def test_malformed_grouping_is_rejected(value):
    with pytest.raises(ValidationError):
        PostingInput(account="Assets:Cash", amount=value)
    with pytest.raises(ValueError):
        encode_value("amount", value)


@pytest.mark.parametrize("value", [2000.1, 2000])
def test_amounts_still_require_strings(value):
    with pytest.raises(ValueError, match="字符串"):
        EntryInput.exact_amount(value)


def test_grouped_form_amounts_preview_and_save_balanced(ledger):
    request = mutation(ledger)
    fields = request.entry.model_dump(mode="json")
    fields.update(
        amount=" 2,000.10 ",
        splits=[
            {"category": "Expenses:Food", "amount": " 3,000.11 "},
            {"category": "Expenses:Food", "amount": " -1,000.01 "},
        ],
    )
    request = mutation(ledger, entry=fields)
    writer = Writer(ledger)
    preview = writer.preview(request)
    writer.commit(preview["request_id"])
    snapshot = ledger.refresh()
    assert not snapshot.errors
    assert request.entry.amount == Decimal("2000.10")
    assert sum(line.amount for line in request.entry.splits) == request.entry.amount


def test_normalization_preserves_limits_and_inferred_postings():
    assert PostingInput(account="Assets:Cash", amount=None).amount is None
    with pytest.raises(ValidationError):
        PostingInput(account="Assets:Cash", amount="1,000.000000001")
    with pytest.raises(ValueError):
        encode_value("amount", "10,000,000,000,000,000")
