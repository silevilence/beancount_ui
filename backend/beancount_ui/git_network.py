"""Per-process Git transport settings and credential-safe diagnostics."""

import re
from urllib.parse import urlsplit

from pydantic import BaseModel


class ProxyInput(BaseModel):
    mode: str = "system"
    url: str = ""


def validate_proxy(value: str) -> str:
    value = value.strip()
    try:
        url = urlsplit(value)
        valid = (
            url.scheme in {"http", "https", "socks5", "socks5h"}
            and url.hostname
            and url.port
            and url.username is None
            and url.password is None
            and url.path in {"", "/"}
            and not url.query
            and not url.fragment
            and not any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value)
        )
    except ValueError:
        valid = False
    if not valid:
        raise ValueError(
            "代理地址须为 http(s)://主机:端口 或 socks5(h)://主机:端口，不得包含凭据或参数"
        )
    return value


def redact_diagnostic(value: str | bytes | None) -> str:
    text = value.decode("utf-8", errors="replace") if isinstance(value, bytes) else (value or "")
    # Strip terminal escape sequences before matching secrets, then control characters.
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", text)
    text = re.sub(r"(?i)([a-z][a-z0-9+.-]*://)[^\s/]*@", r"\1[REDACTED]@", text)
    text = re.sub(r"(https?://[^\s?#]+)[?#][^\s]*", r"\1?[REDACTED]", text)
    text = re.sub(r"(?im)((?:proxy-)?authorization\s*[:=]\s*)[^\r\n]+", r"\1[REDACTED]", text)
    text = re.sub(
        r"(?i)((?:password|passwd|token|secret)\s*[:=]\s*)[^\s,;]+",
        r"\1[REDACTED]",
        text,
    )
    text = re.sub(r"\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b", "[REDACTED]", text)
    return text[:8192].strip() or "(no stderr)"
