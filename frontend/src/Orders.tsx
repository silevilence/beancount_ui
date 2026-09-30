import { useEffect, useState } from "react";
import { api, type Journal } from "./api";
import { Chip, Empty, Notice, Segmented, Toolbar } from "./ui";
import { money, ORDER_KIND } from "./format";
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

const KIND_ORDER = ["settle", "refund_paid", "refund_unpaid"];

const KIND_OPTIONS = KIND_ORDER.map((kind) => ({
  value: kind,
  label: ORDER_KIND[kind].label,
  hint: ORDER_KIND[kind].hint,
}));

/** 每种处理方式的一句话语义，帮助用户确认入账方向。 */
const KIND_NOTE: Record<string, string> = {
  settle: "结算只结转负债、不再生成消费。",
  refund_paid: "已付款退款冲回原费用。",
  refund_unpaid: "未结算冲回减少原待付款负债。",
};

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
  const funding = accounts.filter((a) => /^(Assets|Liabilities):/.test(a.name));

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

  /** 选中订单：金额回落到未结清金额，类别回落到第一条原费用。 */
  function pick(next: Order) {
    setSource(next.id);
    setAmount(next.mode === "paid" ? "" : next.unpaid);
    setCategory(Object.keys(next.categories)[0] ?? "");
    setConfirmed(false);
  }
  function unlink() {
    setSource("");
    setAmount("");
    setConfirmed(false);
  }
  function add() {
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
  }

  return (
    <section className="file-card">
      <div className="work-head">
        <h3>淘宝确认收货 / 退款</h3>
        <p>
          先从历史订单里认领这一笔，再确认收货、退款或冲回负债。金额与账户始终由你核对，历史匹配不会自动入账。
        </p>
      </div>
      {error && (
        <Notice
          tone="error"
          action={
            <button
              type="button"
              className="ghost small"
              onClick={() => void refresh()}
            >
              重试
            </button>
          }
        >
          {error}
        </Notice>
      )}
      {rows.length === 0 ? (
        <Empty>没有可处理的历史订单</Empty>
      ) : (
        <div className="order-list">
          {rows.map((r) => (
            <button
              key={r.id}
              type="button"
              className="order-row"
              aria-selected={r.id === source}
              onClick={() => pick(r)}
            >
              <span className="order-main">
                <span className="order-title">
                  {r.payee} · {r.narration}
                </span>
                <span className="order-sub">
                  {r.date} · {r.account}
                </span>
              </span>
              <span className="order-side">
                <span>{money(r.total, r.currency)}</span>
                {r.mode === "paid" ? (
                  <Chip tone="transfer">直接付款</Chip>
                ) : r.mode === "deferred" ? (
                  <Chip tone="warn">
                    挂账未结清 {money(r.unpaid, r.currency)}
                  </Chip>
                ) : (
                  <Chip tone="muted">
                    历史记录 · 可结算 {money(r.unpaid, r.currency)}
                  </Chip>
                )}
                {/* 已退款非零（按十进制字符串判断，不做浮点换算） */}
                {/[1-9]/.test(r.refunded) && (
                  <Chip tone="expense">
                    已退款 {money(r.refunded, r.currency)}
                  </Chip>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        {row ? (
          <>
            <div className="work-head">
              <h3>处理原订单</h3>
              <p>历史匹配仅为建议，请确认真实语义；取消关联不会入账</p>
            </div>
            <p className="muted small">
              {KIND_NOTE[kind] ?? ""}
              赔偿等特殊收入请用高级分录。
            </p>
            <div className="form-grid">
              <div className="field">
                <span>处理方式</span>
                <Segmented
                  label="处理方式"
                  value={kind}
                  options={KIND_OPTIONS}
                  onChange={(value) => {
                    setKind(value);
                    setConfirmed(false);
                  }}
                />
              </div>
              <label className="field">
                <span>本次处理金额</span>
                <input
                  aria-label="本次处理金额"
                  value={amount}
                  required
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setConfirmed(false);
                  }}
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
                    {funding.map((a) => (
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
                    required
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                  >
                    {Object.entries(row.categories).map(([name, value]) => (
                      <option key={name} value={name}>
                        {name} · 可冲回 {money(value, row.currency)}
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
          </>
        ) : (
          <Empty>先在上方选择一个历史订单，再确认处理方式</Empty>
        )}
        <Toolbar>
          <button className="cta" disabled={!row || !confirmed}>
            将处理加入草稿
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!row}
            onClick={unlink}
          >
            取消关联
          </button>
          <button type="button" className="ghost" onClick={() => void refresh()}>
            刷新订单
          </button>
        </Toolbar>
      </form>
    </section>
  );
}
