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

## 已实现：阶段一

- 工作台按 Asia/Shanghai 的今天打开，可切换日期并按商户、摘要和账户筛选；月文件与专项文件合并展示。
- 点击「记一笔」，填写精确金额、分类与付款账户，先预览完整文件差异，再确认保存；可以连续录入。
- 历史交易可原位修改或删除；多分录、收入、成本/价格等复杂记录使用原文高级编辑。历史导入目录保持只读。
- 外部修改会自动重载；账本错误会阻止写入并明确标记上次有效视图。保存后未同步与保存失败分开表达。
- 超时后选择「使用原请求重试保存」；刷新后可「恢复原请求」。不要在结果未确认时重新记一笔。
- 「待记便笺」仅属于当前页面会话，不参与收支。阶段二将实现可靠的批量草稿与模板；阶段三将实现 GitHub 同步。

Beancount 支持版本、真实快照及待提供副本见 [兼容基线](docs/compatibility.md)。
保存与中断恢复、状态目录备份约束见 [安全写入](docs/safe-writing.md)。
阶段一最终验证与边界见 [审核报告](docs/phase-one-review.md)。

后端拒绝非本机 Host 和非 `http://127.0.0.1:5173` / `http://localhost:5173` / 对应 8000 端口的 Origin。
按文档使用固定开发端口；这是本机开发边界，不替代阶段三的身份认证。
源码、演示账本和真实账本必须分离；不要把含私人原文的状态库、基线输出或截图加入 Git。

## 界面与交互

- 顶部为日期栏：`‹` / `›` 前后一天、`今天` 回今天，也可直接选择记账日期；`＋ 记一笔` 只在账本有效且当前视图可写时可用。
- 四张统计卡显示当日消费、当日收入、当日净额（收入 − 支出）与记录笔数；金额按币种分别格式化、等宽对齐，收支用颜色区分。
- 每条流水显示类型、商户与摘要、账户间金额流向、来源文件与行号、同步状态；展开「查看原文」可核对并复制 Beancount 原文，复杂记录标记为高级编辑。
- 对话框按「填写 → 预览校验 → 写入」三步：预览按文件列出差异行数与高亮增删，确认与取消固定在底部可见；保存后可选择继续录入，并在「本次已录入」中回看。
- 快捷键：`n` 记一笔、`/` 聚焦搜索、`r` 刷新账本、`esc` 关闭对话框。窄屏下统计卡与侧栏自动堆叠，对话框占满宽度。
