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
  parent_product_id?: number | null;
  no_own_stock?: number | string;
  active?: number | string;
  product_group_id?: number | null;
  quick_consume_amount?: number | string;
  quick_open_amount?: number | string;
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
  product_groups?: Named[];
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
    amount_aggregated?: string;
    amount_opened_aggregated?: string;
    is_aggregated_amount?: boolean | number | string;
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

/** Keep ancestor context when filtering; use Grocy's aggregate without summing it twice. */
export function inventoryTree(
  data: InventoryData,
  query: string,
  showAll: boolean,
) {
  const products = new Map(data.products.map((p) => [String(p.id), p]));
  const children = (id: number) =>
    data.products.filter(
      (p) => String(p.parent_product_id) === String(id) && p.id !== id,
    );
  function totals(
    p: Product,
    seen = new Set<string>(),
  ): { amount: number; opened: number } {
    if (seen.has(String(p.id))) return { amount: 0, opened: 0 };
    const next = new Set(seen).add(String(p.id));
    const s = data.stock.find(
      (s) => String(s.product_id ?? s.product?.id) === String(p.id),
    );
    const own = {
      amount: Number(s?.amount ?? 0),
      opened: Number(s?.amount_opened ?? 0),
    };
    const sum = children(p.id)
      .filter((c) => String(c.qu_id_stock) === String(p.qu_id_stock))
      .reduce((acc, c) => {
        const child = totals(c, next);
        return {
          amount: acc.amount + child.amount,
          opened: acc.opened + child.opened,
        };
      }, own);
    const aggregate =
      children(p.id).length > 0 || Number(s?.is_aggregated_amount) === 1;
    return {
      amount: Number(
        (aggregate ? s?.amount_aggregated : undefined) ?? sum.amount,
      ),
      opened: Number(
        (aggregate ? s?.amount_opened_aggregated : undefined) ?? sum.opened,
      ),
    };
  }
  const visible = new Set<string>();
  for (const p of data.products) {
    const alert = Object.values(data.alerts).some((rows) =>
      rows.some(
        (a) => String(a.product_id ?? a.product?.id ?? a.id) === String(p.id),
      ),
    );
    if (!(
      showAll ||
      totals(p).amount > 0 ||
      Number(p.min_stock_amount) > 0 ||
      alert
    ))
      continue;
    let match: Product | undefined = p;
    const searched = new Set<string>();
    while (
      match &&
      !searched.has(String(match.id)) &&
      !`${match.name} ${match.id}`.toLowerCase().includes(query.toLowerCase())
    ) {
      searched.add(String(match.id));
      match = products.get(String(match.parent_product_id));
    }
    if (!match || searched.has(String(match.id))) continue;
    let current: Product | undefined = p;
    const seen = new Set<string>();
    while (current && !seen.has(String(current.id))) {
      seen.add(String(current.id));
      visible.add(String(current.id));
      current = products.get(String(current.parent_product_id));
    }
  }
  const result: {
    product: Product;
    depth: number;
    amount: number;
    opened: number;
    parent: boolean;
  }[] = [];
  const visited = new Set<string>();
  function walk(p: Product, depth: number) {
    if (visited.has(String(p.id)) || !visible.has(String(p.id))) return;
    visited.add(String(p.id));
    result.push({
      product: p,
      depth,
      ...totals(p),
      parent: children(p.id).length > 0,
    });
    children(p.id).forEach((c) => walk(c, depth + 1));
  }
  data.products
    .filter((p) => !products.has(String(p.parent_product_id)))
    .forEach((p) => walk(p, 0));
  data.products.forEach((p) => walk(p, 0)); // Broken or cyclic external hierarchy stays accessible.
  return result;
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
  const [showAll, setShowAll] = useState(false);
  const [collapsed, setCollapsed] = useState<number[]>([]);
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
  let hiddenBelow = Infinity;
  const rows = (data ? inventoryTree(data, query, showAll) : []).filter(
    (row) => {
      if (row.depth > hiddenBelow) return false;
      hiddenBelow =
        !query && collapsed.includes(row.product.id) ? row.depth : Infinity;
      return true;
    },
  );
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
      <button
        className="ghost"
        disabled={!data || !!error}
        title={
          data && !error
            ? undefined
            : "需要先成功读取 Grocy 库存，才能管理产品与基础资料"
        }
        onClick={() => setManage(!manage)}
      >
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
      <label className="check">
        <input
          type="checkbox"
          checked={showAll}
          onChange={(e) => setShowAll(e.target.checked)}
        />
        显示全部产品
      </label>
      {data && (
        <div className="inventory-grid">
          <section className="panel card">
            <h2>产品与告警</h2>
            {!data.products.length && (
              <p className="muted">暂无产品，请先建立产品资料。</p>
            )}
            {!!data.products.length && !rows.length && (
              <p className="muted">
                暂无有库存或告警的匹配产品，可开启“显示全部产品”。
              </p>
            )}
            <div role="tree" aria-label="产品库存树">
              {rows.map(({ product: p, depth, amount, opened, parent }) => {
                return (
                  <article
                    className={`inventory-row${depth ? " inventory-child" : ""}`}
                    role="treeitem"
                    aria-level={depth + 1}
                    aria-expanded={
                      parent ? !collapsed.includes(p.id) || !!query : undefined
                    }
                    style={{ marginLeft: `${depth * 1.25}rem` }}
                    key={p.id}
                  >
                    <div className="inventory-title">
                      {parent && (
                        <button
                          className="ghost small"
                          aria-label={`${collapsed.includes(p.id) && !query ? "展开" : "收起"}${p.name}`}
                          onClick={() =>
                            setCollapsed((ids) =>
                              ids.includes(p.id)
                                ? ids.filter((id) => id !== p.id)
                                : [...ids, p.id],
                            )
                          }
                        >
                          {collapsed.includes(p.id) && !query ? "▸" : "▾"}
                        </button>
                      )}
                      <button
                        className="ghost"
                        onClick={() => void pick(p)}
                        aria-pressed={selected?.id === p.id}
                      >
                        {p.name}
                      </button>
                    </div>
                    <strong>
                      {parent ? "含子产品合计 " : ""}
                      {amount} {nameOf(data.units, p.qu_id_stock)}
                    </strong>
                    <small>
                      已开封 {opened} · {nameOf(data.locations, p.location_id)}
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
                          {onPurchase && !Number(p.no_own_stock) && (
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
            </div>
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
                {selected &&
                  !Number(selected.no_own_stock) &&
                  !error &&
                  !detailError && (
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
