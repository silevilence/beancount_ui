import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    ledger_dir: Path
    state_dir: Path
    entry: str = "main.beancount"

    @classmethod
    def from_env(cls):
        root = os.environ.get("BEANCOUNT_LEDGER_DIR")
        if not root:
            raise ValueError("请设置 BEANCOUNT_LEDGER_DIR 为独立账本目录")
        ledger = Path(root).resolve()
        project = Path(__file__).resolve().parents[2]
        if ledger == project or project.is_relative_to(ledger) or ledger.is_relative_to(project):
            raise ValueError("账本目录必须位于应用代码目录之外；示例请先复制到独立目录")
        state = Path(
            os.environ.get("BEANCOUNT_STATE_DIR", str(ledger.parent / f".{ledger.name}-ui"))
        )
        state = state.resolve()
        if state == ledger or state.is_relative_to(ledger) or ledger.is_relative_to(state):
            raise ValueError("状态目录与账本目录必须分离且不能互相嵌套")
        return cls(ledger, state)
