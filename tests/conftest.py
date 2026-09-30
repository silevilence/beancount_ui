import shutil
import subprocess

import pytest
from beancount_ui.config import Settings
from beancount_ui.ledger import Ledger
from beancount_ui.sync import Sync
from beancount_ui.writer import Writer


@pytest.fixture
def ledger(tmp_path):
    root = tmp_path / "ledger"
    shutil.copytree("examples/ledger", root)
    return Ledger(Settings(root, tmp_path / "state"))


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


@pytest.fixture
def sync(ledger, tmp_path):
    root = ledger.settings.ledger_dir
    git(root, "init", "-b", "master-1")
    git(root, "config", "user.email", "test@example.invalid")
    git(root, "config", "user.name", "Test")
    git(root, "add", ".")
    git(root, "commit", "-m", "baseline")
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    git(root, "remote", "add", "origin", str(remote))
    git(root, "push", "-u", "origin", "master-1")
    return Sync(Writer(ledger))
