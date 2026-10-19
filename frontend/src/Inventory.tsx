import { useEffect, useRef, useState } from "react";
import { api, reasonOf } from "./api";
import { stampOf } from "./format";
import { Chip, Notice } from "./ui";
import MasterData from "./MasterData";
import StockActionEditor from "./StockActionEditor";
import OperationStatus, { type StockOperation } from "./OperationStatus";

export interface Product {
  id: number;
  name: string;
  qu_id_stock: number;
  qu_id_purchase: number;
  location_id: number;
  min_stock_amount: string;
  default_best_before_days?: number;
  enable_tare_weight_handling?: number;
}
export interface Named {
  id: number;
  name: string;
}
export interface InventoryData {
  purchase_quantities?: Record<
    string,
    { pending: string; received_unsynced: string; order_ids: string[] }
  >;
  currency: string;
  instance_id: string;
  updated_at: string;
  products: Product[];
  locations: Named[];
  units: Named[];
  shopping_locations: Named[];
  conversions: {
    id: number;
    product_id: number | null;
    from_qu_id: number;
    to_qu_id: number;
    factor: string;
  }[];
  stock: {
    product_id: number;
    amount: string;
    amount_opened?: string;
    best_before_date?: string;
    product: Product;
  }[];
  alerts: Record<
    string,
    { id?: number; product_id?: number; product?: Product }[]
  >;
}
export interface StockEntry {
  id: number;
  stock_id: string;
  amount: string;
  opened_date?: string;
  open?: number;
  best_before_date: string;
  location_id: number;
  price?: string;
}
interface ProductView {
  details: Record<string, unknown>;
  entries: StockEntry[];
  updated_at: string;
}
export function nameOf(rows: Named[], id: number) {
  return rows.find((r) => String(r.id) === String(id))?.name ?? String(id);
}
export default function Inventory({
  onPurchase,
  onOrder,
}: {
  onPurchase?: (product: Product, inventory: InventoryData) => void;
  onOrder?: (id: string) => void;
}) {
  const [data, setData] = useState<InventoryData>();
  const [selected, setSelected] = useState<Product>();
  const [detail, setDetail] = useState<ProductView>();
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [busy, setBusy] = useState(false);
  const [manage, setManage] = useState(false);
  const [operations, setOperations] = useState<StockOperation[]>([]);
  const sequence = useRef(0);
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      setData(await api<InventoryData>("/grocy/inventory"));
      const ops = await api<StockOperation[]>("/grocy/operations");
      setOperations(Array.isArray(ops) ? ops : []);
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
    return () => {
      ++sequence.current;
    };
  }, []);
  async function pick(product: Product) {
    const seq = ++sequence.current;
    setSelected(product);
    setDetail(undefined);
    setDetailError("");
    try {
      const v = await api<ProductView>(`/grocy/products/${product.id}`);
      if (seq === sequence.current) setDetail(v);
    } catch (e) {
      if (seq === sequence.current) setDetailError(reasonOf(e));
    }
  }
  function has(kind: string, id: number) {
    return data?.alerts[kind]?.some(
      (a) => String(a.product_id ?? a.product?.id ?? a.id) === String(id),
    );
  }
  return (
    <section className="settings-page inventory-page">
      <header className="page-heading">
        <p className="eyebrow">STOCK / 家中库存</p>
        <h1>库存管理</h1>
        <p className="muted">
          下单不会增加库存。收到商品后，在订单页确认收货。
        </p>
        <button
          disabled={busy}
          onClick={() => {
            void refresh();
            if (selected) void pick(selected);
          }}
        >
          {busy ? "正在读取…" : "刷新库存"}
        </button>
        {data && <small> · 更新于 {stampOf(data.updated_at)}</small>}
      </header>
      {error && (
        <Notice tone="error">
          {error}
          {data && "。以下是旧数据，无法确认最新库存。"}
        </Notice>
      )}
      <button className="ghost" onClick={() => setManage(!manage)}>
        {manage ? "返回库存浏览" : "管理产品与基础资料"}
      </button>
      {manage && data && !error && (
        <MasterData data={data} onChanged={refresh} />
      )}
      <label className="field">
        搜索产品
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="名称或产品编号"
        />
      </label>
      {data && (
        <div className="inventory-grid">
          <section className="panel card">
            <h2>产品与告警</h2>
            {!data.products.length && (
              <p className="muted">暂无产品，请先建立产品资料。</p>
            )}
            {data.products
              .filter((p) =>
                `${p.name} ${p.id}`.toLowerCase().includes(query.toLowerCase()),
              )
              .map((p) => {
                const stock = data.stock.find(
                  (s) => String(s.product_id ?? s.product?.id) === String(p.id),
                );
                return (
                  <article className="inventory-row" key={p.id}>
                    <button
                      className="ghost"
                      onClick={() => void pick(p)}
                      aria-pressed={selected?.id === p.id}
                    >
                      {p.name}
                    </button>
                    <strong>
                      {stock?.amount ?? "0"} {nameOf(data.units, p.qu_id_stock)}
                    </strong>
                    <small>
                      已开封 {stock?.amount_opened ?? "0"} ·{" "}
                      {nameOf(data.locations, p.location_id)}
                    </small>
                    {data.purchase_quantities?.[String(p.id)] && (
                      <div className="muted small">
                        <p>
                          已购买待收货{" "}
                          {data.purchase_quantities[String(p.id)].pending}{" "}
                          {nameOf(data.units, p.qu_id_stock)} · 已收货未入库确认{" "}
                          {
                            data.purchase_quantities[String(p.id)]
                              .received_unsynced
                          }
                        </p>
                        {data.purchase_quantities[String(p.id)].order_ids.map(
                          (id) => (
                            <button
                              key={id}
                              className="ghost small"
                              onClick={() => onOrder?.(id)}
                            >
                              查看订单 {id.slice(0, 8)}
                            </button>
                          ),
                        )}
                      </div>
                    )}
                    <div className="inventory-alerts">
                      {has("missing_products", p.id) && (
                        <>
                          <Chip tone="warn">缺货 / 低于最低库存</Chip>
                          {onPurchase && (
                            <button
                              className="ghost small"
                              disabled={!!error}
                              onClick={() => onPurchase(p, data)}
                            >
                              购买
                            </button>
                          )}
                        </>
                      )}
                      {has("due_products", p.id) && (
                        <Chip tone="warn">临期</Chip>
                      )}
                      {has("overdue_products", p.id) && (
                        <Chip tone="danger">已过最佳食用期</Chip>
                      )}
                      {has("expired_products", p.id) && (
                        <Chip tone="danger">已过期</Chip>
                      )}
                    </div>
                  </article>
                );
              })}
          </section>
          <section className="panel card">
            <h2>{selected?.name ?? "批次详情"}</h2>
            {!selected && (
              <p className="muted">
                选择产品，查看每个位置的数量、开封与保质期。
              </p>
            )}
            {detailError && (
              <Notice tone="error">{detailError}。详情不可用，请重试。</Notice>
            )}
            {selected && !detail && !detailError && <p>正在读取批次…</p>}
            {detail && (
              <>
                {selected && !error && !detailError && (
                  <StockActionEditor
                    key={selected.id}
                    product={selected}
                    data={data}
                    entries={detail.entries}
                    onChanged={async () => {
                      await refresh();
                      await pick(selected);
                    }}
                  />
                )}
                <OperationStatus
                  operations={operations.filter(
                    (o) => String(o.product_id) === String(selected?.id),
                  )}
                  onChanged={async () => {
                    await refresh();
                    if (selected) await pick(selected);
                  }}
                />
                {!detail.entries.length && (
                  <p className="muted">当前无库存批次。</p>
                )}
                {detail.entries.map((e) => (
                  <article className="inventory-row" key={e.id}>
                    <strong>
                      {e.amount}{" "}
                      {selected && nameOf(data.units, selected.qu_id_stock)}
                    </strong>
                    <span>
                      {nameOf(data.locations, e.location_id)} · 批次{" "}
                      {e.stock_id}
                    </span>
                    <small>
                      保质期 {e.best_before_date} ·{" "}
                      {Number(e.open)
                        ? `已开封 ${e.opened_date ?? ""}`
                        : "未开封"}
                    </small>
                  </article>
                ))}
              </>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
