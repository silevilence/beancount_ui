import { useEffect, useMemo, useRef, useState } from "react";
import { api, reasonOf, type Journal } from "./api";
import Orders, { type Order } from "./Orders";
import OperationStatus, {
  needsSyncReview,
  orderSyncLabel,
} from "./OperationStatus";
import ReceiptEditor from "./ReceiptEditor";
import OrderCorrections from "./OrderCorrections";
import type { DraftItem } from "./BatchEditor";
import PurchaseItems, { blankItem, type PurchaseItem } from "./PurchaseItems";
import { post } from "./api";
import { requestId } from "./requestId";
import { shanghaiToday } from "./format";
import { confirmEntryDates } from "./confirmEntryDates";
import Diff from "./Diff";
import { Chip, Empty, Notice, Segmented } from "./ui";

export interface Receipt {
  request_id: string;
  received_date: string;
  lines: { item_id: string; quantity: string }[];
  voided?: boolean;
  item_snapshots?: Record<string, { name: string; unit: string }>;
}
export interface ManagedOrder {
  corrections?: { action: string; reason: string }[];
  id: string;
  source: Order;
  items: (PurchaseItem & {
    received: string;
    remaining: string;
    cancelled: string;
  })[];
  receipts: Receipt[];
  receipt_state: string;
  payment_state: string;
  source_changed: boolean;
  operations?: { id: string; status: string; error: string }[];
}
interface Preview {
  request_id: string;
  status: string;
  items: { raw: string }[];
  diffs: Record<string, string>;
}
interface Pending {
  path: string;
  body: Record<string, unknown>;
  preview?: Preview;
  uncertain?: boolean;
}
export const receiptLabel: Record<string, string> = {
  pending: "待收货",
  partial: "部分收货",
  received: "已收货",
  cancelled: "已取消",
};
const paymentLabel: Record<string, string> = {
  paid: "已付款",
  partial: "部分结算",
  unpaid: "待结算",
};
export default function OrderPage({
  journal,
  onChanged,
  initialOrder,
}: {
  journal: Journal;
  onChanged: () => Promise<void>;
  initialOrder?: string;
}) {
  const key = `beancount-ui.orders.pending.${journal.identity ?? "default"}`;
  const [pending, setPending] = useState<Pending>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  });
  const [rows, setRows] = useState<ManagedOrder[]>([]);
  const [candidates, setCandidates] = useState<Order[]>([]);
  const [selected, setSelected] = useState(initialOrder || "");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState(initialOrder ? "all" : "pending");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [tab, setTab] = useState("receipts");
  const [date, setDate] = useState(shanghaiToday);
  const [claim, setClaim] = useState("");
  const [claimQuery, setClaimQuery] = useState("");
  const [claimFrom, setClaimFrom] = useState("");
  const [claimTo, setClaimTo] = useState("");
  const [claimPage, setClaimPage] = useState(0);
  const [mode, setMode] = useState("paid");
  const [items, setItems] = useState<PurchaseItem[]>([blankItem()]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const pendingRef = useRef<HTMLElement>(null);
  const detail = rows.find((r) => r.id === selected);
  const candidate = candidates.find((c) => c.id === claim);
  const claimCandidates = useMemo(() => {
    const managed = new Set(rows.map((r) => r.id));
    return candidates
      .filter((c) => !managed.has(c.key ?? c.id))
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [candidates, rows]);
  const matchingCandidates = useMemo(() => {
    const query = claimQuery.trim().toLocaleLowerCase();
    return claimCandidates.filter(
      (c) =>
        (!claimFrom || c.date >= claimFrom) &&
        (!claimTo || c.date <= claimTo) &&
        `${c.date} ${c.payee} ${c.narration} ${c.total} ${c.currency}`
          .toLocaleLowerCase()
          .includes(query),
    );
  }, [claimCandidates, claimQuery, claimFrom, claimTo]);
  const claimPageSize = 50;
  const claimPageCount = Math.max(
    1,
    Math.ceil(matchingCandidates.length / claimPageSize),
  );
  const currentClaimPage = Math.min(claimPage, claimPageCount - 1);
  const pagedCandidates = matchingCandidates.slice(
    currentClaimPage * claimPageSize,
    (currentClaimPage + 1) * claimPageSize,
  );
  const visibleOrders = rows.filter(
    (r) =>
      (!from || r.source.date >= from) &&
      (!to || r.source.date <= to) &&
      `${r.source.payee} ${r.source.narration} ${r.id}`.includes(query) &&
      (filter === "all" ||
        (filter === "pending"
          ? ["pending", "partial"].includes(r.receipt_state)
          : filter === "sync"
            ? r.operations?.some((o) => needsSyncReview(o.status))
            : r.receipt_state === filter)),
  );
  function persist(p: Pending | null) {
    if (p) localStorage.setItem(key, JSON.stringify(p));
    else localStorage.removeItem(key);
    setPending(p as Pending);
  }
  async function refresh() {
    try {
      const [r, c] = await Promise.all([
        api<ManagedOrder[]>("/fulfillment/orders"),
        api<Order[]>("/orders"),
      ]);
      setRows(r);
      setCandidates(c);
      setError("");
    } catch (e) {
      setError(reasonOf(e));
    }
  }
  useEffect(() => {
    void refresh();
  }, [journal.revision]);
  async function work(fn: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      setBusy(false);
      running.current = false;
    }
  }
  async function preview(path: string, body: Record<string, unknown>) {
    await work(async () => {
      const p = pending || {
        path,
        body: {
          ...body,
          request_id: requestId(),
          revision: (await api<{ revision: string }>("/ledger")).revision,
        },
      };
      persist(p);
      const result = await post<Preview>(p.path, p.body);
      persist({ ...p, preview: result });
    });
  }
  function financial(item: DraftItem) {
    void preview("/preview", { ...item, operation: "create" });
    return false;
  }
  // 预览面板固定在页首，而触发按钮在下方表单里；预览完成后滚回面板给出反馈。
  useEffect(() => {
    if (pending?.preview && pendingRef.current)
      pendingRef.current.scrollIntoView?.({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "start",
      });
  }, [pending?.preview]);
  return (
    <section className="settings-page orders-page">
      <header className="page-heading">
        <p className="eyebrow">ORDERS / 购买与到货</p>
        <h1>订单与收货</h1>
        <p className="muted">
          付款、实物到货和库存同步分别记录。结算或退款不会自动改变库存。
        </p>
        <div className="toolbar">
          <Segmented
            label="订单页区块"
            value={tab}
            options={[
              { value: "receipts", label: "收货进度" },
              { value: "finance", label: "结算与退款" },
              { value: "claim", label: "认领历史购买" },
            ]}
            onChange={setTab}
          />
          <button
            className="ghost"
            disabled={busy}
            onClick={() => void refresh()}
          >
            刷新订单
          </button>
        </div>
      </header>
      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      {pending && (
        <section className="panel card" ref={pendingRef}>
          <h2>确认账务处理</h2>
          {pending.preview ? (
            <>
              {Object.entries(pending.preview.diffs).map(([file, diff]) => (
                <div key={file}>
                  <h3>{file}</h3>
                  <Diff diff={diff} />
                </div>
              ))}
            </>
          ) : (
            <p>预览请求已保留，可恢复原请求。</p>
          )}
          {pending.uncertain && (
            <Notice tone="warn">
              保存结果待确认，请恢复原请求；不要重复新增。
            </Notice>
          )}
          <div className="toolbar">
            {pending.uncertain && pending.preview && (
              <button
                disabled={busy}
                className="ghost"
                onClick={() =>
                  void work(async () => {
                    if (
                      !window.confirm(
                        "先由后端核对原写入：已保存的保持不变，尚未写入的预览将取消。结束后可重新预览账务。",
                      )
                    )
                      return;
                    const closed = await post<{ status: string }>(
                      "/preview/cancel",
                      { request_id: pending.preview!.request_id },
                    );
                    persist(null);
                    setMessage(
                      closed.status === "done"
                        ? "原账务已经保存"
                        : "原预览已取消，可重新处理账务",
                    );
                    await onChanged();
                    await refresh();
                  })
                }
              >
                核对并结束原账务请求
              </button>
            )}
            <button
              disabled={busy}
              className="ghost"
              onClick={() => void preview(pending.path, pending.body)}
            >
              恢复 / 重新读取预览
            </button>
            {pending.preview && (
              <button
                disabled={busy}
                onClick={() =>
                  void work(async () => {
                    if (
                      !pending.uncertain &&
                      !confirmEntryDates(pending.preview!.items)
                    )
                      return;
                    persist({ ...pending, uncertain: true });
                    await post("/commit", {
                      request_id: pending.preview!.request_id,
                    });
                    persist(null);
                    setMessage("账务处理已保存");
                    await onChanged();
                    await refresh();
                  })
                }
              >
                确认保存账务
              </button>
            )}
            {!pending.uncertain && (
              <button
                disabled={busy}
                className="ghost"
                onClick={() => persist(null)}
              >
                取消预览
              </button>
            )}
          </div>
        </section>
      )}
      <fieldset disabled={busy || !!pending} className="order-work">
        {tab === "finance" && (
          <Orders
            key={journal.revision}
            date={date}
            onDateChange={setDate}
            accounts={journal.accounts}
            onAdd={financial}
            actionLabel="预览账务处理"
          />
        )}
        {tab === "claim" && (
          <section className="panel card">
            <h2>明确认领后管理收货</h2>
            <p className="muted">
              仅选择确需跟踪实物的购买。认领不会再次记消费，也不会将历史结算认作已收货。
            </p>
            <div className="form-grid">
              <label className="field">
                搜索历史购买
                <input
                  value={claimQuery}
                  placeholder="商户、摘要、金额"
                  onChange={(e) => {
                    setClaimQuery(e.target.value);
                    setClaimPage(0);
                  }}
                />
              </label>
              <label className="field">
                历史购买起始日期
                <input
                  type="date"
                  value={claimFrom}
                  onChange={(e) => {
                    setClaimFrom(e.target.value);
                    setClaimPage(0);
                  }}
                />
              </label>
              <label className="field">
                历史购买结束日期
                <input
                  type="date"
                  value={claimTo}
                  onChange={(e) => {
                    setClaimTo(e.target.value);
                    setClaimPage(0);
                  }}
                />
              </label>
            </div>
            <p className="muted small">
              匹配 {matchingCandidates.length} / {claimCandidates.length} 笔 ·
              按日期从新到旧 · 每页 {claimPageSize} 笔
            </p>
            <label className="field">
              历史购买
              <select
                value={claim}
                onChange={(e) => {
                  setClaim(e.target.value);
                  const c = candidates.find((c) => c.id === e.target.value);
                  setMode(c?.mode === "deferred" ? "deferred" : "paid");
                  setItems([{ ...blankItem(), name: c?.narration || "商品" }]);
                }}
              >
                <option value="">请选择</option>
                {candidate && !pagedCandidates.some((c) => c.id === claim) && (
                  <option value={candidate.id}>
                    当前选择：{candidate.date} · {candidate.payee} ·{" "}
                    {candidate.narration} · {candidate.total}{" "}
                    {candidate.currency}
                  </option>
                )}
                {pagedCandidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.date} · {c.payee} · {c.narration} · {c.total}{" "}
                    {c.currency}
                  </option>
                ))}
              </select>
            </label>
            <div className="toolbar">
              <button
                className="ghost"
                aria-label="上一页历史购买"
                disabled={currentClaimPage === 0}
                onClick={() => setClaimPage(currentClaimPage - 1)}
              >
                上一页
              </button>
              <span className="muted small">
                第 {currentClaimPage + 1} / {claimPageCount} 页
              </span>
              <button
                className="ghost"
                aria-label="下一页历史购买"
                disabled={currentClaimPage + 1 >= claimPageCount}
                onClick={() => setClaimPage(currentClaimPage + 1)}
              >
                下一页
              </button>
            </div>
            {matchingCandidates.length === 0 && (
              <p className="muted">没有匹配的历史购买，请调整搜索或日期。</p>
            )}
            {candidate && (
              <>
                <pre className="changes">{candidate.raw}</pre>
                <label className="field">
                  原购买付款方式
                  <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value)}
                  >
                    <option value="paid">已直接付款</option>
                    <option value="deferred">先用后付</option>
                  </select>
                </label>
                <PurchaseItems
                  items={items}
                  autoCalculate={!pending}
                  onChange={setItems}
                  amount={candidate.total}
                  currency={candidate.currency}
                />
                <button
                  disabled={!items.length}
                  onClick={() =>
                    void preview("/fulfillment/claim/preview", {
                      source_id: claim,
                      mode,
                      items,
                    })
                  }
                >
                  预览认领
                </button>
              </>
            )}
          </section>
        )}
        {tab === "receipts" && (
          <>
            <div className="order-filters">
              <label>
                搜索订单
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <label>
                收货状态
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <optgroup label="收货状态">
                    <option value="all">全部</option>
                    {Object.entries(receiptLabel).map(([v, l]) => (
                      <option value={v} key={v}>
                        {l}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="库存同步">
                    <option value="sync">同步异常</option>
                  </optgroup>
                </select>
              </label>
              <label>
                购买起始日期
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label>
                购买结束日期
                <input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
            </div>
            <div className="toolbar">
              <button
                className="ghost small"
                onClick={() => {
                  setQuery("");
                  setFilter(initialOrder ? "all" : "pending");
                  setFrom("");
                  setTo("");
                }}
              >
                重置筛选
              </button>
              <span className="muted small">
                匹配 {visibleOrders.length} / {rows.length} 个订单
              </span>
            </div>
            <div className="inventory-grid">
              <section className="panel card">
                <h2>订单列表</h2>
                {!rows.length ? (
                  <Empty>
                    尚无收货订单。新建购物订单，或在「认领历史购买」中明确认领。
                  </Empty>
                ) : !visibleOrders.length ? (
                  <p className="muted">没有匹配筛选条件的订单，可重置筛选。</p>
                ) : (
                  visibleOrders.map((r) => (
                    <article className="inventory-row" key={r.id}>
                      <button
                        className="ghost"
                        aria-pressed={selected === r.id}
                        onClick={() => setSelected(r.id)}
                      >
                        {r.source.payee || "购买"} · {r.source.narration}
                      </button>
                      <small>
                        {r.source.date} · {r.source.total} {r.source.currency}
                      </small>
                      <div className="inventory-alerts">
                        <Chip>{receiptLabel[r.receipt_state]}</Chip>
                        <Chip>{orderSyncLabel(r.operations)}</Chip>
                        <Chip>{paymentLabel[r.payment_state]}</Chip>
                      </div>
                      {r.source_changed && (
                        <Notice tone="warn">
                          原购买发生变化，请核对账本。
                        </Notice>
                      )}
                    </article>
                  ))
                )}
              </section>
              <section className="panel card">
                <h2>订单详情</h2>
                {!detail ? (
                  <p className="muted">选择订单查看商品、实收数量和历史。</p>
                ) : (
                  <>
                    <details>
                      <summary>查看原始购买记录</summary>
                      <pre className="changes">{detail.source.raw}</pre>
                    </details>
                    {detail.items.map((i) => (
                      <article className="inventory-row" key={i.id}>
                        <strong>{i.name}</strong>
                        <span>
                          购买 {i.quantity} {i.unit} · 已收 {i.received} · 待收{" "}
                          {i.remaining} · 取消 {i.cancelled}
                        </span>
                        <small>
                          {i.product_id
                            ? `Grocy #${i.product_id} · 每${i.stock_unit} ${i.unit_price} ${i.currency}`
                            : "未关联 Grocy"}
                        </small>
                      </article>
                    ))}
                    <h3>收货历史</h3>
                    <OrderCorrections
                      key={detail.id}
                      order={detail}
                      onChanged={refresh}
                    />
                    <ReceiptEditor
                      key={detail.id}
                      order={detail}
                      journal={journal}
                      onChanged={async () => {
                        await refresh();
                        await onChanged();
                      }}
                    />
                    <OperationStatus
                      operations={detail.operations || []}
                      onChanged={refresh}
                    />
                    {detail.receipts.length ? (
                      detail.receipts.map((r) => (
                        <p key={r.request_id}>
                          {r.received_date} · {r.voided && "已作废 · "}
                          {r.lines
                            .map(
                              (l) =>
                                `${r.item_snapshots?.[l.item_id]?.name ?? detail.items.find((i) => i.id === l.item_id)?.name} ${l.quantity}`,
                            )
                            .join("、")}
                        </p>
                      ))
                    ) : (
                      <p className="muted">尚未记录实物收货。</p>
                    )}
                    <h3>付款与退款记录</h3>
                    {detail.source.events?.map((e) => (
                      <pre className="changes" key={e.id}>
                        {e.raw}
                      </pre>
                    ))}
                  </>
                )}
              </section>
            </div>
          </>
        )}
      </fieldset>
    </section>
  );
}
