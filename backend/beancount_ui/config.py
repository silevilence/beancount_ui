import os
from dataclasses import dataclass
from pathlib import Path

from .git_network import validate_proxy


@dataclass(frozen=True)
class Settings:
    ledger_dir: Path
    state_dir: Path
    entry: str = "main.beancount"
    remote: str = ""
    branch: str = "master-1"
    git_proxy: str = ""

    def __post_init__(self):
        if self.git_proxy:
            object.__setattr__(self, "git_proxy", validate_proxy(self.git_proxy))
        ledger, state = self.ledger_dir.resolve(), self.state_dir.resolve()
        object.__setattr__(self, "ledger_dir", ledger)
        object.__setattr__(self, "state_dir", state)
        project = Path(__file__).resolve().parents[2]
        if ledger == project or project.is_relative_to(ledger) or ledger.is_relative_to(project):
            raise ValueError("账本目录必须位于应用代码目录之外")
        if state == ledger or state.is_relative_to(ledger) or ledger.is_relative_to(state):
            raise ValueError("状态目录与账本目录必须分离且不能互相嵌套")
        if state.is_relative_to(project) or project.is_relative_to(state):
            raise ValueError("状态目录必须位于应用代码目录之外")

    @classmethod
    def from_env(cls):
        root = os.environ.get("BEANCOUNT_LEDGER_DIR")
        if not root:
            raise ValueError("请设置 BEANCOUNT_LEDGER_DIR 为独立账本目录")
        ledger = Path(root).resolve()
        state = Path(
            os.environ.get("BEANCOUNT_STATE_DIR", str(ledger.parent / f".{ledger.name}-ui"))
        )
        state = state.resolve()
        return cls(
            ledger,
            state,
            remote=os.environ.get("BEANCOUNT_GIT_REMOTE", ""),
            branch=os.environ.get("BEANCOUNT_GIT_BRANCH", "master-1"),
            git_proxy=os.environ.get("BEANCOUNT_GIT_PROXY", ""),
        )
