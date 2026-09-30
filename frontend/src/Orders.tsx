import { useEffect, useState } from "react";
import { api, type Journal } from "./api";
import { Notice } from "./ui";
import type { DraftItem } from "./BatchEditor";

interface Order {
  id: string;
  date: string;
  payee: string;
  narration: string;
  mode: string;
  total: string;
  unpaid: string;
  refunded: string;
  currency: string;
  account: string;
  categories: Record<string, string>;
}
export default function Orders({
  date,
  accounts,
  onAdd,
}: {
  date: string;
  accounts: Journal["accounts"];
  onAdd: (item: DraftItem) => boolean | void;
}) {
  const [rows, setRows] = useState<Order[]>([]);
  const [source, setSource] = useState("");
  const [kind, setKind] = useState("settle");
  const [amount, setAmount] = useState("");
  const [account, setAccount] = useState("");
  const [category, setCategory] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const row = rows.find((r) => r.id === source);
  async function refresh() {
    try {
      setRows(await api<Order[]>("/orders"));
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <details className="file-card">
      <summary>淘宝确认收货 / 退款</summary>
      <p className="muted">
        历史匹配仅为建议。请确认原订单与处理方式；取消关联后不会生成任何交易。赔偿等特殊收入使用高级分录。
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!row || !confirmed) return;
          const added = onAdd({
            business: "ordinary",
            order: {
              kind,
              source_id: source,
              date,
              amount,
              account: kind === "refund_unpaid" ? row.account : account,
              category,
              note,
            },
          });
          if (added === false) return;
          setAmount("");
          setConfirmed(false);
        }}
      >
        <label className="field">
          <span>关联订单</span>
          <select
            aria-label="关联订单"
            value={source}
            onChange={(e) => {
              const r = rows.find((x) => x.id === e.target.value);
              setSource(e.target.value);
              setAmount(r?.unpaid || "");
              setCategory(Object.keys(r?.categories || {})[0] || "");
              setConfirmed(false);
            }}
          >
            <option value="">请选择原交易</option>
            {rows.map((r) => (
              <option key={r.id} value={r.id}>
                {r.date} {r.payee} {r.narration} · {r.total} {r.currency}
              </option>
            ))}
          </select>
        </label>
        {row && (
          <p>
            原账户：{row.account} · 未结清：
            {row.mode === "paid" ? "0" : row.unpaid} {row.currency} · 已退款：
            {row.refunded}
          </p>
        )}
        <div className="form-grid">
          <label className="field">
            <span>处理方式</span>
            <select
              aria-label="处理方式"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setAmount("");
                setConfirmed(false);
              }}
            >
              <option value="settle">确认收货 / 部分结算</option>
              <option value="refund_paid">已付款退款（实际到账）</option>
              <option value="refund_unpaid">未结算负债冲回</option>
            </select>
          </label>
          <label className="field">
            <span>本次处理金额</span>
            <input
              aria-label="本次处理金额"
              value={amount}
              required
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          {kind !== "refund_unpaid" && (
            <label className="field">
              <span>实际付款 / 收款账户</span>
              <select
                aria-label="实际付款 / 收款账户"
                required
                value={account}
                onChange={(e) => setAccount(e.target.value)}
              >
                <option value="">请选择</option>
                {accounts
                  .filter((a) => /^(Assets|Liabilities):/.test(a.name))
                  .map((a) => (
                    <option key={a.name}>{a.name}</option>
                  ))}
              </select>
            </label>
          )}
          {kind !== "settle" && (
            <label className="field">
              <span>原费用类别</span>
              <select
                aria-label="原费用类别"
                value={category}
                required
                onChange={(e) => setCategory(e.target.value)}
              >
                {Object.entries(row?.categories || {}).map(([c, value]) => (
                  <option key={c} value={c}>
                    {c} · 可冲回 {value}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>处理备注</span>
            <input
              aria-label="处理备注"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          我已确认关联交易及负债 / 付款语义
        </label>
        <button disabled={!row || !confirmed}>将处理加入草稿</button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setSource("");
            setConfirmed(false);
            setAmount("");
          }}
        >
          取消关联
        </button>
        <button type="button" className="ghost" onClick={() => void refresh()}>
          刷新订单
        </button>
      </form>
    </details>
  );
}
