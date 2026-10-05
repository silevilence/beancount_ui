"""Plain posting forms; source blocks retain metadata and comments during edits."""

import json
import re
from decimal import Decimal

from beancount.core import data
from beancount.parser import parser
from pydantic import ValidationError

from .ledger import LedgerError
from .models import PostingEntry

STRING = r'"(?:[^"\\]|\\.)*"'
HEADER = re.compile(rf"^(\d{{4}}-\d{{2}}-\d{{2}}\s+\S\s+){STRING}(?:\s+{STRING})?")
POSTING = re.compile(
    r"^(?P<indent>[ \t]+)(?P<flag>\S )?"
    r"(?P<account>(?:Assets|Liabilities|Expenses|Income|Equity):[^\s;]+)"
    r"(?:[ \t]+(?P<amount>[+-]?(?:\d+(?:\.\d*)?|\.\d+))"
    r"[ \t]+(?P<currency>[A-Z][A-Z0-9._-]*))?"
    r"[ \t]*(?P<comment>;[^\r\n]*)?(?:\r?\n)?$"
)
MEMO = re.compile(rf"^([ \t]+memo:[ \t]*)({STRING})([ \t]*(?:;[^\r\n]*)?)(\r?\n)?$")


def quote(value):
    return json.dumps(value, ensure_ascii=False)


def read_form(
    raw: str, posting_count: int | None = None, *, validated_entry: data.Transaction | None = None
) -> dict | None:
    """Return None if the form cannot represent the source without losing semantics."""
    lines = raw.splitlines(keepends=True)
    if not lines or not HEADER.match(lines[0]):
        return None
    entry = validated_entry
    if entry is None:
        entries, errors, _ = parser.parse_string(raw)
        if errors or len(entries) != 1 or not isinstance(entries[0], data.Transaction):
            return None
        entry = entries[0]
    matches = [(i, POSTING.fullmatch(line)) for i, line in enumerate(lines)]
    matches = [(i, m) for i, m in matches if m]
    if len(matches) != len(entry.postings) or not 2 <= len(matches) <= 100:
        return None
    if posting_count is not None and posting_count != len(matches):
        return None
    if any(p.cost is not None or p.price is not None for p in entry.postings):
        return None
    # Booking may expand or reorder postings. Only reuse a validated entry when
    # source rows still correspond; amounts below always come from the source,
    # preserving omitted amounts as inference rather than loaded balances.
    if any(m["account"] != p.account for (_, m), p in zip(matches, entry.postings, strict=True)):
        return None
    # Multi-line or non-text memo values stay in the raw editor.
    if any(re.match(r"^\s+memo:", line) and not MEMO.fullmatch(line) for line in lines):
        return None
    # pushmeta values are inherited by the loaded transaction, but the editing
    # form must only expose metadata explicitly present in this source block.
    # Unusual placement remains on the standalone parser path.
    note = (entry.meta or {}).get("memo", "")
    if (
        validated_entry is not None
        and note
        and not any(MEMO.fullmatch(line) for line in lines[: matches[0][0]])
    ):
        if any(MEMO.fullmatch(line) for line in lines[matches[0][0] :]):
            return read_form(raw, posting_count)
        note = ""
    form = {
        "date": str(entry.date),
        "payee": entry.payee or "",
        "narration": entry.narration,
        "note": note,
        "postings": [
            {
                "source_index": index,
                "account": match["account"],
                "amount": str(Decimal(match["amount"])) if match["amount"] is not None else None,
                "currency": match["currency"] or "",
                "note": (posting.meta or {}).get("memo", ""),
            }
            for index, ((_, match), posting) in enumerate(zip(matches, entry.postings, strict=True))
        ],
    }
    try:
        PostingEntry.model_validate(form)
    except ValidationError:
        return None
    return form


def replace_memo(lines: list[str], note: str, indent: str, nl: str) -> list[str]:
    for i, line in enumerate(lines):
        match = MEMO.fullmatch(line)
        if match:
            lines[i] = match[1] + quote(note) + match[3] + (match[4] or "")
            return lines
    if note:
        if lines and not lines[-1].endswith("\n"):
            lines[-1] += nl
        lines.append(f"{indent}memo: {quote(note)}{nl}")
    return lines


def render_form(entry: PostingEntry, raw: str | None = None) -> str:
    original = read_form(raw) if raw is not None else None
    if raw is not None and original is None:
        raise LedgerError("此记录包含表单未支持的语法，请使用原文高级编辑")
    nl = "\r\n" if raw and "\r\n" in raw else "\n"
    source = raw.splitlines(keepends=True) if raw else []
    indexes = [i for i, line in enumerate(source) if POSTING.fullmatch(line)]
    blocks = [
        source[start:end] for start, end in zip(indexes, indexes[1:] + [len(source)], strict=False)
    ]
    if original:
        head = source[: indexes[0]]
        if any(str(getattr(entry, key)) != original[key] for key in ("date", "payee", "narration")):
            match = HEADER.match(head[0])
            flag = match[1].split()[1]
            head[0] = (
                f"{entry.date} {flag} {quote(entry.payee)} {quote(entry.narration)}"
                + head[0][match.end() :]
            )
        if entry.note != original["note"]:
            head = [head[0], *replace_memo(head[1:], entry.note, "  ", nl)]
    else:
        head = [f"{entry.date} * {quote(entry.payee)} {quote(entry.narration)}{nl}"]
        head = replace_memo(head, entry.note, "  ", nl)
    result = head
    used = set()
    for posting in entry.postings:
        index = posting.source_index
        if index is not None:
            if original is None or index >= len(blocks) or index in used:
                raise LedgerError("分录来源无效或重复，请重新加载记录")
            used.add(index)
        if (posting.amount is None) != (posting.currency == ""):
            raise LedgerError("分录金额和币种必须同时填写；自动推导时两项均留空")
        units = "" if posting.amount is None else f" {posting.amount:f} {posting.currency}"
        if index is not None:
            block = list(blocks[index])
            old = original["postings"][index]
            old_amount = Decimal(old["amount"]) if old["amount"] is not None else None
            match = POSTING.fullmatch(block[0])
            if (posting.account, posting.amount, posting.currency) != (
                old["account"],
                old_amount,
                old["currency"],
            ):
                comment = " " + match["comment"] if match["comment"] else ""
                ending = nl if block[0].endswith("\n") else ""
                block[0] = (
                    f"{match['indent']}{match['flag'] or ''}{posting.account}"
                    f"{units}{comment}{ending}"
                )
            if posting.note != old["note"]:
                block = [
                    block[0],
                    *replace_memo(block[1:], posting.note, match["indent"] + "  ", nl),
                ]
                if len(block) > 1 and not block[0].endswith("\n"):
                    block[0] += nl
        else:
            block = [f"  {posting.account}{units}{nl}"]
            block = replace_memo(block, posting.note, "    ", nl)
        if result and not result[-1].endswith("\n"):
            result[-1] += nl
        result.extend(block)
    return "".join(result)
