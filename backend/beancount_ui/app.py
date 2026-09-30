from datetime import date

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from filelock import Timeout
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .config import Settings
from .ledger import Ledger, LedgerError
from .models import BatchMutation, CommitInput, Mutation
from .orders import orders
from .query import daily_view
from .templates import recommendations
from .writer import Writer


def create_app(settings: Settings | None = None):
    app = FastAPI(title="日用账本", version="0.1.0")
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
            return get_ledger().status()

    @app.get("/api/journal")
    def journal(day: date | None = None, payee: str = "", narration: str = "", account: str = ""):
        with get_writer().guard():
            return daily_view(get_ledger(), day, payee, narration, account)

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
