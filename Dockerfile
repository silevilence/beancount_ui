# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS web
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM ghcr.io/astral-sh/uv:0.12.21 AS uv
FROM python:3.12-slim-bookworm AS python-build
COPY --from=uv /uv /uvx /bin/
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY backend/ ./backend/
RUN uv sync --locked --no-dev --no-editable

FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 bean && useradd --uid 10001 --gid bean --create-home bean \
    && mkdir -p /data/ledger /data/state && chown -R bean:bean /data
COPY --from=uv /uv /uvx /bin/
WORKDIR /app
COPY --from=python-build /app/.venv /app/.venv
COPY pyproject.toml uv.lock ./
COPY --from=web /build/dist /app/frontend
ENV BEANCOUNT_LEDGER_DIR=/data/ledger BEANCOUNT_STATE_DIR=/data/state \
    BEANCOUNT_FRONTEND_DIR=/app/frontend BEANCOUNT_ACCESS_MODE=private \
    UV_PYTHON_DOWNLOADS=never UV_NO_CACHE=1 TZ=Asia/Shanghai
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=6 \
    CMD uv run --no-sync python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)"
CMD ["uv", "run", "--no-sync", "uvicorn", "beancount_ui.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-proxy-headers"]
