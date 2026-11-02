import { useEffect, useRef, useState } from "react";
import { api, reasonOf } from "./api";
import { Empty, Notice } from "./ui";
import type { ReportStatus } from "./statisticsData";

interface QueryResult extends ReportStatus {
  columns: string[];
  rows: (string | null)[][];
  truncated: boolean;
  limit: number;
}
const examples = [
  {
    label: "按商家汇总支出",
    query:
      "SELECT payee, currency, sum(number) AS total\nWHERE account ~ '^Expenses:'\nGROUP BY payee, currency\nORDER BY total DESC",
  },
  {
    label: "按摘要匹配流水",
    query:
      "SELECT date, payee, narration, account, position\nWHERE narration ~ '购物|餐饮'\nORDER BY date DESC\nLIMIT 100",
  },
  { label: "账户余额", query: "BALANCES" },
];
export default function AdvancedQuery({ revision }: { revision: string }) {
  const [query, setQuery] = useState(examples[0].query);
  const [result, setResult] = useState<{ data: QueryResult; query: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function run() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      const data = await api<QueryResult>("/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setResult({ data, query });
    } catch (e) {
      if (!controller.signal.aborted) setError(reasonOf(e));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="panel advanced-query" aria-label="bean-query 高级查询">
      <h2>bean-query 高级查询</h2>
      <p className="muted">
        查询当前账本。支持 SELECT、BALANCES、JOURNAL，只读执行；最多显示 1000
        行，超过 10 秒会停止。金额保留原始精度。
      </p>
      <div className="actions">
        {examples.map((example) => (
          <button
            className="ghost small"
            key={example.label}
            onClick={() => setQuery(example.query)}
          >
            {example.label}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label>
          BQL 查询
          <textarea
            className="query-input"
            value={query}
            required
            maxLength={20000}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button type="submit" disabled={busy || !query.trim()}>
          {busy ? "正在查询…" : "运行查询"}
        </button>
      </form>
      {error && <Notice tone="error">{error}</Notice>}
      {result && (
        <>
          {(result.data.stale ||
            (revision && revision !== result.data.revision)) && (
            <Notice tone="warn">
              账本已变化或校验失败；以下结果来自上一次有效快照，请修正账本后重新查询。
            </Notice>
          )}
          {result.query !== query && (
            <Notice tone="warn">查询文字已修改，以下仍为上次运行结果。</Notice>
          )}
          <p>
            {result.data.rows.length} 行
            {result.data.truncated
              ? ` · 仅显示前 ${result.data.limit} 行，请缩小查询范围`
              : ""}
          </p>
          {!result.data.rows.length ? (
            <Empty>查询没有返回数据。</Empty>
          ) : (
            <div
              className="data-table-scroll"
              tabIndex={0}
              aria-label="高级查询结果，可横向滚动"
            >
              <table>
                <thead>
                  <tr>
                    {result.data.columns.map((column, i) => (
                      <th key={i}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.data.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td key={j}>{cell ?? "—"}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
