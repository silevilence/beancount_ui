import { useState, type RefObject } from "react";
import type { Journal as JournalView, Transaction } from "./api";
import { kindMark, kindTone, magnitudes, money, type AmountLine } from "./format";

export interface Filters {
  payee: string;
  narration: string;
  account: string;
}

const FILTER_FIELDS: { key: keyof Filters; label: string; placeholder: string }[] =
  [
    { key: "payee", label: "商户", placeholder: "筛选商户" },
    { key: "narration", label: "摘要", placeholder: "搜索摘要" },
    { key: "account", label: "账户", placeholder: "搜索账户" },
  ];

const AMOUNT_LABEL: Record<string, string> = {
  消费: "支出",
  收入: "收入",
  "转账 / 还款": "转出",
};

function Amounts({ lines, tone }: { lines: AmountLine[]; tone?: string }) {
  if (lines.length === 0) return <strong className="amount empty">0.00</strong>;
  return (
    <div className={`amounts ${tone ?? ""}`}>
      {lines.map((line) => (
        <strong className="amount" key={line.currency}>
          {money(line.amount, line.currency)}
        </strong>
      ))}
    </div>
  );
}

function EntryRow({
  row,
  sync,
  canEdit,
  onEdit,
  onDelete,
}: {
  row: Transaction;
  sync: string;
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const tone = kindTone(row.kind);
  async function copyRaw() {
    try {
      await navigator.clipboard.writeText(row.raw);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <article className={`entry ${tone}`}>
      <span className={`entry-chip ${tone}`} title={row.kind}>
        {kindMark(row.kind)}
      </span>
      <div className="entry-main">
        <h3 className="entry-title">{row.payee || row.narration}</h3>
        <p className="entry-sub">
          {row.payee ? row.narration : ""}
          {row.tags.map((tag) => (
            <span className="tag" key={tag}>
              #{tag}
            </span>
          ))}
        </p>
        <table className="postings">
          <tbody>
            {row.postings.map((posting, index) => (
              <tr key={index}>
                <td>{posting.account}</td>
                <td className="posting-amount">
                  {money(posting.amount, posting.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="entry-meta">
          <span className="src">
            {row.file}:{row.line}
          </span>
          <span>{sync}</span>
          {row.readonly && <span className="readonly">历史导入只读</span>}
          {!row.readonly && !row.simple && <span>复杂分录</span>}
        </div>
        <details className="raw">
          <summary>查看原文</summary>
          <div className="raw-head">
            <span>Beancount 原文</span>
            <button className="ghost small" onClick={() => void copyRaw()}>
              {copied ? "已复制" : "复制"}
            </button>
          </div>
          <pre>{row.raw}</pre>
        </details>
        {!row.readonly && (
          <div className="row-actions">
            <button className="ghost small" disabled={!canEdit} onClick={onEdit}>
              {row.simple ? "修改" : "高级编辑"}
            </button>
            <button
              className="ghost small danger"
              disabled={!canEdit}
              onClick={onDelete}
            >
              删除
            </button>
          </div>
        )}
      </div>
      <div className="entry-figure">
        <span className="figure-label">{AMOUNT_LABEL[row.kind] ?? "金额"}</span>
        <Amounts lines={magnitudes(row.postings)} tone={tone} />
      </div>
    </article>
  );
}

export default function Journal({
  journal,
  filters,
  onFilter,
  searchRef,
  canEdit,
  onEdit,
  onDelete,
}: {
  journal?: JournalView;
  filters: Filters;
  onFilter: (next: Filters) => void;
  searchRef?: RefObject<HTMLInputElement | null>;
  canEdit: boolean;
  onEdit: (row: Transaction) => void;
  onDelete: (row: Transaction) => void;
}) {
  const filtered =
    filters.payee !== "" ||
    filters.narration !== "" ||
    filters.account !== "";
  return (
    <section className="panel journal">
      <div className="panel-head">
        <h2>当日流水</h2>
        <span className="panel-meta">
          {journal ? `${journal.transactions.length} 笔` : "读取中"}
        </span>
      </div>
      <div className="filters">
        {FILTER_FIELDS.map(({ key, label, placeholder }, index) => (
          <label className="filter-field" key={key}>
            <span>{label}</span>
            <input
              ref={index === 0 ? searchRef : undefined}
              aria-label={label}
              value={filters[key]}
              placeholder={placeholder}
              onChange={(event) =>
                onFilter({ ...filters, [key]: event.target.value })
              }
            />
          </label>
        ))}
        <button
          className="ghost small"
          disabled={!filtered}
          onClick={() => onFilter({ payee: "", narration: "", account: "" })}
        >
          清空筛选
        </button>
      </div>
      {!journal && <p className="empty">正在读取账本…</p>}
      {journal?.transactions.length === 0 && (
        <div className="empty">
          <p>这一天还没有匹配的记录。</p>
          <small>可以切换日期、清空筛选，或直接记一笔。</small>
        </div>
      )}
      {journal?.transactions.map((row) => (
        <EntryRow
          key={row.id}
          row={row}
          sync={journal.sync}
          canEdit={canEdit}
          onEdit={() => onEdit(row)}
          onDelete={() => onDelete(row)}
        />
      ))}
    </section>
  );
}
