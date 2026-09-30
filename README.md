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

## VS Code：F5 前后端联调

用 VS Code 打开仓库根目录，安装工作区推荐的 Python 和 Python Debugger 扩展，并准备好 Microsoft Edge。
首次调试在根目录 PowerShell 终端执行：

```powershell
uv sync --locked
npm --prefix frontend ci
```

F5 会先准备本地配置：缺少 `.env` 时从 `.env.example` 创建，并在仓库旁的 `../beancount-demo` 不存在时复制演示账本；已有配置和账本不会覆盖。
`.env` 已被 Git 忽略，默认指向仓库外的演示账本和状态目录；需要其他测试副本时修改其中的路径（也可在首次启动前自行创建 `.env`）。
路径相对于仓库根目录，也可填写绝对路径（Windows 推荐使用 `/`）。已存在的同名环境变量优先于 `.env`。
工作区默认使用 uv 创建的 `.venv`。若 VS Code 已记住失效的解释器，运行「Python: 选择解释器」，选择 `.venv/Scripts/python.exe`（Windows）。

在「运行和调试」下拉框选择 **全栈：前后端联调**，按 **F5**：

- 后端任务通过 `uv run --locked` 启动 Uvicorn，监听 `127.0.0.1:8000`；Python 调试器连接本机 `5678` 端口，支持后端断点及代码热重载。
- Vite 固定监听 `127.0.0.1:5173`，就绪后自动打开 Edge 调试页面；可以在 `frontend/src` 的 TypeScript / TSX 文件中打断点，React 保持热更新。
- 两端也可以分别选择「后端：FastAPI (uv)」或「前端：Vite + Edge」启动。仅启动前端时需已有后端服务。

按 **Shift+F5** 停止联调会停止 Vite 和浏览器调试，并断开 Python 调试器。
后端作为后台任务继续运行；完全结束时，在「启动后端 (uv)」任务终端按 **Ctrl+C**，或运行命令「任务: 终止任务」。
再次 F5 可复用仍运行的后端任务。端口被其他服务占用时先停止该服务，Vite 不会自动换端口。
后端健康检查为 http://127.0.0.1:8000/api/health，API 文档为 http://127.0.0.1:8000/docs。

## 已实现：阶段一

- 工作台按 Asia/Shanghai 的今天打开，可切换日期并按商户、摘要和账户筛选；月文件与专项文件合并展示。
- 点击「记一笔」，填写精确金额、分类与付款账户，先预览完整文件差异，再确认保存；可以连续录入。
- 历史交易可原位修改或删除；多分录、收入、成本/价格等复杂记录使用原文高级编辑。历史导入目录保持只读。
- 外部修改会自动重载；账本错误会阻止写入并明确标记上次有效视图。保存后未同步与保存失败分开表达。
- 超时后选择「使用原请求重试保存」；刷新后可「恢复原请求」。不要在结果未确认时重新记一笔。
- 「待记便笺」仅属于当前页面会话，不参与收支；需要恢复的记录请使用「集中补记」。GitHub 同步仍属于阶段三。

## 已实现：阶段二

点击「集中补记 / 业务模板」使用固定日期的连续录入、按账本隔离的持久化草稿、近期推荐和可管理快捷模板。
草稿加入队列后统一预览、完整校验并整批入账，失败不会部分保存；网络异常时重试原批次。

- 购物单支持多分类、商品备注和负折扣；88VIP 默认填写实付金额，明细合计必须与实付一致。
- 淘宝区分直接付款、待付款下单、部分结算、已付款退款和未结算负债冲回；历史关联须显式确认。
- 余额宝支持逐日缺口核对与批量补录，已有日期通过更正入口修改；工资/奖金、话费与水电费按明确业务路由。
- 转账及信用账户还款可单列手续费；余额断言显示日初余额与差额，不生成补差。
- 高级原文支持外币、成本/价格、标签、元数据、省略金额及辅助权益分录；零金额只提示检查。

操作和恢复边界见 [阶段二使用说明](docs/phase-two-workflows.md)，完整验证见 [阶段二审核报告](docs/phase-two-review.md)。

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
