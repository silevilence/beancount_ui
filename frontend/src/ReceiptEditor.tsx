import { useEffect, useRef, useState } from "react";
import type { Journal } from "./api";
import { reasonOf } from "./api";
import { post } from "./GrocySettings";
import type { ManagedOrder } from "./OrderPage";
import { requestId } from "./requestId";
import { shanghaiToday } from "./format";
import AccountSelect from "./AccountSelect";
import Diff from "./Diff";
import { Notice } from "./ui";
import { confirmEntryDates } from "./confirmEntryDates";
import type { StockOperation } from "./OperationStatus";
import OperationStatus from "./OperationStatus";

interface ReceiptPreview {
  request_id: string;
  received_date: string;
  receipt_saved: boolean;
  settlement_status: string;
  settlement_error?: string;
  actions: {
    name: string;
    quantity: string;
    unit: string;
    stock_amount: string;
    product_id: number | null;
    unit_price: string;
    currency: string;
    location_id: number;
    best_before_date: string;
  }[];
  financial: { items: { raw: string }[]; diffs: Record<string, string> } | null;
  operations: StockOperation[];
}
interface Pending {
  body: Record<string, unknown>;
  preview?: ReceiptPreview;
  uncertain?: boolean;
}
export default function ReceiptEditor({
  order,
  journal,
  onChanged,
}: {
  order: ManagedOrder;
  journal: Journal;
  onChanged: () => Promise<void>;
}) {
  const key = `beancount-ui.receipt.${journal.identity ?? "default"}.${order.id}`;
  const [pending, setPending] = useState<Pending | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  });
  const [date, setDate] = useState(shanghaiToday);
  const [lines, setLines] = useState(() =>
    order.items.map((i) => ({
      item_id: i.id,
      quantity: i.remaining,
      location_id: String(i.default_location_id ?? ""),
      best_before_date: "",
      unit_price: i.unit_price ?? "",
    })),
  );
  const [settle, setSettle] = useState(false);
  const [settleDate, setSettleDate] = useState(shanghaiToday);
  const [amount, setAmount] = useState(order.source.unpaid);
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ReceiptPreview>();
  const remainingKey = order.items
    .map((i) => `${i.id}:${i.remaining}`)
    .join("|");
  useEffect(() => {
    setLines((previous) =>
      previous.map((line) => ({
        ...line,
        quantity:
          order.items.find((i) => i.id === line.item_id)?.remaining ?? "0",
      })),
    );
  }, [remainingKey]);
  function persist(value: Pending | null) {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
    setPending(value);
  }
  async function work(fn: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const preview = pending?.preview;
  return (
    <section className="inventory-row">
      <h3>确认实物收货</h3>
      {error && <Notice tone="error">{error}</Notice>}
      {result && (
        <Notice>
          {result.receipt_saved ? "实物收货已保存。" : "收货尚未保存。"}{" "}
          {result.settlement_status === "done"
            ? "结算已保存。"
            : result.settlement_status === "none"
              ? "本次没有新增账务。"
              : result.settlement_status === "abandoned"
                ? "已停止原结算重试；请在结算与退款页重新核对付款。"
                : `结算需要核对：${result.settlement_error}`}
        </Notice>
      )}
      {result && (
        <OperationStatus operations={result.operations} onChanged={onChanged} />
      )}
      {!pending && order.items.some((i) => Number(i.remaining) > 0) && (
        <fieldset
          disabled={busy || order.source_changed}
          className="grocy-form"
        >
          <label>
            实际到货日期
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <p className="muted small">
            填写本次实际数量，未到货商品填
            0。位置和保质期留空时，预览会展示明确的默认值。
          </p>
          {lines.map((line, index) => {
            const item = order.items.find((i) => i.id === line.item_id)!;
            function change(field: string, value: string) {
              setLines(
                lines.map((l, i) =>
                  i === index ? { ...l, [field]: value } : l,
                ),
              );
            }
            return (
              <div className="grocy-form" key={line.item_id}>
                <label>
                  {item.name} · 本次实收（{item.unit}）
                  <input
                    inputMode="decimal"
                    value={line.quantity}
                    onChange={(e) => change("quantity", e.target.value)}
                  />
                </label>
                {item.product_id && (
                  <>
                    <small>
                      Grocy #{item.product_id} · 1 {item.unit} = {item.factor}{" "}
                      {item.stock_unit}
                    </small>
                    <label>
                      入库位置 ID
                      <input
                        type="number"
                        min="1"
                        value={line.location_id}
                        onChange={(e) => change("location_id", e.target.value)}
                      />
                    </label>
                    <label>
                      保质期日期
                      <input
                        type="date"
                        value={line.best_before_date}
                        onChange={(e) =>
                          change("best_before_date", e.target.value)
                        }
                      />
                    </label>
                    <label>
                      每{item.stock_unit}价格（{item.currency}）
                      <input
                        inputMode="decimal"
                        value={line.unit_price}
                        onChange={(e) => change("unit_price", e.target.value)}
                      />
                    </label>
                  </>
                )}
              </div>
            );
          })}
          {order.source.mode === "deferred" &&
            Number(order.source.unpaid) > 0 && (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={settle}
                    onChange={(e) => setSettle(e.target.checked)}
                  />
                  同时结算待付款金额
                </label>
                {settle && (
                  <>
                    <label>
                      结算日期
                      <input
                        type="date"
                        value={settleDate}
                        onChange={(e) => setSettleDate(e.target.value)}
                      />
                    </label>
                    <label>
                      结算金额
                      <input
                        value={amount}
                        inputMode="decimal"
                        onChange={(e) => setAmount(e.target.value)}
                      />
                    </label>
                    <AccountSelect
                      label="结算付款账户"
                      value={account}
                      options={journal.accounts
                        .filter((a) => /^(Assets|Liabilities):/.test(a.name))
                        .map((a) => ({ value: a.name }))}
                      onChange={setAccount}
                    />
                  </>
                )}
              </>
            )}
          <button
            onClick={() =>
              void work(async () => {
                const body = {
                  request_id: requestId(),
                  order_id: order.id,
                  received_date: date,
                  lines: lines
                    .filter((l) => l.quantity !== "0")
                    .map((l) => ({
                      ...l,
                      location_id: l.location_id ? Number(l.location_id) : null,
                      best_before_date: l.best_before_date || null,
                      unit_price: l.unit_price || null,
                    })),
                  settlement: settle
                    ? { date: settleDate, amount, account }
                    : null,
                };
                persist({ body });
                const p = await post<ReceiptPreview>(
                  "/fulfillment/receipt/preview",
                  body,
                );
                persist({ body, preview: p });
              })
            }
          >
            预览本次收货
          </button>
        </fieldset>
      )}
      {pending && (
        <>
          {preview && (
            <>
              <p>实物到货日期：{preview.received_date}</p>
              {preview.actions.map((a, i) => (
                <p key={i}>
                  {a.name} · 收货 {a.quantity} {a.unit}{" "}
                  {a.product_id
                    ? `→ Grocy #${a.product_id} 入库 ${a.stock_amount}，单价 ${a.unit_price} ${a.currency}，位置 #${a.location_id}，保质期 ${a.best_before_date}`
                    : "· 仅记录收货"}
                </p>
              ))}
              {preview.financial ? (
                Object.entries(preview.financial.diffs).map(([f, d]) => (
                  <div key={f}>
                    <h4>{f}</h4>
                    <Diff diff={d} />
                  </div>
                ))
              ) : (
                <p>本次不新增 Beancount 账务记录。</p>
              )}
            </>
          )}
          {pending.uncertain && (
            <Notice tone="warn">
              保留原请求恢复各步骤，不重复记录收货、结算或入库。
            </Notice>
          )}
          <div className="toolbar">
            {pending.uncertain && preview?.financial && (
              <button
                disabled={busy}
                className="ghost"
                onClick={() =>
                  void work(async () => {
                    if (
                      !window.confirm(
                        "保留已保存实收，停止重试尚未写入的原结算？后续付款请在结算与退款页重新核对。已经写入的账务不会撤销。",
                      )
                    )
                      return;
                    const closed = await post<ReceiptPreview>(
                      "/fulfillment/receipt/close-settlement",
                      { request_id: preview.request_id },
                    );
                    setResult(closed);
                    persist(null);
                    await onChanged();
                  })
                }
              >
                保留收货并结束原结算请求
              </button>
            )}
            <button
              disabled={busy}
              className="ghost"
              onClick={() =>
                void work(async () => {
                  const p = await post<ReceiptPreview>(
                    "/fulfillment/receipt/preview",
                    pending.body,
                  );
                  persist({ ...pending, preview: p });
                })
              }
            >
              恢复收货预览
            </button>
            {preview && (
              <button
                disabled={busy}
                onClick={() =>
                  void work(async () => {
                    if (
                      !pending.uncertain &&
                      preview.financial &&
                      !confirmEntryDates(preview.financial.items)
                    )
                      return;
                    persist({ ...pending, uncertain: true });
                    const saved = await post<ReceiptPreview>(
                      "/fulfillment/receipt/commit",
                      { request_id: preview.request_id },
                    );
                    setResult(saved);
                    if (
                      saved.receipt_saved &&
                      ["none", "done"].includes(saved.settlement_status)
                    )
                      persist(null);
                    await onChanged();
                  })
                }
              >
                {pending.uncertain
                  ? "恢复原收货请求"
                  : "确认收货并执行预览动作"}
              </button>
            )}
            {!pending.uncertain && (
              <button
                disabled={busy}
                className="ghost"
                onClick={() => persist(null)}
              >
                取消收货预览
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
