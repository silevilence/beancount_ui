import { useEffect, useState } from "react";
import { api, reasonOf } from "./api";
import { Notice } from "./ui";

export interface GrocyConfig {
  url: string;
  enabled: boolean;
  key_configured: boolean;
  instance_id: string;
  default_location_id: number | null;
  default_best_before_days: number | null;
}
export async function post<T>(path: string, body: unknown = {}): Promise<T> {
  return api<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
export default function GrocySettings() {
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
                  const v = await post<{
                    version: string;
                    write_permission: string;
                  }>("/grocy/check");
                  setMessage(
                    `Grocy ${v.version} · 必要读取接口可用 · ${v.write_permission}`,
                  );
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
      </p>
    </>
  );
}
