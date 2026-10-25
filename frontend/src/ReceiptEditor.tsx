import { useEffect, useRef, useState } from "react";
import type { Journal } from "./api";
import { api, reasonOf } from "./api";
import { post } from "./api";
import type { ManagedOrder } from "./OrderPage";
import { requestId } from "./requestId";
import { shanghaiToday } from "./format";
import AccountSelect from "./AccountSelect";
import Diff from "./Diff";
import { Notice } from "./ui";
import { confirmEntryDates } from "./confirmEntryDates";
import type { StockOperation } from "./OperationStatus";
import OperationStatus from "./OperationStatus";
import {
  expiryDate,
  type ReceiptDraft,
  type ReceiptOptions,
} from "./receiptDraft";

export interface ReceiptPreview {
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
    location_name?: string;
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
  onStage,
  draft,
  locked = false,
}: {
  order: ManagedOrder;
  journal: Journal;
  onChanged: () => Promise<void>;
  onStage?: (draft: ReceiptDraft) => void;
  draft?: ReceiptDraft;
  locked?: boolean;
}) {
  const key = `beancount-ui.receipt.${journal.identity ?? "default"}.${order.id}`;
  const [pending, setPending] = useState<Pending | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  });
  const [date, setDate] = useState(
    draft?.body.received_date ?? shanghaiToday(),
  );
  const [options, setOptions] = useState<ReceiptOptions>();
  const [optionsError, setOptionsError] = useState("");
  const [optionsLoading, setOptionsLoading] = useState(false);
  const manualExpiry = useRef(
    new Set(
      draft?.manualExpiry ?? draft?.body.lines.map((l) => l.item_id) ?? [],
    ),
  );
  const manualLocation = useRef(
    new Set(
      draft?.manualLocation ?? draft?.body.lines.map((l) => l.item_id) ?? [],
    ),
  );
  const [lines, setLines] = useState(() =>
    order.items.map((i) => ({
      item_id: i.id,
      quantity: draft
        ? (draft.body.lines.find((l) => l.item_id === i.id)?.quantity ?? "0")
        : i.remaining,
      location_id: String(
        draft?.body.lines.find((l) => l.item_id === i.id)?.location_id ??
          i.default_location_id ??
          "",
      ),
      best_before_date:
        draft?.body.lines.find((l) => l.item_id === i.id)?.best_before_date ??
        expiryDate(date, i.default_best_before_days),
      unit_price:
        draft?.body.lines.find((l) => l.item_id === i.id)?.unit_price ??
        i.unit_price ??
        "",
    })),
  );
  const settle =
    order.source.mode === "deferred" && Number(order.source.unpaid) > 0;
  const [settleDate, setSettleDate] = useState(
    draft?.body.settlement?.date ?? shanghaiToday(),
  );
  const [amount, setAmount] = useState(
    draft?.body.settlement?.amount ?? order.source.unpaid,
  );
  const [account, setAccount] = useState(draft?.body.settlement?.account ?? "");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ReceiptPreview>();
  const remainingKey = order.items
    .map((i) => `${i.id}:${i.remaining}`)
    .join("|");
  const previousRemaining = useRef(remainingKey);
  useEffect(() => {
    if (previousRemaining.current === remainingKey) return;
    previousRemaining.current = remainingKey;
    setLines((previous) =>
      previous.map((line) => ({
        ...line,
        quantity:
          order.items.find((i) => i.id === line.item_id)?.remaining ?? "0",
      })),
    );
  }, [remainingKey]);
  const linked = order.items.some((i) => i.product_id);
  async function loadOptions() {
    setOptionsLoading(true);
    setOptionsError("");
    try {
      const result = await api<ReceiptOptions>("/fulfillment/receipt/options");
      if (!Array.isArray(result.locations) || !Array.isArray(result.products))
        throw new Error("入库资料不可用");
      if (
        order.items.some(
          (i) => i.product_id && i.instance_id !== result.instance_id,
        )
      )
        throw new Error("Grocy 实例已变化，请核对商品关联");
      setOptions(result);
    } catch (e) {
      setOptionsError(reasonOf(e));
    } finally {
      setOptionsLoading(false);
    }
  }
  useEffect(() => {
    if (linked) void loadOptions();
  }, [order.id]);
  useEffect(() => {
    setLines((previous) =>
      previous.map((line) => {
        const item = order.items.find((i) => i.id === line.item_id)!;
        const product = options?.products.find(
          (p) => String(p.id) === String(item.product_id),
        );
        return {
          ...line,
          location_id: manualLocation.current.has(item.id)
            ? line.location_id
            : String(
                product?.location_id ||
                  item.default_location_id ||
                  options?.default_location_id ||
                  "",
              ),
          best_before_date: manualExpiry.current.has(item.id)
            ? line.best_before_date
            : expiryDate(
                date,
                product?.default_best_before_days ??
                  item.default_best_before_days ??
                  options?.default_best_before_days,
              ),
        };
      }),
    );
  }, [date, options]);
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
      <h3>确认收货并入库</h3>
      {error && <Notice tone="error">{error}</Notice>}
      {optionsError && (
        <Notice tone="error">
          {optionsError}{" "}
          <button disabled={optionsLoading} onClick={() => void loadOptions()}>
            重新读取入库资料
          </button>
        </Notice>
      )}
      {result && (
        <Notice>
          {result.receipt_saved ? "实物收货已保存。" : "收货尚未保存。"}{" "}
          {result.settlement_status === "done"
            ? "账单已保存。"
            : result.settlement_status === "none"
              ? "本次没有新增账务。"
              : result.settlement_status === "abandoned"
                ? "原账单请求已结束，可在下方重新填写并确认收货。"
                : `账单未保存，已暂停入库：${result.settlement_error}`}
        </Notice>
      )}
      {result && (
        <OperationStatus
          operations={result.operations}
          onChanged={async (operation) => {
            setResult(
              (previous) =>
                previous && {
                  ...previous,
                  operations: previous.operations.map((o) =>
                    o.id === operation.id ? operation : o,
                  ),
                },
            );
            await onChanged();
          }}
        />
      )}
      {!pending && order.items.some((i) => Number(i.remaining) > 0) && (
        <>
          {order.source_changed && (
            <Notice tone="warn">
              原购买记录已变化，收货操作已暂停；请先核对账本，再决定是否继续收货。
            </Notice>
          )}
          <fieldset
            disabled={busy || locked || order.source_changed}
            className="grocy-form"
          >
            <p className="muted small">
              {settle
                ? "先用后付：本次确认将先记录账单，再将收到的商品入库。请核对账单金额和账户。"
                : "已付款：本次确认直接将收到的商品入库，不重复记账。"}
            </p>
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
              0。到期日期按到货日期和产品默认保质期计算，可手动修改。
            </p>
            {lines.map((line, index) => {
              const item = order.items.find((i) => i.id === line.item_id)!;
              function change(field: string, value: string) {
                if (field === "best_before_date")
                  manualExpiry.current.add(item.id);
                if (field === "location_id")
                  manualLocation.current.add(item.id);
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
                        入库位置
                        <select
                          value={line.location_id}
                          onChange={(e) =>
                            change("location_id", e.target.value)
                          }
                        >
                          <option value="">
                            {optionsLoading
                              ? "正在读取位置…"
                              : "请选择入库位置"}
                          </option>
                          {line.location_id &&
                            !options?.locations.some(
                              (l) => String(l.id) === line.location_id,
                            ) && (
                              <option value={line.location_id}>
                                原位置不可用，请重新选择
                              </option>
                            )}
                          {options?.locations.map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.name}
                            </option>
                          ))}
                        </select>
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
            {settle && (
              <>
                <h4>本次收货账单</h4>
                <label>
                  账单日期
                  <input
                    type="date"
                    value={settleDate}
                    onChange={(e) => setSettleDate(e.target.value)}
                  />
                </label>
                <label>
                  账单金额
                  <input
                    value={amount}
                    inputMode="decimal"
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </label>
                <AccountSelect
                  label="账单账户"
                  value={account}
                  options={journal.accounts
                    .filter(
                      (a) =>
                        /^(Assets|Liabilities):/.test(a.name) &&
                        a.name !== order.source.account,
                    )
                    .map((a) => ({ value: a.name }))}
                  onChange={setAccount}
                />
              </>
            )}
            <button
              disabled={
                linked && (!options || optionsLoading || !!optionsError)
              }
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
                        location_id: l.location_id
                          ? Number(l.location_id)
                          : null,
                        best_before_date: l.best_before_date || null,
                        unit_price: l.unit_price || null,
                      })),
                    settlement: settle
                      ? { date: settleDate, amount, account }
                      : null,
                  };
                  if (onStage) {
                    if (!body.lines.length)
                      throw new Error("请填写本次收货数量");
                    if (settle && (!account || !amount))
                      throw new Error("请填写账单金额与账户");
                    onStage({
                      order,
                      body,
                      manualExpiry: [...manualExpiry.current],
                      manualLocation: [...manualLocation.current],
                    });
                    setError("");
                    return;
                  }
                  persist({ body });
                  const p = await post<ReceiptPreview>(
                    "/fulfillment/receipt/preview",
                    body,
                  );
                  persist({ body, preview: p });
                })
              }
            >
              {onStage
                ? draft
                  ? "更新收货草稿"
                  : "加入批量收货"
                : "预览收货与入库"}
            </button>
          </fieldset>
        </>
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
                    ? `→ Grocy #${a.product_id} 入库 ${a.stock_amount}，单价 ${a.unit_price} ${a.currency}，位置 ${a.location_name ?? options?.locations.find((l) => String(l.id) === String(a.location_id))?.name ?? "需重新核对位置"}，保质期 ${a.best_before_date}`
                    : "· 仅记录收货"}
                </p>
              ))}
              {preview.financial && (
                <p>确认后先保存以下账单，再执行上述入库。</p>
              )}
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
                        "核对并结束尚未写入的账单请求，返回本页重新填写？已保存的账单不会撤销；如账单已保存但尚未入库，需继续恢复原收货请求。",
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
                核对并重新填写账单
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
                  : preview.financial
                    ? "确认收货：记账并入库"
                    : "确认收货并入库"}
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
