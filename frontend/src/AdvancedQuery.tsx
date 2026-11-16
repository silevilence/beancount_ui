import { useEffect, useRef, useState } from "react";
import { api, reasonOf } from "./api";
import { Empty, Notice } from "./ui";
import type { ReportStatus } from "./statisticsData";
import BqlEditor, { type BqlEditorHandle } from "./BqlEditor";
import BqlReference from "./BqlReference";
import { bqlExamples as examples } from "./bql";
import "./bql.css";

interface QueryResult extends ReportStatus {
  columns: string[];
  rows: (string | null)[][];
  truncated: boolean;
  limit: number;
}
export default function AdvancedQuery({ revision }: { revision: string }) {
  const [query, setQuery] = useState(examples[0].query);
  const [result, setResult] = useState<{ data: QueryResult; query: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showReference, setShowReference] = useState(false);
  const editor = useRef<BqlEditorHandle>(null);
  const tooLong = query.length > 20000;
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function run() {
    if (busy || !query.trim() || tooLong) return;
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
      <p className="muted">
        载入示例后可修改，再点击运行。日期示例中的年份也可自行调整。
      </p>
      <div className="actions" aria-label="查询示例">
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
      <div className={`bql-workspace${showReference ? " with-reference" : ""}`}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <div className="bql-toolbar">
            <strong>BQL 查询</strong>
            <div className="actions">
              <button
                type="button"
                className="ghost small"
                onClick={() => editor.current?.complete()}
              >
                显示补全
              </button>
              <button
                type="button"
                className="ghost small"
                aria-expanded={showReference}
                aria-controls="bql-reference"
                onClick={() => setShowReference(!showReference)}
              >
                {showReference ? "收起手册" : "手册速查"}
              </button>
            </div>
          </div>
          <BqlEditor
            ref={editor}
            value={query}
            onChange={setQuery}
            onRun={() => void run()}
          />
          <p id="bql-editor-help" className="muted bql-help">
            Ctrl / ⌘ + Enter 运行 · Ctrl + Space 补全 · ↑↓ 选择，Enter 插入，Esc
            关闭 · Tab 离开编辑器（片段内切换参数）
          </p>
          {tooLong && (
            <Notice tone="error">
              查询超过 20,000 字符，请缩短后再运行（当前{" "}
              {query.length.toLocaleString()} 字符）。
            </Notice>
          )}
          <button type="submit" disabled={busy || !query.trim() || tooLong}>
            {busy ? "正在查询…" : "运行查询"}
          </button>
        </form>
        {showReference && (
          <BqlReference onInsert={(text) => editor.current?.insert(text)} />
        )}
      </div>
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
