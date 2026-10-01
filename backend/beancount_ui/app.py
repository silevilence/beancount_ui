import os
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from filelock import Timeout
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .access import Access
from .config import Settings
from .finance import FinanceInput, compose_finance
from .git_network import ProxyInput
from .github_auth import GithubAuthInput
from .income import income_days
from .ledger import Ledger, LedgerError
from .models import BatchMutation, CommitInput, Mutation
from .orders import orders
from .query import daily_view
from .scheduler import ScheduleInput, Scheduler, configure
from .sync import BackupInput, ConnectInput, Sync
from .templates import recommendations
from .writer import Writer


def create_app(settings: Settings | None = None, access: Access | None = None):
    access = access or Access.from_env()

    @asynccontextmanager
    async def lifespan(app):
        if settings or os.environ.get("BEANCOUNT_LEDGER_DIR"):
            app.state.scheduler = Scheduler(get_sync())
            app.state.scheduler.start()
        try:
            yield
        finally:
            if app.state.scheduler:
                app.state.scheduler.stop()

    app = FastAPI(title="日用账本", version="0.1.2", lifespan=lifespan)
    app.state.scheduler = None
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=access.hosts)
    app.middleware("http")(access.protect)

    @app.get("/api/access")
    def access_status(request: Request):
        return {
            "required": access.mode == "private",
            "authenticated": access.mode == "local" or access.authenticated(request),
        }

    app.state.ledger = Ledger(settings) if settings else None
    app.state.writer = None

    def get_ledger():
        if app.state.ledger is None:
            app.state.ledger = Ledger(Settings.from_env())
        return app.state.ledger

    def get_writer():
        if app.state.writer is None:
            app.state.writer = Writer(get_ledger())
        return app.state.writer

    def get_sync():
        return Sync(get_writer())

    @app.get("/api/sync")
    def sync_status():
        result = get_sync().status()
        if app.state.scheduler:
            result["schedule_reason"] = app.state.scheduler.reason
        return result

    @app.post("/api/sync/schedule")
    def sync_schedule(request: ScheduleInput):
        return configure(get_sync(), request)

    @app.post("/api/sync/proxy")
    def sync_proxy(request: ProxyInput):
        return get_sync().configure_proxy(request)

    @app.post("/api/sync/github-auth")
    def github_auth(request: GithubAuthInput):
        return get_sync().configure_github_auth(request)

    @app.delete("/api/sync/github-auth")
    def delete_github_auth():
        return get_sync().remove_github_auth()

    @app.post("/api/sync/check-connection")
    def check_connection():
        return get_sync().check_connection()

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        if request.url.path == "/api/sync/github-auth":
            # Pydantic's usual validation response includes the rejected input.
            return JSONResponse(status_code=422, content={"detail": "请填写 GitHub 用户名和 Token"})
        return await request_validation_exception_handler(request, exc)

    @app.post("/api/sync/preview")
    def sync_preview(request: ConnectInput):
        return get_sync().preview(request.include)

    @app.post("/api/sync/clone")
    def sync_clone():
        return get_sync().clone()

    @app.post("/api/sync/connect")
    def sync_connect(request: ConnectInput):
        return get_sync().connect(request)

    @app.post("/api/sync/backup-preview")
    def backup_preview():
        return get_sync().backup_preview()

    @app.post("/api/sync/backup")
    def backup(request: BackupInput):
        return get_sync().backup(request)

    @app.exception_handler(OSError)
    @app.exception_handler(Timeout)
    def io_error(request: Request, exc: Exception):
        if request.url.path.startswith("/api/sync"):
            return JSONResponse(
                status_code=503,
                content={"detail": "备份暂不可用；本地已保存的记录保留，请稍后重新同步。"},
            )
        if request.method == "GET":
            return JSONResponse(
                status_code=503,
                content={"detail": "账本正在写入、备份或暂不可用；已保存记录保留，请稍后刷新。"},
            )
        return JSONResponse(
            status_code=503,
            content={
                "detail": "文件暂不可用或正被占用；保存结果未确认，请保留原请求重试，不要重复新增。"
            },
        )

    @app.exception_handler(ValueError)
    def value_error(request: Request, exc: ValueError):
        return JSONResponse(status_code=422, content={"detail": str(exc)})

    @app.exception_handler(LedgerError)
    def ledger_error(request: Request, exc: LedgerError):
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.get("/api/ledger")
    def status():
        with get_writer().guard():
            result = get_ledger().status()
            result["git"]["sync"] = get_sync().status().get("sync", "已保存 · 尚未接入")
            return result

    @app.get("/api/journal")
    def journal(day: date | None = None, payee: str = "", narration: str = "", account: str = ""):
        with get_writer().guard():
            result = daily_view(get_ledger(), day, payee, narration, account)
            result["sync"] = get_sync().status().get("sync", "已保存 · 尚未接入")
            return result

    @app.post("/api/finance/compose")
    def finance(request: FinanceInput):
        with get_writer().guard():
            return compose_finance(get_ledger().refresh(), request)

    @app.get("/api/income/days")
    def yields(start: date, end: date):
        with get_writer().guard():
            return income_days(get_ledger().refresh(), start, end)

    @app.get("/api/orders")
    def order_list():
        with get_writer().guard():
            snapshot = get_ledger().refresh()
            if snapshot.errors:
                raise LedgerError("账本有错误，不能关联订单")
            return orders(snapshot)

    @app.get("/api/templates")
    def templates(day: date):
        with get_writer().guard():
            return recommendations(get_ledger().refresh(), day)

    @app.post("/api/preview")
    def preview(mutation: Mutation):
        return get_writer().preview(mutation)

    @app.post("/api/batch/preview")
    def batch_preview(mutation: BatchMutation):
        return get_writer().preview(mutation)

    @app.post("/api/commit")
    def commit(request: CommitInput):
        return get_writer().commit(str(request.request_id))

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    frontend = Path(
        os.environ.get(
            "BEANCOUNT_FRONTEND_DIR", str(Path(__file__).resolve().parents[2] / "frontend" / "dist")
        )
    )
    if frontend.is_dir():
        current_settings = settings or (
            Settings.from_env() if os.environ.get("BEANCOUNT_LEDGER_DIR") else None
        )
        if current_settings:
            public = frontend.resolve()
            for private in (
                current_settings.ledger_dir.resolve(),
                current_settings.state_dir.resolve(),
            ):
                if public.is_relative_to(private) or private.is_relative_to(public):
                    raise ValueError("静态资源目录不得与账本或状态目录重叠")
        app.mount("/", StaticFiles(directory=frontend, html=True), name="frontend")

    return app
