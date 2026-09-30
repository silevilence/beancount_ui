# Beancount 兼容基线

2026-09-30 验证：Python 3.12.8 / Beancount **3.2.3**（精确依赖见 uv.lock）。
官方 [loader 文档](https://beancount.github.io/docs/running_beancount_and_generating_reports/)说明加载会执行完整账本校验；本应用在临时副本中调用 loader，并关闭 pickle 缓存，避免读取时写回账本。

| 样本 | include 文件 | 加载指令 | 错误 | 原文件 |
| --- | ---: | ---: | ---: | --- |
| MyBill master-1，固定 6c09193b0858a37055e9fb530a547f8ccc4f73c9 | 89 | 12,653 | 0 | 所有非 Git 文件 SHA-256 前后一致 |
| 仓库内脱敏样例 | 12 | 测试实时校验 | 0 | 测试前后字节一致 |
| MyBill master-1，最新 fee22175eaaf8471b170b6ff31c62ddcb81e4d80（含 9 月） | 90 | 12,761 | 0 | 全部账本字节摘要前后一致 |

真实快照仅存在被 Git 忽略的 `.local/reference-ledger`，不会进入测试、CI 或提交。
已通过全入口验证历史导入、账户/币种、标签作用域、省略金额、价格和成本。
原阶段一尚无本地 9 月副本；现已只读验证 GitHub 最新 9 月账单，未从历史记录推算新账。

日后接入任意本地副本（只读检查，不会 reset、clean、提交或推送）：

```powershell
uv run python scripts/inspect_ledger.py C:/path/to/MyBill
```

输出包含实际文件名、错误行和诊断，可能涉及私人账务，请保存在仓库外。
界面显示相同的 include 链、未纳入文件、Git 分支、提交及未提交变化。
错误账本不可正式写入；修复应先按诊断定位源文件，重新校验后恢复。

第一版安全边界：仅允许账本目录内 `.bean` / `.beancount` include（支持 glob），拒绝越界路径、符号链接、目录联接和自定义插件。
这些不支持的输入明确报错，不能悄悄省略。插件可能执行任意 Python，需要后续专门接入。
历史导入只读，不向 `gnucash/` 新增或修改交易。

## 阶段三更新基线（2026-09-30）

9 月账单已同步 GitHub。独立只读克隆 `master-1` 的 `fee22175eaaf8471b170b6ff31c62ddcb81e4d80`：90 个账本文件全部被 include，12,761 条指令，Beancount 3.2.3 零错误，包含 `txs/2026/09.bean`。读取前后全部账本字节摘要一致；副本位于系统临时目录，不加入源码、测试夹具或 CI。

阶段一“待提供本地 9 月副本”的历史状态，现已由本次最新 GitHub 基线替代。额外本地补记仍应通过接入预览保护，不覆盖克隆。
