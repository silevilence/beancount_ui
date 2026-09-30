from fastapi import FastAPI


def create_app():
    app = FastAPI(title="日用账本", version="0.1.0")

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    return app
