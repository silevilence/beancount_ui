"""Single-user access policy; ledger and Git credentials stay on the server."""

import hmac
import ipaddress
import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import Request
from fastapi.responses import JSONResponse


@dataclass(frozen=True)
class Access:
    mode: str = "local"
    token: str = field(default="", repr=False)
    origins: tuple[str, ...] = ()

    def __post_init__(self):
        if self.mode not in {"local", "private"}:
            raise ValueError("BEANCOUNT_ACCESS_MODE 仅支持 local 或 private")
        if self.mode == "private" and (len(self.token) < 32 or not self.origins):
            raise ValueError("私网访问必须配置至少 32 字符的访问口令和明确的允许 Origin")
        for origin in self.origins:
            parts = urlsplit(origin)
            if (
                parts.scheme not in {"http", "https"}
                or not parts.hostname
                or parts.username
                or parts.password
                or parts.path
                or parts.query
                or parts.fragment
                or "*" in origin
            ):
                raise ValueError("允许 Origin 必须为明确的 http(s)://主机[:端口]，不含路径或凭据")

    @classmethod
    def from_env(cls):
        token_file = os.environ.get("BEANCOUNT_ACCESS_TOKEN_FILE")
        token = (
            Path(token_file).read_text(encoding="utf-8").strip()
            if token_file
            else os.environ.get("BEANCOUNT_ACCESS_TOKEN", "")
        )
        origins = tuple(
            x.strip()
            for x in os.environ.get("BEANCOUNT_ALLOWED_ORIGINS", "").split(",")
            if x.strip()
        )
        return cls(os.environ.get("BEANCOUNT_ACCESS_MODE", "local"), token, origins)

    @property
    def hosts(self):
        return ["127.0.0.1", "localhost", "[::1]", "testserver"] + [
            urlsplit(origin).hostname for origin in self.origins
        ]

    def authenticated(self, request: Request):
        value = request.headers.get("authorization", "")
        return bool(
            self.token and hmac.compare_digest(value.encode(), f"Bearer {self.token}".encode())
        )

    async def protect(self, request: Request, call_next):
        origin = request.headers.get("origin")
        local_origins = {
            f"http://{host}:{port}" for host in ("127.0.0.1", "localhost") for port in (5173, 8000)
        }
        if origin is not None and origin not in local_origins | set(self.origins):
            return JSONResponse(status_code=403, content={"detail": "访问来源未获允许"})
        if self.mode == "local":
            client = request.client.host if request.client else ""
            try:
                local = ipaddress.ip_address(client).is_loopback
            except ValueError:
                local = client == "testclient"
            if not local:
                return JSONResponse(status_code=403, content={"detail": "仅允许本机访问"})
        protected = request.url.path.startswith("/api/") or request.url.path in {
            "/docs",
            "/redoc",
            "/openapi.json",
        }
        public = request.url.path in {"/api/access", "/api/health"}
        if (
            self.mode == "private"
            and (
                protected
                and not public
                or (request.url.path == "/api/access" and request.headers.get("authorization"))
            )
            and not self.authenticated(request)
        ):
            return JSONResponse(
                status_code=401,
                content={"detail": "请使用个人访问口令登录"},
                headers={"WWW-Authenticate": "Bearer"},
            )
        response = await call_next(request)
        if protected:
            response.headers["Cache-Control"] = "no-store"
        return response
