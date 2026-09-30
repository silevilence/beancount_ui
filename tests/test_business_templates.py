from beancount_ui.models import BatchMutation
from beancount_ui.query import transactions
from beancount_ui.writer import Writer
from test_writer import mutation


def test_salary_bonus_phone_utilities_routes(ledger):
    base = mutation(ledger)
    entry = base.entry.model_dump(mode="json")
    items = []
    for business, category, narration, amount in [
        ("salary", "Income:Salary", "工资", "100"),
        ("salary", "Income:Salary", "额外奖金", "20"),
        ("phone", "Expenses:Phone", "话费", "10"),
        ("ordinary", "Expenses:Phone", "水电费", "30"),
    ]:
        items.append(
            {
                "business": business,
                "entry": {
                    **entry,
                    "category": category,
                    "amount": amount,
                    "narration": narration,
                    "note": "自选账户与备注",
                },
            }
        )
    request = BatchMutation(request_id=base.request_id, revision=base.revision, items=items)
    writer = Writer(ledger)
    result = writer.preview(request)
    assert [r["target"] for r in result["items"]] == [
        "txs/category/salary.bean",
        "txs/category/salary.bean",
        "txs/category/phone.bean",
        "txs/2026/09.bean",
    ]
    writer.commit(result["request_id"])
    rows = [r for r in transactions(ledger.refresh()) if r["note"] == "自选账户与备注"]
    assert len(rows) == 4
    assert all("salary" in r["tags"] for r in rows if r["file"].endswith("salary.bean"))
    assert next(r for r in rows if r["narration"] == "额外奖金")["postings"][0]["amount"] == "20"
