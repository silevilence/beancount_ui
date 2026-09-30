"""Surgical edits retain original location, separators and posting metadata."""

import re
from decimal import Decimal

from .layout import newline
from .ledger import LedgerError, Snapshot
from .models import EntryInput
from .query import transactions

STRING = r'"(?:[^"\\]|\\.)*"'
HEADER = re.compile(rf"^(\d{{4}}-\d{{2}}-\d{{2}}\s+\S\s+){STRING}(?:\s+{STRING})?")


def basic_edit(row: dict, entry: EntryInput, quote) -> str:
    if entry.splits or not row["simple"]:
        raise LedgerError("复杂历史记录必须使用原文高级编辑，不能转换为基础表单")
    if (
        str(entry.date) == row["date"]
        and entry.payee == row["payee"]
        and entry.narration == row["narration"]
        and entry.note == row["note"]
        and entry.amount == Decimal(row["postings"][0]["amount"])
        and entry.currency == row["postings"][0]["currency"]
        and entry.category == row["postings"][0]["account"]
        and entry.payment == row["postings"][1]["account"]
    ):
        return row["raw"]
    lines = row["raw"].splitlines(keepends=True)
    match = HEADER.match(lines[0])
    if match is None:
        raise LedgerError("无法安全识别交易头，请使用原文编辑")
    flag = match.group(1).split()[1]
    lines[0] = (
        f"{entry.date} {flag} {quote(entry.payee)} {quote(entry.narration)}"
        + lines[0][match.end() :]
    )
    nl = "\r\n" if "\r\n" in row["raw"] else "\n"
    posting_indexes = []
    for i, line in enumerate(lines[1:], 1):
        if re.match(r"^\s+(?:Assets|Liabilities|Expenses|Income|Equity):[^\s]+(?:\s|$)", line):
            posting_indexes.append(i)
    if len(posting_indexes) != 2:
        raise LedgerError("无法安全识别分录，请使用原文编辑")
    for index, account, amount in zip(
        posting_indexes, [entry.category, entry.payment], [entry.amount, -entry.amount], strict=True
    ):
        match = re.match(r"^(\s+)(\S+)(.*?)(\r?\n)?$", lines[index])
        rest = match.group(3)
        # Keep inferred postings inferred, and retain trailing inline comments verbatim.
        comment = rest[rest.index(";") :] if ";" in rest else ""
        explicit = bool(rest.split(";", 1)[0].strip())
        units = f" {amount:f} {entry.currency}" if explicit else ""
        lines[index] = (
            match.group(1)
            + account
            + units
            + (" " + comment if comment else "")
            + (match.group(4) or "")
        )
    for i in range(1, posting_indexes[0]):
        if re.match(r"^\s+memo:\s", lines[i]):
            lines[i] = f"  memo: {quote(entry.note)}{nl}"
            break
    else:
        if entry.note:
            lines.insert(1, f"  memo: {quote(entry.note)}{nl}")
    return "".join(lines)


def locate(snapshot: Snapshot, identity: str | None) -> dict:
    row = next((row for row in transactions(snapshot) if row["id"] == identity), None)
    if row is None:
        raise LedgerError("记录已变化或不存在，请重新加载")
    if row["readonly"]:
        raise LedgerError("历史导入目录只读")
    return row


def replace_record(files: dict[str, bytes], row: dict, raw: str):
    if raw == row["raw"]:
        return
    name = row["file"]
    lines = files[name].splitlines(keepends=True)
    normalized = raw.replace("\r\n", "\n").encode("utf-8")
    if normalized and not normalized.endswith(b"\n"):
        normalized += b"\n"
    replacement = normalized.replace(b"\n", newline(files[name]))
    # UTF-8 BOM belongs to the file, not the transaction at line one.
    if row["line"] == 1 and files[name].startswith(b"\xef\xbb\xbf"):
        replacement = b"\xef\xbb\xbf" + replacement
    files[name] = b"".join(lines[: row["line"] - 1]) + replacement + b"".join(lines[row["end"] :])
