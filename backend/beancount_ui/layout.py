"""The only module that knows MyBill's fixed file layout."""

import fnmatch
import posixpath
import re
from datetime import date
from pathlib import PurePosixPath

from .ledger import LedgerError


def newline(content: bytes) -> bytes:
    return b"\r\n" if b"\r\n" in content else b"\n"


def append(content: bytes, addition: bytes) -> bytes:
    nl = newline(content)
    prefix = b"" if not content or content.endswith((b"\n", b"\r")) else nl
    return content + prefix + nl + addition.replace(b"\r\n", b"\n").replace(b"\n", nl)


def ensure_include(files: dict[str, bytes], parent: str, child: str):
    content = files.get(parent, b"")
    parent_dir = PurePosixPath(parent).parent
    target = str(PurePosixPath(child).relative_to(parent_dir))
    included = re.findall(rb'^\s*include\s+"([^"\r\n]+)"', content, flags=re.M)
    if not any(fnmatch.fnmatchcase(target, posixpath.normpath(i.decode())) for i in included):
        files[parent] = append(content, f'include "{target}"\n'.encode())


def insert_new(files: dict[str, bytes], business: str, day: date, raw: str) -> str:
    if business == "ordinary":
        target = f"txs/{day.year:04d}/{day.month:02d}.bean"
        chain = [
            "main.beancount",
            "index.bean",
            "txs/index.bean",
            f"txs/{day.year:04d}/index.bean",
            target,
        ]
    else:
        target = f"txs/category/{business}.bean"
        chain = [
            "main.beancount",
            "index.bean",
            "txs/index.bean",
            "txs/category/index.bean",
            target,
        ]
    for parent, child in zip(chain, chain[1:], strict=False):
        ensure_include(files, parent, child)
    original = files.get(target, b"")
    addition = raw.encode("utf-8")
    if business == "salary":
        starts = list(re.finditer(rb"^pushtag\s+#salary\s*(?:;[^\r\n]*)?$", original, re.M))
        ends = list(re.finditer(rb"^poptag\s+#salary\s*(?:;[^\r\n]*)?$", original, re.M))
        if not starts and not ends:
            files[target] = append(
                original, b"pushtag #salary\n\n" + addition + b"\npoptag #salary\n"
            )
        elif len(starts) == len(ends) == 1 and starts[0].start() < ends[0].start():
            pos = ends[0].start()
            files[target] = append(original[:pos], addition) + newline(original) + original[pos:]
        else:
            raise LedgerError("工资文件的 salary 标签范围不明确，请先整理后重试")
    else:
        files[target] = append(original, addition)
    return target
