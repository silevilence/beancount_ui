from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .config import Settings
from .ledger import Ledger, LedgerError


def create_app(settings: Settings | None = None):
    app = FastAPI(title="日用账本", version="0.1.0")
    app.state.ledger = Ledger(settings) if settings else None

    def get_ledger():
        if app.state.ledger is None:
            app.state.ledger = Ledger(Settings.from_env())
        return app.state.ledger

    @app.exception_handler(ValueError)
    def value_error(request: Request, exc: ValueError):
        return JSONResponse(status_code=422, content={"detail": str(exc)})

    @app.exception_handler(LedgerError)
    def ledger_error(request: Request, exc: LedgerError):
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.get("/api/ledger")
    def status():
        return get_ledger().status()

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    return app
