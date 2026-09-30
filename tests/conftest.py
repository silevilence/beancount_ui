import shutil

import pytest
from beancount_ui.config import Settings
from beancount_ui.ledger import Ledger


@pytest.fixture
def ledger(tmp_path):
    root = tmp_path / "ledger"
    shutil.copytree("examples/ledger", root)
    return Ledger(Settings(root, tmp_path / "state"))
