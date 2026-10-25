"""Normalize human-entered decimal strings without changing their precision."""

import re


def normalize_amount(value: str) -> str:
    value = value.strip()
    if "," in value:
        if not re.fullmatch(r"[+-]?[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?", value):
            raise ValueError("金额千位分隔格式无效")
        value = value.replace(",", "")
    return value
