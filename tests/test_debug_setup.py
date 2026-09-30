import runpy
from pathlib import Path

import pytest


@pytest.fixture
def debug_workspace(tmp_path):
    workspace = tmp_path / "source"
    example = workspace / "examples" / "ledger"
    example.mkdir(parents=True)
    (example / "main.beancount").write_text("; example\n", encoding="utf-8")
    (workspace / ".env.example").write_text(
        "BEANCOUNT_LEDGER_DIR=../beancount-demo\n"
        "BEANCOUNT_STATE_DIR=../.beancount-demo-ui\n",
        encoding="utf-8",
    )
    return workspace


def prepare(workspace):
    script = Path(__file__).resolve().parents[1] / "scripts" / "prepare_debug.py"
    runpy.run_path(str(script))["prepare_debug"](workspace)


def test_first_debug_launch_creates_external_demo_and_env(debug_workspace):
    prepare(debug_workspace)
    assert (debug_workspace / ".env").read_bytes() == (
        debug_workspace / ".env.example"
    ).read_bytes()
    assert (debug_workspace.parent / "beancount-demo" / "main.beancount").read_text() == (
        "; example\n"
    )


def test_debug_setup_preserves_existing_env_and_does_not_create_demo(debug_workspace):
    env = debug_workspace / ".env"
    env.write_bytes(b"BEANCOUNT_LEDGER_DIR=D:/custom-ledger\r\n")
    prepare(debug_workspace)
    assert env.read_bytes() == b"BEANCOUNT_LEDGER_DIR=D:/custom-ledger\r\n"
    assert not (debug_workspace.parent / "beancount-demo").exists()


def test_debug_setup_preserves_edits_on_repeated_launch(debug_workspace):
    prepare(debug_workspace)
    ledger = debug_workspace.parent / "beancount-demo" / "main.beancount"
    ledger.write_bytes(b"; user edit\r\n")
    prepare(debug_workspace)
    assert ledger.read_bytes() == b"; user edit\r\n"


def test_debug_setup_preserves_existing_demo_when_env_missing(debug_workspace):
    demo = debug_workspace.parent / "beancount-demo"
    demo.mkdir()
    ledger = demo / "main.beancount"
    ledger.write_bytes(b"; existing ledger\r\n")
    prepare(debug_workspace)
    assert ledger.read_bytes() == b"; existing ledger\r\n"
    assert (debug_workspace / ".env").exists()
