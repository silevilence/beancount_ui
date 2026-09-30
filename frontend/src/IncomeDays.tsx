import { useState } from "react";
import { api, type Journal, type Transaction } from "./api";
import { shiftDay } from "./format";
import { Notice } from "./ui";
import type { DraftItem } from "./BatchEditor";

export default function IncomeDays({
  date,
  accounts,
  onAdd,
  onEdit,
}: {
  date: string;
  accounts: Journal["accounts"];
  onAdd: (items: DraftItem[]) => boolean | void;
  onEdit?: (row: Transaction) => void;
}) {
  const [start, setStart] = useState(shiftDay(date, -6));
  const [end, setEnd] = useState(date);
  const [rows, setRows] = useState<{ date: string; records: Transaction[] }[]>(
    [],
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [category, setCategory] = useState("");
  const [payment, setPayment] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try {
      setRows(await api(`/income/days?start=${start}&end=${end}`));
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="file-card">
      <summary>余额宝逐日收益补录</summary>
      <p className="muted">
        只填写实际收益。空白不会补零或推算；已有日期请进入更正。支持一次补录多天，统一进入整批预览。
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="form-grid">
        <label className="field">
          <span>收益起始日</span>
          <input
            aria-label="收益起始日"
            type="date"
            value={start}
            onChange={(e) => {
              setStart(e.target.value);
              setRows([]);
            }}
          />
        </label>
        <label className="field">
          <span>收益结束日</span>
          <input
            aria-label="收益结束日"
            type="date"
            value={end}
            onChange={(e) => {
              setEnd(e.target.value);
              setRows([]);
            }}
          />
        </label>
      </div>
      <button
        type="button"
        className="ghost"
        disabled={busy}
        onClick={() => void load()}
      >
        核对日期
      </button>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const added = onAdd(
            rows
              .filter((r) => !r.records.length && values[r.date])
              .map((r) => ({
                business: "yuebao",
                entry: {
                  date: r.date,
                  amount: values[r.date],
                  currency: "CNY",
                  category,
                  payment,
                  payee: "",
                  narration: "余额宝收益",
                  note: "",
                },
              })),
          );
          if (added === false) return;
          setValues({});
        }}
      >
        <div className="form-grid">
          {[
            ["收益账户", category, setCategory, "Income:"],
            ["收益到账账户", payment, setPayment, "Assets:"],
          ].map(([label, value, set, prefix]) => (
            <label key={String(label)} className="field">
              <span>{String(label)}</span>
              <select
                aria-label={String(label)}
                required
                value={String(value)}
                onChange={(e) => (set as (v: string) => void)(e.target.value)}
              >
                <option value="">请选择</option>
                {accounts
                  .filter((a) => a.name.startsWith(String(prefix)))
                  .map((a) => (
                    <option key={a.name}>{a.name}</option>
                  ))}
              </select>
            </label>
          ))}
        </div>
        {rows.map((r) => (
          <div className="file-card" key={r.date}>
            <strong>
              {r.date} · {r.records.length ? "已记录" : "未记录"}
            </strong>
            {r.records.length ? (
              r.records.map((row) => (
                <div key={row.id}>
                  <pre>{row.raw}</pre>
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => onEdit?.(row)}
                  >
                    更正 {r.date}
                  </button>
                </div>
              ))
            ) : (
              <label className="field">
                <span>实际收益 {r.date}</span>
                <input
                  aria-label={`实际收益 ${r.date}`}
                  value={values[r.date] || ""}
                  onChange={(e) =>
                    setValues({ ...values, [r.date]: e.target.value })
                  }
                />
              </label>
            )}
          </div>
        ))}
        <button
          disabled={!rows.some((r) => !r.records.length && values[r.date])}
        >
          将已填收益加入草稿
        </button>
      </form>
    </details>
  );
}
