# 日用账本

Python / FastAPI + React / TypeScript 的本地 Beancount 记账界面。账本文本是唯一正式数据源。

## Windows 开发（不需要 Docker）

安装 Git、[uv](https://docs.astral.sh/uv/getting-started/installation/) 和 Node.js 24 LTS。
所有 Python 命令都通过 uv 执行，Python 3.12 会由 uv 管理。

在项目根目录运行 PowerShell：

```powershell
uv sync --locked
npm --prefix frontend ci
# 仅第一次：将示例复制到应用目录之外；已有真实账本直接指定路径，不复制覆盖。
Copy-Item examples/ledger ../beancount-demo -Recurse
$env:BEANCOUNT_LEDGER_DIR = (Resolve-Path ../beancount-demo).Path
$env:BEANCOUNT_STATE_DIR = Join-Path (Split-Path $env:BEANCOUNT_LEDGER_DIR) '.beancount-demo-ui'
uv run uvicorn beancount_ui.app:create_app --factory --host 127.0.0.1 --port 8000 --reload
```

另一终端运行 `npm --prefix frontend run dev`，访问 http://127.0.0.1:5173。
后端健康检查 http://127.0.0.1:8000/api/health，API 调试文档 http://127.0.0.1:8000/docs。
Vite 代理 `/api`，无需跨域配置。默认仅监听本机，不要开放到公网或局域网；认证和私网部署在阶段三。
日期使用 Asia/Shanghai；用户选中的补记日期不会在午夜自动切换。

依赖精确版本记录于 `uv.lock`、`frontend/package-lock.json`。生产前端资源由 `npm --prefix frontend run build` 生成。
普通 CI 直接在 Windows / Linux 执行以下检查，不需要容器、个人账本或 GitHub 凭据。

```powershell
uv run ruff check .
uv run pytest --cov=beancount_ui --cov-report=term-missing
npm --prefix frontend run check
npm --prefix frontend test
npm --prefix frontend run build
```

运行时账本与状态目录必须独立于源代码。状态目录不得提交，保存后本地账本是否同步由 Git 状态单独表示。
开发服务的 `--reload` 用于后端调试；React 自动热更新。测试始终复制脱敏夹具到临时目录。
