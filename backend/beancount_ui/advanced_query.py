"""Run BQL against an immutable snapshot in a bounded, read-only worker."""

import json
import pickle
import subprocess
import sys

from pydantic import BaseModel, ConfigDict, Field

from .ledger import Ledger, LedgerError
from .statistics import report_snapshot
from .writer import Writer


class QueryInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(min_length=1, max_length=20000)


def execute_query(entries, options, query, limit=1000):
    import beanquery
    from beanquery.parser import ast

    connection = beanquery.connect("beancount:", entries=entries, errors=[], options=options)
    statement = connection.parse(query)
    if not isinstance(statement, (ast.Select, ast.Balances, ast.Journal)):
        raise ValueError("只支持 SELECT、BALANCES 和 JOURNAL 只读查询")
    if any(isinstance(node, (ast.CreateTable, ast.Insert)) for node in statement.walk()):
        raise ValueError("查询不能创建表或写入数据")
    cursor = connection.execute(statement)
    rows = cursor.fetchmany(limit + 1)
    return {
        "columns": [column.name for column in cursor.description],
        "rows": [[None if cell is None else str(cell) for cell in row] for row in rows[:limit]],
        "truncated": len(rows) > limit,
        "limit": limit,
    }


def advanced_query(ledger: Ledger, request: QueryInput):
    with Writer(ledger).guard():
        snapshot, status = report_snapshot(ledger)
    if not status["available"]:
        raise LedgerError("账本校验失败，尚无有效查询数据")
    try:
        process = subprocess.run(
            [sys.executable, "-m", "beancount_ui.advanced_query"],
            input=pickle.dumps((snapshot.entries, snapshot.options, request.query)),
            capture_output=True,
            timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired as exc:
        raise ValueError("查询超过 10 秒，请增加日期条件或简化查询") from exc
    if process.returncode:
        raise LedgerError("高级查询进程失败，请简化查询后重试")
    result = json.loads(process.stdout)
    if "error" in result:
        raise ValueError(f"查询失败：{result['error']}")
    return {**status, **result}


if __name__ == "__main__":
    # Only the parent application supplies this internal pipe; never unpickle HTTP input.
    try:
        payload = execute_query(*pickle.loads(sys.stdin.buffer.read()))
    except Exception as exc:
        payload = {"error": str(exc)[:2000] or type(exc).__name__}
    sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
