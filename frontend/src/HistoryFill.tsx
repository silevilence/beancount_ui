import { useEffect, useId, useRef, useState } from "react";
import { api, reasonOf, type Transaction } from "./api";
import { money, transactionTotals } from "./format";
import { Notice } from "./ui";

interface Results {
  transactions: Transaction[];
  has_more: boolean;
}

function HistorySearch({ onApply }: { onApply: (row: Transaction) => void }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Results>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          q: query.trim(),
          page: String(page),
        });
        const data = await api<Results>(`/transactions/search?${params}`, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setResult(data);
      } catch (e) {
        if (!controller.signal.aborted) setError(reasonOf(e));
      }
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, page, attempt]);

  function changePage(next: number) {
    setError("");
    setResult(undefined);
    setPage(next);
  }
  return (
    <>
      <label className="field">
        <span>搜索历史记录</span>
        <input
          autoFocus
          type="search"
          placeholder="商户、摘要、备注、账户或日期"
          maxLength={200}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            changePage(1);
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.nativeEvent.isComposing &&
              event.keyCode !== 229
            )
              event.preventDefault();
          }}
        />
      </label>
      <p className="muted small">选择一笔作为新记录，日期沿用当前表单。</p>
      {error ? (
        <Notice
          tone="error"
          action={
            <button
              type="button"
              onClick={() => {
                setError("");
                setAttempt(attempt + 1);
              }}
            >
              重试搜索
            </button>
          }
        >
          {error}
        </Notice>
      ) : !result ? (
        <p role="status">正在搜索…</p>
      ) : (
        <>
          {!result.transactions.length && (
            <p role="status">没有找到匹配的记录。</p>
          )}
          <ul className="history-results">
            {result.transactions.map((row) => {
              const managedRaw =
                !row.posting_form && Object.keys(row.metadata || {}).length > 0;
              const totals = transactionTotals(row.kind, row.postings);
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    className="ghost history-result"
                    disabled={managedRaw}
                    onClick={() => onApply(row)}
                  >
                    <strong>
                      {[row.payee, row.narration].filter(Boolean).join(" · ") ||
                        row.kind}
                    </strong>
                    {totals.length > 0 && (
                      <span className="history-amount">
                        {totals
                          .map((p) => money(p.amount, p.currency))
                          .join(" / ")}
                      </span>
                    )}
                    <small>
                      <time dateTime={row.date}>{row.date}</time> ·{" "}
                      {row.postings
                        .map((p) =>
                          p.note ? `${p.account}（${p.note}）` : p.account,
                        )
                        .join(" · ")}
                    </small>
                    {row.note && <small>{row.note}</small>}
                    {managedRaw ? (
                      <small>含订单关联的复杂原文，无法套用</small>
                    ) : (
                      !row.posting_form && <small>使用原文编辑</small>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {(page > 1 || result.has_more) && (
            <div className="quick-fill-actions">
              <button
                type="button"
                className="ghost small"
                disabled={page === 1}
                onClick={() => changePage(page - 1)}
              >
                上一页
              </button>
              <span>第 {page} 页</span>
              <button
                type="button"
                className="ghost small"
                disabled={!result.has_more}
                onClick={() => changePage(page + 1)}
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

export default function HistoryFill({
  onApply,
}: {
  onApply: (row: Transaction) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  return (
    <div
      className="history-fill"
      onKeyDown={(event) => {
        if (
          open &&
          event.key === "Escape" &&
          !event.nativeEvent.isComposing &&
          event.keyCode !== 229
        ) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="chip-btn"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {open ? "收起历史记录" : "从历史记录填入"}
      </button>
      <div id={id}>
        {open && (
          <HistorySearch
            onApply={(row) => {
              onApply(row);
              setOpen(false);
            }}
          />
        )}
      </div>
    </div>
  );
}
