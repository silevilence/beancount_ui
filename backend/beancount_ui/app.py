import os
from contextlib import asynccontextmanager
from datetime import date

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from filelock import Timeout
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .config import Settings
from .finance import FinanceInput, compose_finance
from .income import income_days
from .ledger import Ledger, LedgerError
from .models import BatchMutation, CommitInput, Mutation
from .orders import orders
from .query import daily_view
from .scheduler import ScheduleInput, Scheduler, configure
from .sync import BackupInput, ConnectInput, Sync
from .templates import recommendations
from .writer import Writer


def create_app(settings: Settings | None = None):
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

    app = FastAPI(title="日用账本", version="0.1.0", lifespan=lifespan)
    app.state.scheduler = None
    app.add_middleware(
        TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"]
    )

    @app.middleware("http")
    async def local_origin(request: Request, call_next):
        origin = request.headers.get("origin")
        allowed = {
            f"http://{host}:{port}" for host in ("127.0.0.1", "localhost") for port in (5173, 8000)
        }
        if origin is not None and origin not in allowed:
            return JSONResponse(status_code=403, content={"detail": "仅允许本机应用访问"})
        return await call_next(request)

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

    return app
