"""Validated business routes; physical paths never belong in business forms."""

import fnmatch
import posixpath
import re
from datetime import date
from pathlib import PurePosixPath
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .ledger import LedgerError
from .record_template import RecordTemplate

BUSINESSES = ("ordinary", "yuebao", "salary", "phone", "balance")


class Route(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target: str = Field(max_length=240)
    indexes: list[str] = Field(default_factory=list, max_length=64)
    date_source: Literal["record", "write"] = "record"
    label: str = Field(default="", max_length=100)
    kind: Literal["ordinary", "salary", "phone", "yuebao", "balance"] | None = None
    template: RecordTemplate | None = None


def validate_path(path: str, *, dated: bool = False):
    plain = (
        path.replace("{year}", "2026").replace("{month}", "09").replace("{day}", "30")
        if dated
        else path
    )
    if (
        not re.fullmatch(r"[\w/.-]+", plain)
        or not plain.endswith((".bean", ".beancount"))
        or len(plain) > 240
        or any(
            p in ("", ".", "..")
            or p.startswith(".")
            or p.endswith(".")
            or re.fullmatch(r"(?i)(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?", p)
            for p in plain.split("/")
        )
        or path.count("{year}") > 1
        or path.count("{month}") > 1
        or path.count("{day}") > 1
    ):
        raise ValueError(f"非法账本路径：{path}；使用账本内相对路径和 .bean/.beancount 扩展名")


def path_mask(template: str):
    # Conservative intersection across ALL dates, not only the preview month.
    masks = []
    for part in re.split(r"(\{year\}|\{month\}|\{day\})", template.casefold()):
        if part == "{year}":
            masks.extend([set("0123456789")] * 4)
        elif part == "{month}":
            masks.extend([set("01"), set("0123456789")])
        elif part == "{day}":
            masks.extend([set("0123"), set("0123456789")])
        else:
            masks.extend({c} for c in part)
    return masks


def overlaps(left: str, right: str) -> bool:
    a, b = path_mask(left), path_mask(right)
    if len(a) > len(b):
        a, b = b, a
    return all(x & y for x, y in zip(a, b, strict=False)) and (
        len(a) == len(b) or b[len(a)] == {"/"}
    )


def matches_business_file(path: str, patterns: list[str]) -> bool:
    for pattern in patterns:
        regex = re.escape(pattern)
        for key, width in (("year", 4), ("month", 2), ("day", 2)):
            regex = regex.replace(re.escape("{" + key + "}"), rf"\d{{{width}}}")
        if re.fullmatch(regex, path):
            return True
    return False


class Layout(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entry: str = "main.beancount"
    routes: dict[str, Route] = Field(max_length=100)

    @model_validator(mode="after")
    def check(self):
        validate_path(self.entry)
        if not set(BUSINESSES) <= set(self.routes):
            raise ValueError("必须保留 ordinary、yuebao、salary、phone、balance 五类内置业务")
        nodes = [(self.entry, "index")]
        edges = {}
        for business, route in self.routes.items():
            if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", business):
                raise ValueError("业务标识仅支持小写字母、数字、下划线和连字符")
            if business in BUSINESSES and route.kind not in (None, business):
                raise ValueError("内置业务的记账语义不能更改")
            if route.template:
                from .writer import parse_single

                parse_single(route.template.sample(), self.kind(business))
            validate_path(route.target, dated=True)
            if any(p.casefold().startswith("gnucash/") for p in [route.target, *route.indexes]):
                raise ValueError("GnuCash 历史导入目录只读，不能作为新记录或索引目标")
            for index in route.indexes:
                validate_path(index, dated=True)
                nodes.append((index, "index"))
            nodes.append((route.target, business))
            chain = [self.entry, *route.indexes, route.target]
            for parent, child in zip(chain, chain[1:], strict=False):
                edges.setdefault(parent, set()).add(child)
        validate_roles(nodes)
        visited, visiting = set(), set()

        def visit(node):
            if node in visiting:
                raise ValueError("include 规则存在循环")
            if node in visited:
                return
            visiting.add(node)
            for child in edges.get(node, ()):
                visit(child)
            visiting.remove(node)
            visited.add(node)

        for node in edges:
            visit(node)
        return self

    def kind(self, business: str) -> str:
        return business if business in BUSINESSES else self.routes[business].kind or "ordinary"

    def chain(self, business: str, day: date, write_day: date | None = None) -> list[str]:
        route = self.routes[business]
        if route.date_source == "write":
            if write_day is None:
                raise ValueError("缺少实际写入日期")
            day = write_day
        return [
            p.format(year=f"{day.year:04d}", month=f"{day.month:02d}", day=f"{day.day:02d}")
            for p in [self.entry, *route.indexes, route.target]
        ]


def validate_roles(nodes, *, historical=False):
    for i, (path, role) in enumerate(nodes):
        for other, other_role in nodes[:i]:
            for part, other_part in zip(path.split("/"), other.split("/"), strict=False):
                if part.casefold() != other_part.casefold():
                    break
                if part != other_part:
                    raise ValueError(f"文件规则大小写冲突：{path} / {other}")
            if path == other and role == other_role:
                continue
            if historical and role == other_role and role != "index":
                continue
            if overlaps(path, other):
                raise ValueError(f"文件规则冲突或相互覆盖：{path} / {other}")


def default_layout(entry="main.beancount") -> Layout:
    return Layout(
        entry=entry,
        routes={
            business: Route(
                target="txs/{year}/{month}.bean"
                if business == "ordinary"
                else f"txs/category/{business}.bean",
                indexes=[
                    "index.bean",
                    "txs/index.bean",
                    "txs/{year}/index.bean"
                    if business == "ordinary"
                    else "txs/category/index.bean",
                ],
            )
            for business in BUSINESSES
        },
    )


def newline(content: bytes) -> bytes:
    return b"\r\n" if b"\r\n" in content else b"\n"


def append(content: bytes, addition: bytes) -> bytes:
    nl = newline(content)
    prefix = b"" if not content or content.endswith((b"\n", b"\r")) else nl
    return content + prefix + nl + addition.replace(b"\r\n", b"\n").replace(b"\n", nl)


def ensure_include(files: dict[str, bytes], parent: str, child: str):
    content = files.get(parent, b"")
    parent_dir = PurePosixPath(parent).parent
    target = posixpath.relpath(child, str(parent_dir))

    def matches(name, pattern):
        parts = pattern.split("/")
        return len(parts) == len(name.split("/")) and all(
            fnmatch.fnmatchcase(name, part)
            for name, part in zip(name.split("/"), parts, strict=True)
        )

    # Reuse indirect includes too: adding a second path to an already included
    # file produces a Beancount duplicate-include error (not another copy).
    pending, visited = [parent], set()
    names = set(files) | {child}
    while pending:
        name = pending.pop()
        if name in visited:
            continue
        visited.add(name)
        included = re.findall(rb'^\s*include\s+"([^"\r\n]+)"', files.get(name, b""), re.M)
        for item in included:
            pattern = posixpath.normpath(posixpath.join(posixpath.dirname(name), item.decode()))
            if matches(child, pattern):
                return
            pending.extend(p for p in names if matches(p, pattern))
    files[parent] = append(content, f'include "{target}"\n'.encode())


def insert_new(
    files: dict[str, bytes],
    business: str,
    day: date,
    raw: str,
    layout: Layout | None = None,
    write_day: date | None = None,
) -> str:
    layout = layout or default_layout()
    chain = layout.chain(business, day, write_day)
    target = chain[-1]
    for parent, child in zip(chain, chain[1:], strict=False):
        ensure_include(files, parent, child)
    original = files.get(target, b"")
    addition = raw.encode("utf-8")
    if layout.kind(business) == "salary":
        starts = list(re.finditer(rb"^pushtag\s+#salary\s*(?:;[^\r\n]*)?$", original, re.M))
        ends = list(re.finditer(rb"^poptag\s+#salary\s*(?:;[^\r\n]*)?$", original, re.M))
        if not starts and not ends:
            files[target] = append(
                original, b"pushtag #salary\n\n" + addition + b"\npoptag #salary\n"
            )
        elif len(starts) == len(ends) == 1 and starts[0].start() < ends[0].start():
            pos = ends[0].start()
            files[target] = append(original[:pos], addition) + newline(original) + original[pos:]
        else:
            raise LedgerError("工资文件的 salary 标签范围不明确，请先整理后重试")
    else:
        files[target] = append(original, addition)
    return target
