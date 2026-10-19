"""Grocy transport and instance-bound configuration; never expose credentials."""

import json
import re
import socket
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import uuid4

from filelock import FileLock
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

from .ledger import LedgerError
from .writer import atomic_write


class GrocyInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(default="", max_length=2000)
    api_key: SecretStr | None = None
    clear_key: bool = False
    enabled: bool = False
    default_location_id: int | None = Field(default=None, gt=0)
    default_best_before_days: int | None = Field(default=None, ge=0, le=36500)

    @field_validator("url")
    @classmethod
    def valid_url(cls, value):
        value = value.strip().rstrip("/")
        if not value:
            return ""
        parts = urlsplit(value)
        if (
            parts.scheme not in ("http", "https")
            or not parts.hostname
            or parts.username
            or parts.password
            or parts.query
            or parts.fragment
            or any(c.isspace() for c in value)
        ):
            raise ValueError("填写不含凭据、查询参数或锚点的 HTTP(S) 实例地址")
        # Configuration is the instance root, including any reverse-proxy subpath.
        return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path, "", ""))


class GrocyError(LedgerError):
    def __init__(self, code, message, *, unsent=False):
        super().__init__(message)
        self.code = code
        self.unsent = unsent


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Do not forward the API key to a redirected origin or replay a POST.
        return None


class Grocy:
    def __init__(self, state: Path):
        state.mkdir(parents=True, exist_ok=True)
        self.path = state / "grocy.json"
        self.lock = FileLock(str(state / "grocy.lock"), timeout=15)
        self.state = state

    def read(self):
        if not self.path.exists():
            return {
                "url": "",
                "enabled": False,
                "api_key": "",
                "instance_id": "",
                "default_location_id": None,
                "default_best_before_days": None,
            }
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (ValueError, UnicodeError) as exc:
            raise LedgerError("Grocy 配置损坏，请恢复状态备份") from exc

    def status(self):
        saved = self.read()
        return {k: v for k, v in saved.items() if k != "api_key"} | {
            "key_configured": bool(saved.get("api_key"))
        }

    def save(self, request: GrocyInput):
        with self.lock:
            old = self.read()
            changed = old["url"] != request.url
            if changed and (self.state / "grocy-bindings.locked").exists():
                raise LedgerError(
                    "已有商品或库存操作关联此实例；请先备份并核对关联，不能直接更换实例"
                )
            key = "" if request.clear_key or changed else old.get("api_key", "")
            if request.api_key is not None:
                key = request.api_key.get_secret_value().strip()
            if key and (len(key) > 1024 or not re.fullmatch(r"[\x21-\x7e]+", key)):
                raise ValueError("API Key 格式无效")
            if request.enabled and (not request.url or not key):
                raise ValueError("启用 Grocy 需要地址和 API Key")
            saved = request.model_dump(exclude={"api_key", "clear_key"}) | {
                "api_key": key,
                "instance_id": str(uuid4()) if changed else old["instance_id"],
            }
            atomic_write(self.path, json.dumps(saved).encode())
            return self.status()

    def bind(self, instance_id):
        # Called under this lock whenever persistent links/operations are created.
        if self.read()["instance_id"] != instance_id:
            raise LedgerError("Grocy 实例已变化，请重新选择产品")
        atomic_write(self.state / "grocy-bindings.locked", instance_id.encode())

    def request(self, path, method="GET", payload=None, *, instance_id=None, probe=False):
        saved = self.read()
        if instance_id is not None and saved["instance_id"] != instance_id:
            raise GrocyError("instance_changed", "Grocy 实例不匹配，已停止请求", unsent=True)
        if not saved["url"] or not saved.get("api_key") or (not saved["enabled"] and not probe):
            raise GrocyError("disabled", "Grocy 未配置或已停用", unsent=True)
        request = Request(
            saved["url"] + "/api/" + path.lstrip("/"),
            method=method,
            headers={
                "GROCY-API-KEY": saved["api_key"],
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            data=None if payload is None else json.dumps(payload).encode(),
        )
        try:
            # Server-to-server traffic must not inherit a desktop/system proxy.
            with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=12) as response:
                body = response.read(8 * 1024 * 1024 + 1)
                if len(body) > 8 * 1024 * 1024:
                    raise GrocyError("invalid_response", "Grocy 响应超过读取上限")
                return json.loads(body) if body else None
        except HTTPError as exc:
            code, message = {
                401: ("credentials", "Grocy 凭据无效"),
                403: ("permission", "Grocy 权限不足"),
                404: ("incompatible", "Grocy 地址或接口不兼容"),
            }.get(exc.code, ("remote_error", f"Grocy 返回 HTTP {exc.code}，请核对远端结果"))
            # Even an HTTP error is not evidence a mutation had no side effect.
            raise GrocyError(code, message) from None
        except TimeoutError:
            raise GrocyError("timeout", "Grocy 请求超时；写入结果需核对") from None
        except URLError as exc:
            # Only DNS failure / connection refused unambiguously precede dispatch.
            unsent = isinstance(exc.reason, (socket.gaierror, ConnectionRefusedError))
            raise GrocyError(
                "unreachable", "无法连接 Grocy，请检查后端可达地址", unsent=unsent
            ) from None
        except (ValueError, UnicodeError):
            raise GrocyError("invalid_response", "Grocy 响应格式不兼容") from None

    def check(self):
        with self.lock:
            info = self.request("system/info", probe=True)
            version = str(info.get("grocy_version", {}).get("Version", ""))
            if not re.fullmatch(r"4\.\d+\.\d+", version):
                raise GrocyError("incompatible", "暂仅支持 Grocy 4.x；请核对实际版本和接口")
            checks = {}
            for path in (
                "objects/products",
                "objects/locations",
                "objects/quantity_units",
                "objects/quantity_unit_conversions",
                "objects/shopping_locations",
                "objects/stock_log?limit=1",
                "stock",
                "stock/volatile",
            ):
                self.request(path, probe=True)
                checks[path] = "可读取"
            return {
                "version": version,
                "checks": checks,
                "write_permission": "未执行写入；按实际操作检查",
                "checked_at": datetime.now(UTC).isoformat(),
            }

    def inventory(self):
        with self.lock:
            paths = {
                "products": "objects/products",
                "stock": "stock",
                "alerts": "stock/volatile",
                "locations": "objects/locations",
                "units": "objects/quantity_units",
                "conversions": "objects/quantity_unit_conversions",
                "shopping_locations": "objects/shopping_locations",
            }
            result = {key: self.request(path) for key, path in paths.items()}
            result["currency"] = self.request("system/config").get("CURRENCY", "")
            return result | {
                "instance_id": self.read()["instance_id"],
                "updated_at": datetime.now(UTC).isoformat(),
            }

    def product(self, product_id: int):
        with self.lock:
            return {
                "details": self.request(f"stock/products/{product_id}"),
                "entries": self.request(f"stock/products/{product_id}/entries"),
                "updated_at": datetime.now(UTC).isoformat(),
            }

    def validate_items(self, documents, *, bind=False):
        linked = [item for doc in documents for item in doc["items"] if item["product_id"]]
        if not linked:
            return
        with self.lock:
            data = self.inventory()
            for item in linked:
                product = next(
                    (p for p in data["products"] if str(p["id"]) == str(item["product_id"])), None
                )
                if not product or item["instance_id"] != data["instance_id"]:
                    raise LedgerError("关联产品已失效或实例变化，请重新选择")
                if int(product.get("enable_tare_weight_handling", 0)):
                    raise LedgerError("首版暂不支持皮重产品，请在 Grocy 核对操作")
                stock_unit = int(product["qu_id_stock"])
                factor = Decimal(1) if stock_unit == item["purchase_unit_id"] else None
                conversions = [
                    c
                    for c in data["conversions"]
                    if str(c["from_qu_id"]) == str(item["purchase_unit_id"])
                    and int(c["to_qu_id"]) == stock_unit
                    and str(c.get("product_id")) in ("None", "", "0", str(product["id"]))
                ]
                specific = [
                    c for c in conversions if str(c.get("product_id")) == str(product["id"])
                ]
                if specific or conversions:
                    factor = Decimal(str((specific or conversions)[0]["factor"]))
                if item["stock_unit_id"] != stock_unit or factor != Decimal(item["factor"]):
                    raise LedgerError("产品单位换算已变化或不支持，请重新核对")
                if item["currency"] != data["currency"] or not item["price_confirmed"]:
                    raise LedgerError("请确认 Grocy 币种下的每库存单位价格")
            if bind:
                self.bind(data["instance_id"])
