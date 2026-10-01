import { useEffect, useRef, useState } from "react";
import { api, reasonOf } from "./api";
import Diff from "./Diff";
import { shanghaiToday } from "./format";
import { Notice } from "./ui";

import { businessNames, type Layout } from "./businessConfig";
import TemplateSettings, { starterTemplate } from "./TemplateSettings";
export type { Layout } from "./businessConfig";
const labels = businessNames;
interface Configuration {
  layout: Layout;
  default: Layout;
}
interface Preview {
  token: string;
  routes: { business: string; target: string; chain: string[] }[];
  diffs: Record<string, string>;
}

export default function LayoutDialog({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [config, setConfig] = useState<Configuration>();
  const [layout, setLayout] = useState<Layout>();
  const [day, setDay] = useState(shanghaiToday);
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [newBusiness, setNewBusiness] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    let cancelled = false;
    void api<Configuration>("/layout")
      .then((value) => {
        if (!cancelled) {
          setConfig(value);
          setLayout(value.layout);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(reasonOf(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  function change(value: Layout) {
    setLayout(value);
    setPreview(undefined);
    setError("");
    setDone(false);
  }
  async function submit(enable: boolean) {
    setBusy(true);
    setError("");
    setDone(false);
    try {
      const result = await api<Preview>(
        `/layout/${enable ? "activate" : "preview"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            layout: layout && {
              ...layout,
              routes: Object.fromEntries(
                Object.entries(layout.routes).map(([key, route]) => [
                  key,
                  {
                    ...route,
                    indexes: route.indexes
                      .map((path) => path.trim())
                      .filter(Boolean),
                  },
                ]),
              ),
            },
            day,
            token: enable ? preview?.token : "",
          }),
        },
      );
      if (enable) {
        setPreview(undefined);
        setDone(true);
        await onChanged();
      } else setPreview(result);
    } catch (e) {
      setError(reasonOf(e));
      setPreview(undefined);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="editor-dialog layout-dialog"
      aria-label="文件布局"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="editor-head">
        <div>
          <p className="eyebrow">账本设置</p>
          <h2>文件布局</h2>
        </div>
        <button className="ghost small" disabled={busy} onClick={onClose}>
          关闭布局
        </button>
      </header>
      <p className="muted">
        设置业务类型、文件位置和记录模板中的填写项。配置用于新建记录；历史记录留在原文件。启用后，尚未保存的交易需要重新预览。
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {done && <Notice>布局已启用，历史文件保持原位。</Notice>}
      {layout && config && (
        <>
          <fieldset disabled={busy}>
            <label className="field">
              账本入口
              <input
                value={layout.entry}
                onChange={(e) => change({ ...layout, entry: e.target.value })}
              />
            </label>
            <p className="muted small">
              入口须已存在并包含历史账本。路径相对于账本根目录，使用 /
              分隔。日期路径支持 {"{year}"}（四位年）、{"{month}"}（两位月）、
              {"{day}"}（两位日），也可直接填写 a.bean。
            </p>
            {Object.keys(layout.routes).map((business) => (
              <section className="layout-route" key={business}>
                <h3>
                  {layout.routes[business].label ||
                    labels[business] ||
                    business}
                </h3>
                <div className="form-grid">
                  <label className="field">
                    {labels[business] || business}业务名称
                    <input
                      value={layout.routes[business].label || ""}
                      onChange={(e) =>
                        change({
                          ...layout,
                          routes: {
                            ...layout.routes,
                            [business]: {
                              ...layout.routes[business],
                              label: e.target.value,
                            },
                          },
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    {labels[business] || business}路径日期来源
                    <select
                      value={layout.routes[business].date_source || "record"}
                      onChange={(e) =>
                        change({
                          ...layout,
                          routes: {
                            ...layout.routes,
                            [business]: {
                              ...layout.routes[business],
                              date_source: e.target.value as "record" | "write",
                            },
                          },
                        })
                      }
                    >
                      <option value="record">交易日期（记录发生时间）</option>
                      <option value="write">
                        实际写入日期（Asia/Shanghai）
                      </option>
                    </select>
                  </label>
                  {!labels[business] && (
                    <label className="field">
                      {business}记账语义
                      <select
                        value={layout.routes[business].kind || "ordinary"}
                        onChange={(e) =>
                          change({
                            ...layout,
                            routes: {
                              ...layout.routes,
                              [business]: {
                                ...layout.routes[business],
                                kind: e.target.value,
                              },
                            },
                          })
                        }
                      >
                        {Object.entries(labels).map(([key, label]) => (
                          <option value={key} key={key}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="field">
                    {layout.routes[business].label ||
                      labels[business] ||
                      business}
                    目标文件
                    <input
                      value={layout.routes[business].target}
                      onChange={(e) =>
                        change({
                          ...layout,
                          routes: {
                            ...layout.routes,
                            [business]: {
                              ...layout.routes[business],
                              target: e.target.value,
                            },
                          },
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    {layout.routes[business].label ||
                      labels[business] ||
                      business}
                    索引链
                    <textarea
                      rows={3}
                      value={layout.routes[business].indexes.join("\n")}
                      onChange={(e) =>
                        change({
                          ...layout,
                          routes: {
                            ...layout.routes,
                            [business]: {
                              ...layout.routes[business],
                              indexes: e.target.value.split("\n"),
                            },
                          },
                        })
                      }
                    />
                  </label>
                </div>
                <TemplateSettings
                  name={
                    layout.routes[business].label ||
                    labels[business] ||
                    business
                  }
                  value={layout.routes[business].template}
                  onChange={(template) =>
                    change({
                      ...layout,
                      routes: {
                        ...layout.routes,
                        [business]: { ...layout.routes[business], template },
                      },
                    })
                  }
                />
                {!labels[business] && (
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => {
                      const routes = { ...layout.routes };
                      delete routes[business];
                      change({ ...layout, routes });
                    }}
                  >
                    移除 {business} 业务（保留历史记录）
                  </button>
                )}
              </section>
            ))}
            <p className="muted small">
              索引链每行一个路径，按入口 → 索引 → 目标文件依次
              include；留空表示入口直接包含目标。每种业务均可选择固定文件或日期路径；索引可逐级使用日期路径，最终由固定入口包含。
            </p>
            <div className="toolbar">
              <label className="field">
                新增业务标识
                <input
                  value={newBusiness}
                  placeholder="例如 lunch"
                  onChange={(e) => setNewBusiness(e.target.value)}
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  if (
                    !/^[a-z][a-z0-9_-]{0,63}$/.test(newBusiness) ||
                    layout.routes[newBusiness]
                  ) {
                    setError(
                      "请输入未使用的业务标识：小写字母开头，可含数字、下划线和连字符",
                    );
                    return;
                  }
                  change({
                    ...layout,
                    routes: {
                      ...layout.routes,
                      [newBusiness]: {
                        target: `business/${newBusiness}.bean`,
                        indexes: [],
                        date_source: "record",
                        label: newBusiness,
                        kind: "ordinary",
                        template: starterTemplate,
                      },
                    },
                  });
                  setNewBusiness("");
                }}
              >
                添加业务类型
              </button>
            </div>
            <label className="field inline">
              预览交易日期
              <input
                type="date"
                value={day}
                onChange={(e) => {
                  setDay(e.target.value);
                  setPreview(undefined);
                  setDone(false);
                }}
              />
            </label>
          </fieldset>
          <div className="toolbar">
            <button
              className="ghost"
              disabled={busy}
              onClick={() => change(config.default)}
            >
              填入默认 MyBill 布局
            </button>
            <button disabled={busy || !day} onClick={() => void submit(false)}>
              检查并预览布局
            </button>
          </div>
          {preview && (
            <section aria-label="布局预览">
              <h3>新记录路由</h3>
              {preview.routes.map((route) => (
                <div className="layout-route" key={route.business}>
                  <strong>
                    {layout.routes[route.business]?.label ||
                      labels[route.business] ||
                      route.business}
                  </strong>
                  <p className="file">{route.target}</p>
                  <p className="muted small">{route.chain.join(" → ")}</p>
                </div>
              ))}
              <details>
                <summary>
                  查看 include 示例差异（预览日期及下一年 1 月）
                </summary>
                <p className="muted">
                  仅模拟创建所需文件，启用时不写入这些示例；保存新记录时才补齐
                  include。
                </p>
                {Object.entries(preview.diffs).map(([name, diff]) => (
                  <section key={name}>
                    <h4>{name}</h4>
                    <Diff diff={diff} />
                  </section>
                ))}
              </details>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void submit(true)}
              >
                启用此布局
              </button>
            </section>
          )}
        </>
      )}
    </dialog>
  );
}
