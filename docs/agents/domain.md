# Domain docs

本项目采用 single-context 布局。

## 探索代码前读取

- 根目录 `CONTEXT.md`：领域术语、概念及约束。
- `docs/adr/`：与当前工作相关的架构决策。

文件不存在时直接继续，不提示缺失，也不预先创建空文件。
领域术语或决策得到明确结论后，由 domain-modeling 技能按需建立。

## 文档布局

- `CONTEXT.md`：项目统一领域上下文。
- `docs/adr/NNNN-<decision>.md`：按编号记录架构决策。

现有 `docs/product-plan.md` 和 `docs/ledger-analysis.md`
继续作为产品规划与账本分析资料，涉及相关工作时读取。

## 使用规则

- 命名领域概念时沿用 CONTEXT.md 中的术语，避免任意替换同义词。
- 需要的概念尚未定义时，检查是否引入了不必要的新术语；
  确有缺口时记录供 domain-modeling 补充。
- 建议与已有 ADR 冲突时，明确指出对应 ADR 和重新讨论的理由，
  不静默覆盖已有决策。
