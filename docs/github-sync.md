# GitHub 接入与备份

9 月账单已于 2026-09-30 同步至 GitHub。此前 6—8 月分析仍保留为历史基线；首次接入应使用最新 `master-1`，不再等待另一份本地 9 月副本。

设置 `BEANCOUNT_LEDGER_DIR` 为应用代码之外的独立仓库根目录，`BEANCOUNT_STATE_DIR` 为独立持久目录。已有仓库使用 `origin`；空目录克隆需要在服务端设置 `BEANCOUNT_GIT_REMOTE`，默认分支 `master-1`。应用不会覆盖非空目录重新克隆，也不会切换已有分支。

页面「GitHub 备份」先预览既有文件变更与未被 include 的文件。需要纳入遗漏文件时勾选后再次预览，核对入口 include 差异并确认接入。接入校验完整账本并检查远端访问；原有账本不会改变，除非明确选择补充 include。自动备份保持关闭。

凭据由运行服务的账户通过 Git credential helper、SSH agent 或挂载的 SSH/Git 配置提供。不要将令牌放入远端 URL、`.env.example`、浏览器或提交中。认证和网络失败保留本地文件，界面提供分类诊断而不返回可能含凭据的 Git 原始错误。

验收仅使用临时仓库和脱敏示例，不向真实 MyBill 仓库推送测试数据。
