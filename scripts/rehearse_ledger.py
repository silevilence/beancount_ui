"""Replay five business days on a disposable copy; never write or push the source ledger."""

import argparse
import json
import subprocess
import tempfile
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

from beancount_ui.config import Settings
from beancount_ui.ledger import Ledger, read_files
from beancount_ui.models import BatchMutation
from beancount_ui.query import daily_view, transactions
from beancount_ui.sync import BackupInput, ConnectInput, Sync
from beancount_ui.writer import Writer


def git(root, *args):
    return subprocess.check_output(
        ["git", "-C", str(root), *args],
        text=True,
        stderr=subprocess.DEVNULL,
    ).strip()


def rehearse(source):
    original = read_files(source)
    with tempfile.TemporaryDirectory(prefix="bean-five-days-") as temporary:
        directory = Path(temporary)
        root = directory / "ledger"
        root.mkdir()
        for name, content in original.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        settings = Settings(root, directory / "state")
        ledger = Ledger(settings)
        snapshot = ledger.refresh()
        assert not snapshot.errors, "Source ledger must load without errors"
        count = len(snapshot.entries)
        rows = transactions(snapshot)
        example = next(
            row
            for row in reversed(rows)
            if row["simple"]
            and row["postings"][0]["account"].startswith("Expenses:")
            and all(p["currency"] == "CNY" for p in row["postings"])
        )
        expense, payment = [p["account"] for p in example["postings"]]
        start = max(date(2026, 9, 30), max(e.date for e in snapshot.entries)) + timedelta(days=1)
        git(root, "init", "-b", "master-1")
        git(root, "config", "user.name", "Isolated rehearsal")
        git(root, "config", "user.email", "rehearsal@example.invalid")
        git(root, "add", ".")
        git(root, "commit", "-m", "local rehearsal baseline")
        remote = directory / "remote.git"
        git(directory, "init", "--bare", str(remote))
        git(root, "remote", "add", "origin", str(remote))
        git(root, "push", "-u", "origin", "master-1")
        sync = Sync(Writer(ledger))
        p = sync.preview()
        assert sync.connect(ConnectInput(revision=p["revision"]))["connected"]
        assert read_files(root) == original
        changed = set()
        for offset in range(5):
            day = start + timedelta(days=offset)
            sync = Sync(Writer(Ledger(settings)))
            before = read_files(root)
            base = Decimal(daily_view(sync.ledger, day)["expenses"].get("CNY", "0"))
            p = sync.writer.preview(
                BatchMutation(
                    request_id=uuid4(),
                    revision=sync.ledger.refresh().revision,
                    items=[
                        {
                            "raw": f'{day} * "isolated-rehearsal-{offset}-{i}"\n'
                            f"  {expense} 0.01 CNY\n  {payment} -0.01 CNY\n"
                        }
                        for i in range(2)
                    ],
                )
            )
            assert read_files(root) == before
            changed.update(p["diffs"])
            sync.writer.commit(p["request_id"])
            Writer(Ledger(settings)).commit(p["request_id"])
            assert Decimal(daily_view(sync.ledger, day)["expenses"]["CNY"]) == base + Decimal(
                "0.02"
            )
            p = sync.backup_preview()
            assert (
                sync.backup(BackupInput(revision=p["revision"], head=p["head"]))["sync"] == "已同步"
            )
        final = Ledger(settings).refresh()
        assert not final.errors
        assert len(final.entries) == count + 10
        assert (
            len(
                [r for r in transactions(final) if r["narration"].startswith("isolated-rehearsal-")]
            )
            == 10
        )
        assert all((root / n).read_bytes() == b for n, b in original.items() if n not in changed)
        assert git(remote, "rev-parse", "master-1") == git(root, "rev-parse", "HEAD")
        assert read_files(source) == original
        return {
            "source_files": len(original),
            "source_entries": count,
            "days": 5,
            "start": str(start),
            "end": str(start + timedelta(days=4)),
            "new_entries": 10,
            "errors": 0,
            "source_unchanged": True,
            "unrelated_files_unchanged": True,
            "restart_retry_no_duplicates": True,
            "isolated_remote_synced": True,
        }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ledger", type=Path)
    args = parser.parse_args()
    print(json.dumps(rehearse(args.ledger.resolve()), indent=2))
