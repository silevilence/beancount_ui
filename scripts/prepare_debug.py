"""Prepare the first VS Code launch without replacing local configuration or data."""

import shutil
from pathlib import Path


def prepare_debug(workspace: Path) -> None:
    env_file = workspace / ".env"
    if env_file.exists():
        return

    demo = workspace.parent / "beancount-demo"
    if not demo.exists():
        shutil.copytree(workspace / "examples" / "ledger", demo)
        print(f"Created demo ledger: {demo}")

    # Exclusive creation also protects a configuration created concurrently.
    try:
        with env_file.open("xb") as target:
            target.write((workspace / ".env.example").read_bytes())
    except FileExistsError:
        return
    print(f"Created local debug configuration: {env_file}")


if __name__ == "__main__":
    prepare_debug(Path(__file__).resolve().parents[1])
