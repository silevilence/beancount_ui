import { useEffect, useState } from "react";
import { api, post, reasonOf } from "./api";
import { Notice } from "./ui";

export interface GrocyConfig {
  url: string;
  enabled: boolean;
  key_configured: boolean;
  instance_id: string;
  default_location_id: number | null;
  default_best_before_days: number | null;
}
interface ConnectionCheck {
  version: string;
  compatible: boolean;
  write_permission: string;
  checks: Record<string, { available: boolean; code: string; message: string }>;
}
interface Bindings {
  locked: boolean;
  items: {
    order_id: string;
    item_id: string;
    name: string;
    product_id: number;
  }[];
  operations: {
    id: string;
    product_id: number;
    status: string;
    needs_review: boolean;
  }[];
}
export default function GrocySettings() {
  const [check, setCheck] = useState<ConnectionCheck>();
  const [bindings, setBindings] = useState<Bindings>();
  const [saved, setSaved] = useState<GrocyConfig>();
  const [form, setForm] = useState<GrocyConfig>();
  const [key, setKey] = useState("");
  const [clear, setClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    let live = true;
    api<GrocyConfig>("/grocy/config")
      .then((v) => {
        if (live) {
          setSaved(v);
          setForm(v);
        }
      })
      .catch((e) => {
        if (live) setError(reasonOf(e));
      });
    return () => {
      live = false;
    };
  }, []);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    setCheck(undefined);
    try {
      await work();
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      {check && (
        <section aria-label="连接检查结果">
          <Notice tone={check.compatible ? undefined : "warn"}>
            Grocy {check.version || "版本未知"} ·{" "}
            {check.compatible
              ? "版本属于适配范围"
              : "暂仅支持 Grocy 4.x，请核对版本"}{" "}
            · {check.write_permission}
          </Notice>
          <ul>
            {Object.entries(check.checks ?? {}).map(([path, result]) => (
              <li key={path}>
                {path}：
                {result.available
                  ? "可读取"
                  : `${result.message}（${result.code}）`}
              </li>
            ))}
          </ul>
        </section>
      )}
      <button
        className="ghost"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            setBindings(await api<Bindings>("/grocy/bindings"));
          })
        }
      >
        查看实例关联与待处理操作
      </button>
      {bindings && (
        <section aria-label="实例关联">
          <p>
            {bindings.locked
              ? "实例已绑定，不能直接更换地址。"
              : "尚未绑定，可在设置中更换实例。"}
            历史记录不会迁移；已有绑定的地址迁移需停写、备份并核对同一数据库，不支持把旧产品
            ID 重新绑定到另一实例。
          </p>
          {!!bindings.items.length && (
            <>
              <p className="muted small">订单商品关联</p>
              <ul>
                {bindings.items.map((i) => (
                  <li key={`${i.order_id}:${i.item_id}`}>
                    订单 {i.order_id} · {i.name} · Grocy #{i.product_id}
                  </li>
                ))}
              </ul>
            </>
          )}
          {!!bindings.operations.length && (
            <>
              <p className="muted small">库存操作记录</p>
              <ul>
                {bindings.operations.map((o) => (
                  <li key={o.id}>
                    操作 {o.id} · Grocy #{o.product_id} · {o.status}
                    {o.needs_review ? " · 待处理" : " · 历史记录"}
                  </li>
                ))}
              </ul>
            </>
          )}
          {!bindings.items.length && !bindings.operations.length && (
            <p>
              没有订单商品或库存操作记录。实例保护也可能来自历史主数据操作，请核对状态备份。
            </p>
          )}
        </section>
      )}
      {form && (
        <fieldset disabled={busy} className="grocy-form">
          <label>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />{" "}
            启用库存联动
          </label>
          <label>
            Grocy 实例地址
            <input
              type="url"
              value={form.url}
              placeholder="http://grocy:80/子路径"
              onChange={(e) => setForm({ ...form, url: e.target.value })}
            />
          </label>
          <label>
            API Key{" "}
            {saved?.key_configured ? "（已配置，留空保留）" : "（未配置）"}
            <input
              type="password"
              autoComplete="new-password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={clear}
              onChange={(e) => {
                setClear(e.target.checked);
                if (e.target.checked) setForm({ ...form, enabled: false });
              }}
            />{" "}
            清除已保存 Key
          </label>
          <label>
            默认入库位置 ID（留空使用产品默认）
            <input
              type="number"
              min="1"
              value={form.default_location_id ?? ""}
              onChange={(e) =>
                setForm({
                  ...form,
                  default_location_id: e.target.value
                    ? Number(e.target.value)
                    : null,
                })
              }
            />
          </label>
          <label>
            默认保质期天数（留空使用产品默认）
            <input
              type="number"
              min="0"
              value={form.default_best_before_days ?? ""}
              onChange={(e) =>
                setForm({
                  ...form,
                  default_best_before_days: e.target.value
                    ? Number(e.target.value)
                    : null,
                })
              }
            />
          </label>
          <div className="toolbar">
            <button
              onClick={() =>
                void run(async () => {
                  const v = await post<GrocyConfig>("/grocy/config", {
                    url: form.url,
                    enabled: form.enabled,
                    api_key: key || null,
                    clear_key: clear,
                    default_location_id: form.default_location_id,
                    default_best_before_days: form.default_best_before_days,
                  });
                  setBindings(undefined);
                  setSaved(v);
                  setForm(v);
                  setKey("");
                  setClear(false);
                  setMessage("Grocy 设置已保存");
                })
              }
            >
              保存 Grocy 设置
            </button>
            <button
              className="ghost"
              onClick={() => {
                setForm(saved);
                setKey("");
                setClear(false);
                setError("");
                setMessage("");
              }}
            >
              取消修改
            </button>
            <button
              className="ghost"
              onClick={() =>
                void run(async () => {
                  const v = await post<ConnectionCheck>("/grocy/check");
                  setCheck(v);
                })
              }
            >
              测试已保存连接
            </button>
          </div>
        </fieldset>
      )}
      <p className="muted small">
        由账本后端访问 Grocy。Key
        仅保存在后端状态目录；更换实例不会迁移旧产品关联。连接测试不会更改库存。
        位置与单位编号可在库存管理 → 管理产品与基础资料中查看。
      </p>
    </>
  );
}
