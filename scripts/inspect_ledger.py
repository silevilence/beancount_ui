"""Read-only local baseline report. May contain private diagnostics; never commit its output."""

import argparse
import json
from pathlib import Path

from beancount_ui.config import Settings
from beancount_ui.ledger import Ledger, read_files

cli = argparse.ArgumentParser(description=__doc__)
cli.add_argument("directory", type=Path)
args = cli.parse_args()
root = args.directory.resolve()
before = read_files(root)
status = Ledger(Settings(root, root.parent / f".{root.name}-ui")).status()
status["unchanged"] = before == read_files(root)
print(json.dumps(status, ensure_ascii=False, indent=2))
