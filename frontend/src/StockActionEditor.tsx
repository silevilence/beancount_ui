import { useRef, useState } from "react";
import type { InventoryData, Product, StockEntry } from "./Inventory";
import { nameOf } from "./Inventory";
import { post } from "./GrocySettings";
import { requestId } from "./requestId";
import { reasonOf } from "./api";
import { shanghaiToday } from "./format";
import { Notice } from "./ui";
import OperationStatus, { type StockOperation } from "./OperationStatus";

export default function StockActionEditor({
  product,
  data,
  entries,
  onChanged,
}: {
  product: Product;
  data: InventoryData;
  entries: StockEntry[];
  onChanged: () => Promise<void>;
}) {
  const key = `beancount-ui.stock.pending.${data.instance_id}.${product.id}`;
  const [pending, setPending] = useState<{
    body: Record<string, unknown>;
    preview?: StockOperation;
    uncertain?: boolean;
  } | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  });
  const [action, setAction] = useState("consume");
  const [amount, setAmount] = useState("1");
  const [stockId, setStockId] = useState("");
  const [location, setLocation] = useState(String(product.location_id));
  const [target, setTarget] = useState("");
  const [price, setPrice] = useState("");
  const [date, setDate] = useState(shanghaiToday);
  const [expiry, setExpiry] = useState("");
  const [independent, setIndependent] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<StockOperation>();
  function persist(p: typeof pending) {
    if (p) localStorage.setItem(key, JSON.stringify(p));
    else localStorage.removeItem(key);
    setPending(p);
  }
  async function run(fn: () => Promise<void>) {
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
  async function preview() {
    await run(async () => {
      const body = pending?.body || {
        request_id: requestId(),
        instance_id: data.instance_id,
        product_id: Number(product.id),
        action,
        amount,
        stock_id: stockId,
        location_id: Number(location),
        target_location_id: target ? Number(target) : null,
        price: price || null,
        purchased_date: action === "add" ? date : null,
        best_before_date: expiry || null,
        currency: data.currency,
        independent_purchase: independent,
      };
      persist({ body });
      const p = await post<StockOperation>("/grocy/manual/preview", body);
      persist({ body, preview: p });
    });
  }
  return (
    <section className="inventory-row">
      <h3>日常库存操作</h3>
      <p className="muted small">
        使用库存单位；不会生成 Beancount
        账务。订单采购请在订单页确认收货。皮重产品暂不支持。
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {result && (
        <OperationStatus operations={[result]} onChanged={onChanged} />
      )}
      {!pending && (
        <fieldset className="grocy-form" disabled={busy}>
          <label>
            库存动作
            <select value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="consume">消耗</option>
              <option value="open">开封</option>
              <option value="transfer">转移</option>
              <option value="add">手动入库</option>
            </select>
          </label>
          <label>
            数量（{nameOf(data.units, product.qu_id_stock)}）
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label>
            {action === "add" ? "入库位置" : "来源位置"}
            <select
              value={location}
              onChange={(e) => {
                setLocation(e.target.value);
                setStockId("");
              }}
            >
              {data.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          {action !== "add" && (
            <>
              <label>
                批次（开封必须选择）
                <select
                  value={stockId}
                  onChange={(e) => setStockId(e.target.value)}
                >
                  <option value="">由 Grocy 按顺序选择</option>
                  {entries
                    .filter((e) => String(e.location_id) === location)
                    .map((e) => (
                      <option key={e.id} value={e.stock_id}>
                        {e.stock_id} · {e.amount} · {e.best_before_date} ·{" "}
                        {Number(e.open) ? "已开封" : "未开封"}
                      </option>
                    ))}
                </select>
              </label>
              <p className="muted small">
                操作日期由 Grocy
                按当前服务时间记录；这些接口不支持回填历史日期。
              </p>
            </>
          )}
          {action === "transfer" && (
            <label>
              目标位置
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">请选择</option>
                {data.locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {action === "add" && (
            <>
              <label>
                购买日期
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </label>
              <label>
                保质期日期
                <input
                  type="date"
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                />
              </label>
              <label>
                每库存单位价格（{data.currency}）
                <input
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={independent}
                  onChange={(e) => setIndependent(e.target.checked)}
                />
                本次入库与订单收货无关，不会对同一采购重复入库
              </label>
            </>
          )}
          <button onClick={() => void preview()}>预览库存动作</button>
        </fieldset>
      )}
      {pending && (
        <>
          <h4>本次操作预览</h4>
          <pre className="changes">
            {JSON.stringify(pending.preview?.payload ?? pending.body, null, 2)}
          </pre>
          <p>确认后只执行一次。结果未知时先核对，不自动重发。</p>
          <div className="toolbar">
            <button disabled={busy} onClick={() => void preview()}>
              恢复原预览
            </button>
            {pending.preview && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    persist({ ...pending, uncertain: true });
                    const r = await post<StockOperation>(
                      "/grocy/manual/commit",
                      { request_id: pending.preview!.id },
                    );
                    setResult(r);
                    persist(null);
                    await onChanged();
                  })
                }
              >
                确认库存操作
              </button>
            )}
            {!pending.uncertain && (
              <button
                className="ghost"
                disabled={busy}
                onClick={() => persist(null)}
              >
                取消库存预览
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
