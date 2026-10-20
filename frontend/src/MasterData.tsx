import { useState } from "react";
import { nameOf, type InventoryData, type Product } from "./Inventory";
import { post } from "./api";
import { requestId } from "./requestId";
import { reasonOf } from "./api";
import { Notice } from "./ui";

const labels: Record<string, string> = {
  products: "产品",
  locations: "位置",
  quantity_units: "单位",
  shopping_locations: "采购地点",
  product_groups: "产品分类",
};
const fields: Record<string, string[]> = {
  products: [
    "name",
    "description",
    "location_id",
    "qu_id_purchase",
    "qu_id_stock",
    "min_stock_amount",
    "default_best_before_days",
    "active",
    "product_group_id",
    "parent_product_id",
    "no_own_stock",
    "cumulate_min_stock_amount_of_sub_products",
  ],
  locations: ["name", "description", "is_freezer"],
  quantity_units: ["name", "description", "name_plural"],
  shopping_locations: ["name", "description"],
  product_groups: ["name", "description"],
  quantity_unit_conversions: ["product_id", "from_qu_id", "to_qu_id", "factor"],
};
const names: Record<string, string> = {
  name: "名称",
  description: "说明",
  location_id: "默认位置",
  qu_id_purchase: "采购单位",
  qu_id_stock: "库存单位",
  min_stock_amount: "最低库存",
  default_best_before_days: "默认保质期天数（-1 为不过期）",
  active: "启用（1 是 / 0 否）",
  is_freezer: "冷冻位置（1 是 / 0 否）",
  name_plural: "单位复数名称",
  product_id: "限定产品（留空为通用换算）",
  from_qu_id: "来源单位",
  to_qu_id: "目标单位",
  factor: "换算倍数",
  product_group_id: "产品分类",
  parent_product_id: "父产品",
  no_own_stock: "仅汇总子产品（无自有库存）",
  cumulate_min_stock_amount_of_sub_products: "累计子产品最低库存",
};
export default function MasterData({
  data,
  onChanged,
  conversionFor,
}: {
  data: InventoryData;
  onChanged: () => Promise<void>;
  conversionFor?: Product;
}) {
  const initialConversion =
    conversionFor &&
    data.conversions.find(
      (c) =>
        String(c.product_id) === String(conversionFor.id) &&
        String(c.from_qu_id) === String(conversionFor.qu_id_purchase) &&
        String(c.to_qu_id) === String(conversionFor.qu_id_stock),
    );
  const [entity, setEntity] = useState(
    conversionFor ? "quantity_unit_conversions" : "products",
  );
  const [id, setId] = useState(
    initialConversion ? String(initialConversion.id) : "",
  );
  const [form, setForm] = useState<Record<string, string>>({
    active: "1",
    min_stock_amount: "0",
    default_best_before_days: "0",
    no_own_stock: "0",
    cumulate_min_stock_amount_of_sub_products: "0",
    ...(conversionFor
      ? {
          product_id: String(conversionFor.id),
          from_qu_id: String(conversionFor.qu_id_purchase),
          to_qu_id: String(conversionFor.qu_id_stock),
        }
      : {}),
    ...(initialConversion ? { factor: String(initialConversion.factor) } : {}),
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const key = `beancount-ui.master.pending.${data.instance_id}${conversionFor ? `.conversion.${conversionFor.id}` : ""}`;
  const [pending, setPending] = useState<Record<string, unknown> | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  });
  const source = (
    {
      products: data.products,
      locations: data.locations,
      quantity_units: data.units,
      shopping_locations: data.shopping_locations,
      product_groups: data.product_groups ?? [],
      quantity_unit_conversions: conversionFor
        ? data.conversions.filter(
            (c) => String(c.product_id) === String(conversionFor.id),
          )
        : data.conversions,
    } as Record<string, unknown[]>
  )[entity] as Record<string, unknown>[];
  function pick(row?: Record<string, unknown>) {
    setId(row ? String(row.id) : "");
    setForm(
      Object.fromEntries(
        fields[entity].map((f) => [
          f,
          row?.[f] != null
            ? String(row[f])
            : f === "product_id" && conversionFor
              ? String(conversionFor.id)
              : f === "active"
                ? "1"
                : [
                      "is_freezer",
                      "min_stock_amount",
                      "default_best_before_days",
                      "no_own_stock",
                      "cumulate_min_stock_amount_of_sub_products",
                    ].includes(f)
                  ? "0"
                  : "",
        ]),
      ),
    );
  }
  async function save(remove = false) {
    if (busy) return;
    if (
      remove &&
      !window.confirm(
        "删除此资料？Grocy 会检查库存与历史引用，不能绕过引用限制。",
      )
    )
      return;
    setBusy(true);
    setMessage("");
    try {
      const body = pending || {
        request_id: requestId(),
        instance_id: data.instance_id,
        entity,
        entity_id: id ? Number(id) : null,
        delete: remove,
        data: Object.fromEntries(
          fields[entity].map((f) => [
            f,
            f.endsWith("_id") ||
            [
              "qu_id_purchase",
              "qu_id_stock",
              "active",
              "is_freezer",
              "default_best_before_days",
              "no_own_stock",
              "cumulate_min_stock_amount_of_sub_products",
            ].includes(f)
              ? form[f]
                ? Number(form[f])
                : null
              : (form[f] ?? ""),
          ]),
        ),
      };
      localStorage.setItem(key, JSON.stringify(body));
      setPending(body);
      const result = await post<{
        status: string;
        message: string;
        response?: { created_object_id?: number };
      }>("/grocy/master", body);
      setMessage(result.message);
      if (result.status === "done") {
        localStorage.removeItem(key);
        setPending(null);
        if (remove) pick();
        else if (!id && result.response?.created_object_id)
          setId(String(result.response.created_object_id));
      }
      await onChanged();
    } catch (e) {
      setMessage(reasonOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel card">
      <h2>
        {conversionFor ? `${conversionFor.name} · 单位换算` : "产品与基础资料"}
      </h2>
      <p className="muted">
        资料以 Grocy
        为准。修改换算不会重算历史收货；尚未发送的库存操作会重新核对。
      </p>
      {message && <Notice>{message}</Notice>}
      {pending && (
        <Notice tone="warn">
          有一项资料操作等待核对。重复提交只查询原请求结果，不自动再次执行。
          <button disabled={busy} onClick={() => void save()}>
            读取原请求结果
          </button>
          <button
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "已在 Grocy 核对本次操作实际结果？关闭后才能发起新的资料修改。",
                )
              ) {
                localStorage.removeItem(key);
                setPending(null);
              }
            }}
          >
            核对后关闭本次请求
          </button>
        </Notice>
      )}
      <fieldset disabled={busy || !!pending} className="grocy-form">
        {!conversionFor && (
          <label>
            资料类型
            <select
              value={entity}
              onChange={(e) => {
                setEntity(e.target.value);
                setId("");
                setForm({
                  active: "1",
                  min_stock_amount: "0",
                  default_best_before_days: "0",
                  is_freezer: "0",
                  no_own_stock: "0",
                  cumulate_min_stock_amount_of_sub_products: "0",
                });
              }}
            >
              {Object.entries(labels).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          {conversionFor ? "编辑单位换算" : "编辑记录"}
          <select
            value={id}
            onChange={(e) =>
              pick(source.find((r) => String(r.id) === e.target.value))
            }
          >
            <option value="">新增</option>
            {source.map((r) => (
              <option key={String(r.id)} value={String(r.id)}>
                {String(
                  r.name ??
                    `1 ${nameOf(data.units, Number(r.from_qu_id))} = ${r.factor} ${nameOf(data.units, Number(r.to_qu_id))}`,
                )}
              </option>
            ))}
          </select>
        </label>
        {fields[entity]
          .filter((f) => !(conversionFor && f === "product_id"))
          .map((f) => {
            const options =
              f === "location_id"
                ? data.locations
                : f.includes("qu_id")
                  ? data.units
                  : f === "product_group_id"
                    ? (data.product_groups ?? [])
                    : f === "product_id" || f === "parent_product_id"
                      ? data.products.filter(
                          (p) =>
                            f !== "parent_product_id" || String(p.id) !== id,
                        )
                      : null;
            return (
              <label key={f}>
                {names[f]}
                {[
                  "no_own_stock",
                  "cumulate_min_stock_amount_of_sub_products",
                ].includes(f) ? (
                  <input
                    type="checkbox"
                    checked={form[f] === "1"}
                    onChange={(e) =>
                      setForm({ ...form, [f]: e.target.checked ? "1" : "0" })
                    }
                  />
                ) : options ? (
                  <select
                    value={form[f] ?? ""}
                    onChange={(e) => setForm({ ...form, [f]: e.target.value })}
                  >
                    <option value="">
                      {["parent_product_id", "product_group_id"].includes(f)
                        ? "无"
                        : "请选择"}
                    </option>
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={form[f] ?? ""}
                    onChange={(e) => setForm({ ...form, [f]: e.target.value })}
                  />
                )}
              </label>
            );
          })}
        <div className="toolbar">
          <button onClick={() => void save()}>
            {conversionFor ? "保存单位换算" : "保存资料"}
          </button>
          <button className="ghost" onClick={() => pick()}>
            取消编辑
          </button>
          {id && (
            <button className="ghost" onClick={() => void save(true)}>
              删除资料
            </button>
          )}
        </div>
      </fieldset>
      {!conversionFor &&
        entity === "products" &&
        id &&
        !pending &&
        (() => {
          const product = data.products.find((p) => String(p.id) === id);
          return product ? (
            <MasterData
              key={id}
              data={data}
              conversionFor={product}
              onChanged={onChanged}
            />
          ) : (
            <p>刷新产品资料后可编辑单位换算。</p>
          );
        })()}
      {!conversionFor && entity === "products" && !id && (
        <p className="muted">先保存产品，再在此编辑它的单位换算。</p>
      )}
      {conversionFor &&
        data.conversions
          .filter(
            (c) =>
              !c.product_id &&
              [
                String(conversionFor.qu_id_purchase),
                String(conversionFor.qu_id_stock),
              ].includes(String(c.from_qu_id)) &&
              [
                String(conversionFor.qu_id_purchase),
                String(conversionFor.qu_id_stock),
              ].includes(String(c.to_qu_id)),
          )
          .map((c) => (
            <p className="muted" key={c.id}>
              通用换算：1 {nameOf(data.units, c.from_qu_id)} = {c.factor}{" "}
              {nameOf(data.units, c.to_qu_id)}
              。新增此产品的同向换算可覆盖通用值。
            </p>
          ))}
    </section>
  );
}
