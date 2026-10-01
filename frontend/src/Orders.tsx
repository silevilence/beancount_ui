import AccountSelect from "./AccountSelect";
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
  note?: string;
  file?: string;
  line?: number;
  raw?: string;
  key?: string;
  tags?: string[];
  identified?: boolean;
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
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("orders");
  const [state, setState] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [filterAccount, setFilterAccount] = useState("");
  const [limit, setLimit] = useState(20);
  const row = rows.find((r) => r.id === source);
  const funding = accounts.filter((a) => /^(Assets|Liabilities):/.test(a.name));

  async function refresh() {
    setLoading(true);
    unlink();
    try {
      setRows(await api<Order[]>("/orders"));
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
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
  function filter(change: () => void) {
    change();
    setLimit(20);
    unlink();
  }
  const filtered = rows
    .filter((r) => {
      const text = [
        r.payee,
        r.narration,
        r.note,
        r.raw,
        r.key,
        r.account,
        r.total,
        r.currency,
        ...(r.tags ?? []),
        ...Object.keys(r.categories),
      ]
        .join(" ")
        .toLocaleLowerCase();
      const candidate =
        r.identified ||
        r.mode !== "historical" ||
        /淘宝|taobao|天猫|tmall/.test(text);
      return (
        (scope === "all" || candidate) &&
        query
          .trim()
          .toLocaleLowerCase()
          .split(/\s+/)
          .every((term) => text.includes(term)) &&
        (!from || r.date >= from) &&
        (!to || r.date <= to) &&
        (!filterAccount || r.account === filterAccount) &&
        (state === "all" ||
          (state === "unpaid" && r.mode !== "paid" && Number(r.unpaid) > 0) ||
          (state === "paid" && r.mode === "paid") ||
          (state === "refunded" && Number(r.refunded) > 0) ||
          (state === "historical" && r.mode === "historical"))
      );
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
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
      <div className="form-grid order-filters" aria-label="订单筛选">
        <label className="field">
          <span>搜索订单</span>
          <input
            aria-label="搜索订单"
            placeholder="商户、商品、备注、订单号或金额"
            value={query}
            onChange={(e) => filter(() => setQuery(e.target.value))}
          />
        </label>
        <label className="field">
          <span>记录范围</span>
          <select
            aria-label="记录范围"
            value={scope}
            onChange={(e) => filter(() => setScope(e.target.value))}
          >
            <option value="orders">订单及淘宝候选</option>
            <option value="all">全部历史消费（手动认领）</option>
          </select>
        </label>
        <label className="field">
          <span>订单状态</span>
          <select
            aria-label="订单状态"
            value={state}
            onChange={(e) => filter(() => setState(e.target.value))}
          >
            <option value="all">全部状态</option>
            <option value="unpaid">可结算 / 待核对</option>
            <option value="paid">直接付款</option>
            <option value="refunded">有退款</option>
            <option value="historical">历史记录（未认领）</option>
          </select>
        </label>
        <label className="field">
          <span>原付款账户</span>
          <AccountSelect
            label="原付款账户"
            value={filterAccount}
            onChange={(value) => filter(() => setFilterAccount(value))}
            options={[...new Set(rows.map((r) => r.account))]
              .sort()
              .map((value) => ({ value }))}
          />
        </label>
        <label className="field">
          <span>订单开始日期</span>
          <input
            type="date"
            aria-label="订单开始日期"
            value={from}
            onChange={(e) => filter(() => setFrom(e.target.value))}
          />
        </label>
        <label className="field">
          <span>订单结束日期</span>
          <input
            type="date"
            aria-label="订单结束日期"
            value={to}
            onChange={(e) => filter(() => setTo(e.target.value))}
          />
        </label>
      </div>
      <Toolbar>
        <button
          type="button"
          className="ghost"
          onClick={() =>
            filter(() => {
              setQuery("");
              setScope("orders");
              setState("all");
              setFrom("");
              setTo("");
              setFilterAccount("");
            })
          }
        >
          重置筛选
        </button>
        <span className="muted small">
          匹配 {filtered.length} 条 · 当前显示{" "}
          {Math.min(limit, filtered.length)} 条
        </span>
      </Toolbar>
      <p className="muted small">
        默认只显示已标记订单及名称、备注或账户中含淘宝 /
        天猫的候选。找不到时可切换「全部历史消费」；历史候选的付款状态需自行核对。
      </p>
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
      {loading ? (
        <Empty>正在读取订单…</Empty>
      ) : rows.length === 0 ? (
        <Empty>没有可处理的历史订单</Empty>
      ) : filtered.length === 0 ? (
        <Empty>没有匹配筛选条件的订单，可调整筛选或切换记录范围。</Empty>
      ) : (
        <div className="order-list">
          {filtered.slice(0, limit).map((r) => (
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
                {r.note && <span className="order-note">备注：{r.note}</span>}
                {r.file && (
                  <span className="order-sub">
                    {r.file}:{r.line}
                  </span>
                )}
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
      {filtered.length > limit && (
        <button
          type="button"
          className="ghost"
          onClick={() => setLimit(limit + 20)}
        >
          再显示 20 条
        </button>
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
            <div className="order-detail">
              <p>
                当前选择：{row.date} · {row.payee || "未填写商户"} ·{" "}
                {row.narration} · {money(row.total, row.currency)}
              </p>
              <p>
                原备注：
                {row.note || "无独立备注，请核对原文中的商品明细与注释。"}
              </p>
              {row.file && (
                <p className="muted small">
                  来源：{row.file}:{row.line}
                </p>
              )}
              {row.raw && (
                <details>
                  <summary>查看原始交易和明细</summary>
                  <pre>{row.raw}</pre>
                </details>
              )}
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
                  <AccountSelect
                    label="实际付款 / 收款账户"
                    required
                    value={account}
                    onChange={(value) => {
                      setAccount(value);
                      setConfirmed(false);
                    }}
                    options={funding.map((a) => ({ value: a.name }))}
                  />
                </label>
              )}
              {kind !== "settle" && (
                <label className="field">
                  <span>原费用类别</span>
                  <AccountSelect
                    label="原费用类别"
                    required
                    value={category}
                    onChange={(value) => {
                      setCategory(value);
                      setConfirmed(false);
                    }}
                    options={Object.entries(row.categories).map(
                      ([name, value]) => ({
                        value: name,
                        label: `${name} · 可冲回 ${money(value, row.currency)}`,
                      }),
                    )}
                  />
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
            disabled={!row || loading}
            onClick={unlink}
          >
            取消关联
          </button>
          <button
            type="button"
            className="ghost"
            disabled={loading}
            onClick={() => void refresh()}
          >
            刷新订单
          </button>
        </Toolbar>
      </form>
    </section>
  );
}
