# Agent instructions

## Python tooling

所有 Python 操作统一通过 `uv` 进行，包括解释器管理、虚拟环境创建、依赖管理、脚本运行、测试及其他 Python 工具执行。

## Agent skills

### Issue tracker

任务统一记录在根目录 `ROADMAP.md`，沿用现有分区和任务格式。
具体操作见 `docs/agents/issue-tracker.md`。

### Triage labels

使用五个默认分流标签，在 ROADMAP 任务条目内记录。
标签含义见 `docs/agents/triage-labels.md`。

### Domain docs

采用 single-context 布局：根目录 `CONTEXT.md` 和 `docs/adr/`。
读取规则见 `docs/agents/domain.md`。
