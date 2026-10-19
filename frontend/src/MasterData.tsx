import { useState } from "react";
import type { InventoryData } from "./Inventory";
import { post } from "./api";
import { requestId } from "./requestId";
import { reasonOf } from "./api";
import { Notice } from "./ui";

const labels: Record<string, string> = {
  products: "产品",
  locations: "位置",
  quantity_units: "单位",
  shopping_locations: "采购地点",
  quantity_unit_conversions: "单位换算",
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
  ],
  locations: ["name", "description", "is_freezer"],
  quantity_units: ["name", "description", "name_plural"],
  shopping_locations: ["name", "description"],
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
};
export default function MasterData({
  data,
  onChanged,
}: {
  data: InventoryData;
  onChanged: () => Promise<void>;
}) {
  const [entity, setEntity] = useState("products");
  const [id, setId] = useState("");
  const [form, setForm] = useState<Record<string, string>>({
    active: "1",
    min_stock_amount: "0",
    default_best_before_days: "0",
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const key = `beancount-ui.master.pending.${data.instance_id}`;
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
      quantity_unit_conversions: data.conversions,
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
            : f === "active"
              ? "1"
              : [
                    "is_freezer",
                    "min_stock_amount",
                    "default_best_before_days",
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
      const result = await post<{ status: string; message: string }>(
        "/grocy/master",
        body,
      );
      setMessage(result.message);
      if (result.status === "done") {
        localStorage.removeItem(key);
        setPending(null);
        pick();
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
      <h2>产品与基础资料</h2>
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
        <label>
          编辑记录
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
                    `#${r.id} · ${r.from_qu_id} → ${r.to_qu_id} × ${r.factor}`,
                )}
              </option>
            ))}
          </select>
        </label>
        {fields[entity].map((f) => {
          const options =
            f === "location_id"
              ? data.locations
              : f.includes("qu_id")
                ? data.units
                : f === "product_id"
                  ? data.products
                  : null;
          return (
            <label key={f}>
              {names[f]}
              {options ? (
                <select
                  value={form[f] ?? ""}
                  onChange={(e) => setForm({ ...form, [f]: e.target.value })}
                >
                  <option value="">请选择</option>
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
          <button onClick={() => void save()}>保存资料</button>
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
    </section>
  );
}
