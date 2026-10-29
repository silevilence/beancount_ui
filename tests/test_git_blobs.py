"""Real Git object reads stay byte-exact without one process per ledger file."""

import pytest
from beancount_ui.sync import GitFailure, Sync
from beancount_ui.writer import Writer
from conftest import git


def test_tree_files_batches_objects_and_preserves_bytes(sync, monkeypatch):
    expected = {
        **{f"extra-{i}.bean": b"; shared content\n" for i in range(24)},
        "empty.bean": b"",
        "space name.bean": b"; no final newline",
        "中文.beancount": "; 中文\r\n".encode(),
        "binary.bean": b"\x00\xff\n\r\n",
    }
    for name, content in expected.items():
        (sync.root / name).write_bytes(content)
    (sync.root / "ignored.txt").write_bytes(b"not a ledger")
    git(sync.root, "-c", "core.autocrlf=false", "add", ".")
    git(sync.root, "commit", "-m", "many objects")
    original = sync.git
    calls = []

    def counted(*args, **kwargs):
        calls.append(args)
        return original(*args, **kwargs)

    monkeypatch.setattr(sync, "git", counted)
    files = sync.tree_files("HEAD")
    assert {name: files[name] for name in expected} == expected
    assert "ignored.txt" not in files
    assert len([args for args in calls if args[0] == "cat-file"]) == 1

    # A later ref must be read afresh, not reused from a previous request.
    (sync.root / "empty.bean").write_bytes(b"; changed\n")
    git(sync.root, "add", "empty.bean")
    git(sync.root, "commit", "-m", "change ref")
    assert sync.tree_files("HEAD")["empty.bean"] == b"; changed\n"


def test_tree_without_ledger_files_does_not_read_blobs(sync, monkeypatch):
    empty_tree = sync.git("mktree", data=b"")
    original = sync.git

    def no_blobs(*args, **kwargs):
        assert args[0] != "cat-file"
        return original(*args, **kwargs)

    monkeypatch.setattr(sync, "git", no_blobs)
    assert sync.tree_files(empty_tree) == {}


def test_tree_rejects_symlink_before_reading_content(sync):
    oid = git(sync.root, "rev-parse", "HEAD:main.beancount")
    git(sync.root, "update-index", "--add", "--cacheinfo", "120000", oid, "link.bean")
    git(sync.root, "commit", "-m", "symlink entry")
    with pytest.raises(ValueError, match="普通文本文件"):
        sync.tree_files("HEAD")


@pytest.mark.parametrize("object_kind", ["missing", "commit"])
def test_batch_rejects_missing_or_non_blob_objects(sync, object_kind):
    oid = "0" * 40 if object_kind == "missing" else git(sync.root, "rev-parse", "HEAD")
    with pytest.raises(GitFailure, match="对象"):
        sync.read_blobs([oid])


@pytest.mark.parametrize(
    "response",
    [
        b"",
        b"a" * 40 + b" missing\n",
        b"b" * 40 + b" blob 1\nx\n",
        b"a" * 40 + b" tree 1\nx\n",
        b"a" * 40 + b" blob -1\n\n",
        b"a" * 40 + b" blob bad\n\n",
        b"a" * 40 + b" blob 3\nx\n",
        b"a" * 40 + b" blob 1\nx",
        b"a" * 40 + b" blob 1\nx\nextra",
    ],
)
def test_batch_rejects_malformed_or_truncated_response(ledger, monkeypatch, response):
    sync = Sync(Writer(ledger))
    monkeypatch.setattr(sync, "git", lambda *args, **kwargs: response)
    with pytest.raises(GitFailure, match="对象"):
        sync.read_blobs(["a" * 40])
