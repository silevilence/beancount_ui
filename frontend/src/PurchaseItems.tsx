import { normalizeAmount } from "./amounts";
import { useEffect, useState } from "react";
import { api, reasonOf } from "./api";
import { nameOf, type InventoryData, type Product } from "./Inventory";
import { requestId } from "./requestId";
import { Notice } from "./ui";

export interface PurchaseItem {
  id: string;
  name: string;
  quantity: string;
  unit: string;
  product_id: number | null;
  instance_id: string;
  factor: string;
  stock_unit: string;
  purchase_unit_id: number | null;
  stock_unit_id: number | null;
  unit_price: string | null;
  currency: string;
  price_confirmed: boolean;
  allocated_amount?: string | null;
  default_location_id?: number | null;
  default_best_before_days?: number | null;
}
export const blankItem = (): PurchaseItem => ({
  id: requestId(),
  name: "",
  quantity: "1",
  unit: "件",
  product_id: null,
  instance_id: "",
  factor: "1",
  stock_unit: "件",
  purchase_unit_id: null,
  stock_unit_id: null,
  unit_price: null,
  currency: "",
  price_confirmed: false,
});
export function linkedItem(
  p: Product,
  data: InventoryData,
  old = blankItem(),
): PurchaseItem {
  const rows = data.conversions.filter(
    (c) =>
      String(c.from_qu_id) === String(p.qu_id_purchase) &&
      String(c.to_qu_id) === String(p.qu_id_stock) &&
      (!c.product_id || String(c.product_id) === String(p.id)),
  );
  const conversion =
    rows.find((c) => String(c.product_id) === String(p.id)) ?? rows[0];
  return {
    ...old,
    name: p.name,
    product_id: Number(p.id),
    instance_id: data.instance_id,
    purchase_unit_id: Number(p.qu_id_purchase),
    stock_unit_id: Number(p.qu_id_stock),
    factor:
      String(p.qu_id_purchase) === String(p.qu_id_stock)
        ? "1"
        : String(conversion?.factor ?? ""),
    unit: nameOf(data.units, p.qu_id_purchase),
    stock_unit: nameOf(data.units, p.qu_id_stock),
    unit_price: null,
    currency: old.currency,
    price_confirmed: false,
    default_location_id: Number(p.location_id) || null,
    default_best_before_days: p.default_best_before_days ?? null,
  };
}
/** Suggest only an uncovered shortage with a known direct unit conversion. */
export function shortagePurchase(
  p: Product,
  data: InventoryData,
): PurchaseItem {
  const item = linkedItem(p, data);
  const factor = Number(item.factor);
  const stock = data.stock.find((s) => String(s.product_id) === String(p.id));
  const incoming = data.purchase_quantities?.[String(p.id)];
  const shortage =
    Number(p.min_stock_amount) -
    Number(stock?.amount ?? 0) -
    Number(incoming?.pending ?? 0) -
    Number(incoming?.received_unsynced ?? 0);
  item.quantity =
    Number.isFinite(factor) &&
    factor > 0 &&
    Number.isFinite(shortage) &&
    shortage > 0
      ? String(Math.ceil(shortage / factor))
      : "";
  return item;
}

export default function PurchaseItems({
  items,
  onChange,
  amount,
  currency,
  autoCalculate = true,
}: {
  items: PurchaseItem[];
  onChange: (v: PurchaseItem[]) => void;
  amount: string;
  currency: string;
  autoCalculate?: boolean;
}) {
  const [data, setData] = useState<InventoryData>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  function priced(rows: PurchaseItem[]) {
    return rows.map((item) => {
      const allocation =
        rows.length === 1 && amount !== ""
          ? normalizeAmount(amount)
          : (item.allocated_amount ??
            (item.unit_price != null
              ? (
                  Number(normalizeAmount(item.unit_price)) *
                  Number(item.quantity) *
                  Number(item.factor)
                )
                  .toFixed(8)
                  .replace(/\.?0+$/, "")
              : undefined));
      const quantity = Number(item.quantity) * Number(item.factor);
      const valid =
        allocation != null &&
        allocation !== "" &&
        Number.isFinite(Number(normalizeAmount(allocation))) &&
        Number(normalizeAmount(allocation)) >= 0 &&
        Number.isFinite(quantity) &&
        quantity > 0;
      return {
        ...item,
        allocated_amount: allocation,
        currency,
        unit_price:
          item.product_id && valid
            ? (Number(normalizeAmount(allocation)) / quantity)
                .toFixed(8)
                .replace(/\.?0+$/, "")
            : null,
        price_confirmed: !!item.product_id && valid,
      };
    });
  }
  function change(rows: PurchaseItem[]) {
    onChange(priced(rows));
  }
  useEffect(() => {
    if (!autoCalculate) return;
    const next = priced(items);
    if (JSON.stringify(next) !== JSON.stringify(items)) onChange(next);
  }, [items, amount, currency, autoCalculate]);
  function update(index: number, next: PurchaseItem) {
    change(items.map((item, i) => (i === index ? next : item)));
  }
  const allocated = items.reduce(
    (sum, item) => sum + Number(normalizeAmount(item.allocated_amount || "0")),
    0,
  );

  return (
    <section className="purchase-items">
      <div className="panel-head">
        <h3>购买商品 · 可选库存关联</h3>
        <button
          type="button"
          className="ghost small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setData(await api<InventoryData>("/grocy/inventory"));
              setError("");
            } catch (e) {
              setError(reasonOf(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "正在读取…" : "读取 Grocy 产品"}
        </button>
      </div>
      {error && <Notice tone="warn">{error}。可继续记录未关联商品。</Notice>}
      <p className="muted small">
        单商品自动使用整单金额；多商品只需分配金额（含优惠和运费），单价按数量和单位换算自动计算。金额使用账本币种。
        点「读取 Grocy 产品」后才能选择关联，未加载也可直接记录。
      </p>
      {items.map((item, index) => (
        <fieldset className="grocy-form inventory-row" key={item.id}>
          <legend>商品 {index + 1}</legend>
          <label>
            商品名称
            <input
              required
              value={item.name}
              onChange={(e) => update(index, { ...item, name: e.target.value })}
            />
          </label>
          <label>
            关联 Grocy 产品
            <select
              value={item.product_id ?? ""}
              onChange={(e) => {
                const p = data?.products.find(
                  (p) => String(p.id) === e.target.value,
                );
                update(
                  index,
                  p &&
                    data &&
                    !Number(p.no_own_stock) &&
                    Number(p.active ?? 1) !== 0
                    ? linkedItem(p, data, item)
                    : {
                        ...blankItem(),
                        id: item.id,
                        name: item.name,
                        quantity: item.quantity,
                        allocated_amount: item.allocated_amount,
                      },
                );
              }}
            >
              <option value="">不关联</option>
              {item.product_id &&
                !data?.products.some(
                  (p) => String(p.id) === String(item.product_id),
                ) && (
                  <option value={item.product_id}>
                    {item.name}（保存的关联，请刷新核对）
                  </option>
                )}
              {data?.products.map((p) => (
                <option
                  key={p.id}
                  value={p.id}
                  disabled={
                    !!Number(p.no_own_stock) || Number(p.active ?? 1) === 0
                  }
                >
                  {p.name}
                  {Number(p.no_own_stock)
                    ? "（无自有库存）"
                    : Number(p.active ?? 1) === 0
                      ? "（已停用）"
                      : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            采购数量
            <input
              required
              inputMode="decimal"
              value={item.quantity}
              onChange={(e) =>
                update(index, {
                  ...item,
                  quantity: e.target.value,
                  price_confirmed: false,
                })
              }
            />
          </label>
          <label>
            采购单位
            <input
              required
              value={item.unit}
              readOnly={!!item.product_id}
              onChange={(e) => update(index, { ...item, unit: e.target.value })}
            />
          </label>
          <label>
            分配金额（{currency}）
            <input
              required
              inputMode="decimal"
              readOnly={items.length === 1 && amount !== ""}
              value={item.allocated_amount ?? ""}
              onBlur={(e) => {
                if (!e.target.readOnly)
                  update(index, {
                    ...item,
                    allocated_amount: normalizeAmount(e.target.value),
                  });
              }}
              onChange={(e) =>
                update(index, { ...item, allocated_amount: e.target.value })
              }
            />
          </label>
          {item.product_id && (
            <>
              <p>
                1 {item.unit} = {item.factor || "未找到直接换算"}{" "}
                {item.stock_unit} · 本次{" "}
                {Number(item.quantity) * Number(item.factor)} {item.stock_unit}
              </p>
              <label>
                每库存单位价格（{currency} / {item.stock_unit}，自动计算）
                <input readOnly value={item.unit_price ?? ""} />
              </label>
            </>
          )}
          <button
            type="button"
            className="ghost small"
            onClick={() => change(items.filter((_, i) => i !== index))}
          >
            移除此商品
          </button>
        </fieldset>
      ))}
      {items.length > 1 && amount !== "" && (
        <p role="status">
          已分配 {allocated.toFixed(2)} / {amount} {currency} · 剩余{" "}
          {(Number(normalizeAmount(amount)) - allocated).toFixed(2)}
        </p>
      )}
      <button
        type="button"
        className="ghost"
        onClick={() => change([...items, blankItem()])}
      >
        添加商品明细
      </button>
    </section>
  );
}
