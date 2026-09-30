import shutil

import pytest
from beancount import loader
from beancount_ui.app import create_app
from beancount_ui.config import Settings
from fastapi.testclient import TestClient


def test_health():
    assert TestClient(create_app()).get("/api/health").json() == {"status": "ok"}


def test_example_loads(tmp_path):
    shutil.copytree("examples/ledger", tmp_path / "ledger")
    entries, errors, _ = loader.load_file(str(tmp_path / "ledger/main.beancount"))
    assert not errors
    assert entries


def test_configuration(monkeypatch, tmp_path):
    monkeypatch.delenv("BEANCOUNT_LEDGER_DIR", raising=False)
    with pytest.raises(ValueError, match="请设置"):
        Settings.from_env()
    monkeypatch.setenv("BEANCOUNT_LEDGER_DIR", ".")
    with pytest.raises(ValueError, match="之外"):
        Settings.from_env()
    monkeypatch.setenv("BEANCOUNT_LEDGER_DIR", str(tmp_path / "ledger"))
    monkeypatch.setenv("BEANCOUNT_STATE_DIR", str(tmp_path / "ledger/state"))
    with pytest.raises(ValueError, match="分离"):
        Settings.from_env()
    monkeypatch.setenv("BEANCOUNT_STATE_DIR", str(tmp_path / "state"))
    assert Settings.from_env().ledger_dir == tmp_path / "ledger"
