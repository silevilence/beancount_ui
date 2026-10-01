"""Typed slots in one Beancount directive. No expressions or executable templates."""

import json
import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, model_validator

SLOT = re.compile(r"\{\{(-?)([a-z][a-z0-9_]*)\}\}")


def current_day() -> date:
    return datetime.now(ZoneInfo("Asia/Shanghai")).date()


class TemplateField(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str = Field(min_length=1, max_length=100)
    type: Literal["date", "amount", "text", "account", "currency", "token"] = "text"
    mode: Literal["input", "fixed", "today"] = "input"
    value: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def check(self):
        if self.mode == "today" and self.type != "date":
            raise ValueError("自动当天仅适用于日期字段")
        if self.type == "token" and not self.value:
            raise ValueError("标记或标签字段需要默认值，例如 *、#tag 或 ^link")
        if self.mode == "fixed" or self.value:
            encode_value(self.type, self.value)
        return self


def encode_value(kind: str, value: str) -> str:
    if len(value) > 2000:
        raise ValueError("字段值不能超过 2000 个字符")
    if kind == "text":
        return json.dumps(value, ensure_ascii=False)
    if kind == "date":
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise ValueError("日期应为 YYYY-MM-DD")
        return date.fromisoformat(value).isoformat()
    if kind == "amount":
        if not re.fullmatch(r"-?\d{1,16}(?:\.\d{1,8})?", value):
            raise ValueError("金额应为有限十进制数（最多 16 位整数、8 位小数）")
        try:
            return format(Decimal(value), "f")
        except InvalidOperation as exc:
            raise ValueError("金额无效") from exc
    patterns = {
        "account": r"(?:Assets|Liabilities|Equity|Income|Expenses):[^\s\";{}]+",
        "currency": r"[A-Z][A-Z0-9._-]{0,23}",
        "token": r"(?:[*!]|[#^][A-Za-z0-9_/-]+)",
    }
    if not re.fullmatch(patterns[kind], value):
        raise ValueError(f"{kind} 字段值无效")
    return value


class RecordTemplate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: str = Field(min_length=1, max_length=100000)
    fields: dict[str, TemplateField] = Field(max_length=100)

    @model_validator(mode="after")
    def check(self):
        slots = list(SLOT.finditer(self.source))
        if set(self.fields) != {m[2] for m in slots}:
            raise ValueError("模板占位符与字段定义必须一一对应（同一字段可多次引用）")
        if "{{" in SLOT.sub("", self.source) or "}}" in SLOT.sub("", self.source):
            raise ValueError("字段占位符格式为 {{name}}，金额可用 {{-name}} 取负值")
        # A slot must be a complete token, not inside quotes/comments or another token.
        for line in self.source.splitlines():
            quoted, escaped, comment = False, False, False
            pos = 0
            while pos < len(line):
                match = SLOT.match(line, pos)
                if match:
                    if (
                        quoted
                        or comment
                        or (pos and not line[pos - 1].isspace())
                        or (match.end() < len(line) and not line[match.end()].isspace())
                    ):
                        raise ValueError("占位符必须独立放置，不可放在引号、注释或其他 token 内")
                    if match[1] and self.fields[match[2]].type != "amount":
                        raise ValueError("只有金额字段可以取负值")
                    pos = match.end()
                    continue
                char = line[pos]
                if not comment:
                    if char == '"' and not escaped:
                        quoted = not quoted
                    if char == ";" and not quoted:
                        comment = True
                    escaped = char == "\\" and not escaped
                pos += 1
        # Parse representative values to reject templates that inject directives or
        # create structurally invalid raw text before enabling the configuration.
        from .writer import parse_single

        raw = self.sample()
        kind = "balance" if re.search(r"^\d{4}-\d{2}-\d{2}\s+balance\b", raw, re.M) else "ordinary"
        parse_single(raw, kind)
        return self

    def sample(self) -> str:
        samples = {
            "date": "2026-01-01",
            "amount": "1",
            "text": "示例",
            "account": "Assets:Example",
            "currency": "CNY",
            "token": "*",
        }
        values = {
            key: field.value or samples[field.type]
            for key, field in self.fields.items()
            if field.mode == "input"
        }
        return self.render(values, date(2026, 1, 1))

    def render(self, values: dict[str, str], today: date) -> str:
        inputs = {key for key, field in self.fields.items() if field.mode == "input"}
        if set(values) - inputs:
            raise ValueError("提交含未开放输入的模板字段")
        rendered = {}
        for key, field in self.fields.items():
            value = (
                str(today)
                if field.mode == "today"
                else field.value
                if field.mode == "fixed"
                else values.get(key, field.value)
            )
            try:
                rendered[key] = encode_value(field.type, value)
            except ValueError as exc:
                raise ValueError(f"{field.label}：{exc}") from exc

        def replace(match):
            value = rendered[match[2]]
            return format(-Decimal(value), "f") if match[1] else value

        return SLOT.sub(replace, self.source).rstrip() + "\n"
