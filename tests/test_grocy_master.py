from uuid import uuid4

import pytest
from beancount_ui.grocy import Grocy, GrocyError, GrocyInput
from beancount_ui.grocy_master import EntityChange, MasterData
from beancount_ui.writer import Writer


@pytest.mark.parametrize(
    "entity,data",
    [
        ("products", {"name": "水", "location_id": 1, "qu_id_purchase": 1, "qu_id_stock": 1}),
        ("locations", {"name": "冰箱", "is_freezer": 1}),
        ("quantity_units", {"name": "瓶"}),
        ("shopping_locations", {"name": "超市"}),
        (
            "quantity_unit_conversions",
            {"product_id": 1, "from_qu_id": 2, "to_qu_id": 1, "factor": "12"},
        ),
    ],
)
def test_master_create_update_delete_deduplicated(ledger, monkeypatch, entity, data):
    service = MasterData(Writer(ledger))
    config = service.grocy.save(GrocyInput(url="http://nas", api_key="secret", enabled=True))
    calls = []
    monkeypatch.setattr(
        Grocy, "request", lambda *args, **kwargs: calls.append(args) or {"created_object_id": 4}
    )
    for delete, entity_id in [(False, None), (False, 4), (True, 4)]:
        request = EntityChange(
            request_id=uuid4(),
            instance_id=config["instance_id"],
            entity=entity,
            entity_id=entity_id,
            data=data,
            delete=delete,
        )
        assert service.change(request)["status"] == "done"
        service.change(request)
    assert len(calls) == 3
    assert [c[2] for c in calls] == ["POST", "PUT", "DELETE"]


def test_unknown_master_change_never_repeated(ledger, monkeypatch):
    service = MasterData(Writer(ledger))
    calls = []

    def fail(*args, **kwargs):
        calls.append(args)
        raise GrocyError("remote_error", "引用删除失败")

    monkeypatch.setattr(Grocy, "request", fail)
    request = EntityChange(
        request_id=uuid4(), instance_id="one", entity="products", entity_id=1, delete=True
    )
    assert service.change(request)["status"] == "unknown"
    assert MasterData(service.writer).change(request)["status"] == "unknown"
    assert len(calls) == 1


def test_unknown_fields_and_entities_rejected(ledger):
    service = MasterData(Writer(ledger))
    with pytest.raises(ValueError):
        service.change(
            EntityChange(
                request_id=uuid4(),
                instance_id="one",
                entity="locations",
                data={"name": "位置", "sql": "delete"},
            )
        )
    with pytest.raises(ValueError):
        EntityChange(request_id=uuid4(), instance_id="one", entity="stock_log", delete=True)
