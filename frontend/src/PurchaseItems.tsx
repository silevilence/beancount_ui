import { useState } from "react";
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
    currency: data.currency,
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
}: {
  items: PurchaseItem[];
  onChange: (v: PurchaseItem[]) => void;
  amount: string;
  currency: string;
}) {
  const [data, setData] = useState<InventoryData>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  function update(index: number, next: PurchaseItem) {
    onChange(items.map((item, i) => (i === index ? next : item)));
  }
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
        商品数量独立于费用分录。价格为每库存单位价格；多商品、优惠和运费请逐项分配确认。
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
                  p && data
                    ? linkedItem(p, data, item)
                    : {
                        ...blankItem(),
                        id: item.id,
                        name: item.name,
                        quantity: item.quantity,
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
                <option key={p.id} value={p.id}>
                  {p.name}
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
          {item.product_id && (
            <>
              <p>
                1 {item.unit} = {item.factor || "未找到直接换算"}{" "}
                {item.stock_unit} · 本次{" "}
                {Number(item.quantity) * Number(item.factor)} {item.stock_unit}
              </p>
              <label>
                每库存单位价格（{item.currency} / {item.stock_unit}）
                <input
                  required
                  inputMode="decimal"
                  value={item.unit_price ?? ""}
                  onChange={(e) =>
                    update(index, {
                      ...item,
                      unit_price: e.target.value,
                      price_confirmed: false,
                    })
                  }
                />
              </label>
              {items.length === 1 &&
                currency === item.currency &&
                Number(amount) > 0 &&
                Number(item.quantity) * Number(item.factor) > 0 && (
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() =>
                      update(index, {
                        ...item,
                        unit_price: (
                          Number(amount) /
                          (Number(item.quantity) * Number(item.factor))
                        )
                          .toFixed(8)
                          .replace(/\.?0+$/, ""),
                        price_confirmed: false,
                      })
                    }
                  >
                    按单商品金额计算单价
                  </button>
                )}
              {currency !== item.currency && (
                <p className="muted">
                  账本币种 {currency} 与 Grocy
                  币种不同，请手动填写换算后的单价。
                </p>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={item.price_confirmed}
                  onChange={(e) =>
                    update(index, {
                      ...item,
                      price_confirmed: e.target.checked,
                    })
                  }
                />
                已核对商品、换算和分配后价格
              </label>
            </>
          )}
          <button
            type="button"
            className="ghost small"
            onClick={() => onChange(items.filter((_, i) => i !== index))}
          >
            移除此商品
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="ghost"
        onClick={() => onChange([...items, blankItem()])}
      >
        添加商品明细
      </button>
    </section>
  );
}
