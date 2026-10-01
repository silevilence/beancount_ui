import { useEffect, useRef, useState } from "react";
import { api, reasonOf, type LedgerStatus } from "./api";
import Diff from "./Diff";
import RouteEditor from "./RouteEditor";
import { clockOf, shanghaiToday } from "./format";
import { Chip, Notice } from "./ui";
import {
  changedRoutes,
  pathIssue,
  routeLabel,
  routeIssues,
  type Layout,
} from "./businessConfig";

export type { Layout } from "./businessConfig";

interface Configuration {
  layout: Layout;
  default: Layout;
  version?: string;
  write_day?: string;
}
interface Preview {
  token: string;
  routes: { business: string; target: string; chain: string[] }[];
  diffs: Record<string, string>;
  files?: string[];
  write_day?: string;
}

const NEW_BUSINESS = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * 文件布局与业务模板：左侧业务列表 + 右侧编辑面板，
 * 预览与启用固定在底部操作栏，未启用的修改在关闭前需要确认。
 */
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
  const [selected, setSelected] = useState("overview");
  const [day, setDay] = useState(shanghaiToday);
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [confirm, setConfirm] = useState<
    "close" | "default" | "reset" | "remove" | ""
  >("");
  const [newBusiness, setNewBusiness] = useState("");
  const [addError, setAddError] = useState("");
  const [files, setFiles] = useState<string[]>();
  const [previewedAt, setPreviewedAt] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    void api<Configuration>("/layout")
      .then((value) => {
        if (!active) return;
        setConfig(value);
        setLayout(value.layout);
      })
      .catch((e) => {
        if (active) setError(reasonOf(e));
      });
    // 现有文件用于标记包含链中的「新建」步骤；读取失败不阻塞配置编辑。
    void api<LedgerStatus>("/ledger")
      .then((value) => {
        if (active) setFiles(value.files ?? []);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const original = config?.layout;
  const writeDay = config?.write_day || shanghaiToday();
  const dirty =
    !!layout && !!original && JSON.stringify(layout) !== JSON.stringify(original);
  const changed = dirty ? changedRoutes(original, layout) : [];
  // 提交期间的最新输入，用于丢弃过期的预览或启用结果。
  const current = useRef({ day, layout: "" });
  const entryIssue = layout ? pathIssue(layout.entry, false) : "";
  const issues: Record<string, string[]> = {};
  if (layout)
    for (const key of Object.keys(layout.routes))
      issues[key] = routeIssues(layout, key, day, writeDay);
  const flagged = Object.entries(issues).filter(([, list]) => list.length > 0);
  const status = busy
    ? "正在与服务器核对…"
    : preview
      ? `预览有效 · ${previewedAt}`
      : dirty
        ? "有未预览的修改"
        : enabled
          ? "已启用，可继续调整后重新预览"
          : "与当前生效配置一致";
  function change(value: Layout) {
    setLayout(value);
    setPreview(undefined);
    setError("");
    setNotice("");
    setEnabled(false);
    setConfirm("");
  }
  function requestClose() {
    if (busy) return;
    if (dirty) {
      setConfirm("close");
      return;
    }
    onClose();
  }
  function addBusiness() {
    if (!layout) return;
    const key = newBusiness.trim();
    if (!NEW_BUSINESS.test(key) || layout.routes[key]) {
      setAddError(
        "请输入未使用的业务标识：小写字母开头，可含数字、下划线和连字符",
      );
      return;
    }
    setAddError("");
    change({
      ...layout,
      routes: {
        ...layout.routes,
        [key]: {
          target: `business/${key}.bean`,
          indexes: [],
          date_source: "record",
          label: "",
          kind: "ordinary",
        },
      },
    });
    setNewBusiness("");
    setSelected(key);
  }
  // 提交期间可能修改预览日期；响应返回时确认输入仍是同一份配置。
  function normalize(value: Layout): Layout {
    return {
      ...value,
      routes: Object.fromEntries(
        Object.entries(value.routes).map(([key, route]) => [
          key,
          {
            ...route,
            indexes: route.indexes.map((path) => path.trim()).filter(Boolean),
          },
        ]),
      ),
    };
  }
  current.current = {
    day,
    layout: layout ? JSON.stringify(normalize(layout)) : "",
  };
  async function submit(enable: boolean) {
    if (!layout) return;
    setBusy(true);
    setError("");
    setNotice("");
    const proposed = normalize(layout);
    const sent = { day, layout: JSON.stringify(proposed) };
    try {
      const result = await api<Preview>(
        `/layout/${enable ? "activate" : "preview"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            layout: proposed,
            day,
            token: enable ? preview?.token : "",
          }),
        },
      );
      const stale =
        current.current.day !== sent.day ||
        current.current.layout !== sent.layout;
      if (enable) {
        setPreview(undefined);
        setConfig((value) => (value ? { ...value, layout: proposed } : value));
        setEnabled(true);
        if (stale) {
          setNotice("布局已启用；请求期间的新修改尚未启用，请重新预览。");
        } else {
          setLayout(proposed);
          setNotice("布局已启用，历史文件保持原位。");
        }
        await onChanged();
      } else if (stale) {
        setPreview(undefined);
        setNotice("预览期间有新的修改，请重新预览。");
      } else {
        setPreview(result);
        setPreviewedAt(clockOf(new Date()));
      }
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
      aria-labelledby="layout-title"
      onCancel={(e) => {
        e.preventDefault();
        requestClose();
      }}
      onKeyDown={(e) => {
        if (e.ctrlKey && e.key === "Enter" && !busy) {
          e.preventDefault();
          void submit(false);
        }
      }}
    >
      <header className="editor-head">
        <div>
          <p className="eyebrow">账本设置 / 业务路由</p>
          <h2 id="layout-title">文件布局与业务模板</h2>
        </div>
        <div className="editor-side">
          <span className="layout-flags">
            {dirty && <Chip tone="warn">{changed.length || "入口"} 项修改待启用</Chip>}
            {enabled && <Chip tone="ok">已更新</Chip>}
          </span>
          <button className="ghost small" disabled={busy} onClick={requestClose}>
            关闭布局
          </button>
        </div>
      </header>
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {confirm === "close" && (
        <Notice
          action={
            <>
              <button
                className="ghost small"
                onClick={() => setConfirm("")}
              >
                继续编辑
              </button>
              <button className="ghost small" onClick={onClose}>
                放弃修改并关闭
              </button>
            </>
          }
        >
          有 {changed.length || 1} 项未启用的修改，关闭后会被丢弃。
        </Notice>
      )}
      {!layout && !error && <p className="muted">正在读取布局配置…</p>}
      {layout && config && (
        <>
          <fieldset className="layout-body" disabled={busy}>
            <nav className="layout-rail" aria-label="业务列表">
              <button
                type="button"
                className="route-item"
                aria-current={selected === "overview"}
                onClick={() => setSelected("overview")}
              >
                <span className="route-name">概览与入口</span>
                <small>
                  {Object.keys(layout.routes).length} 个业务 · {layout.entry}
                </small>
                {entryIssue && <Chip tone="warn">入口待修正</Chip>}
              </button>
              {Object.entries(layout.routes).map(([key, route]) => (
                <button
                  type="button"
                  className="route-item"
                  key={key}
                  aria-current={selected === key}
                  onClick={() => setSelected(key)}
                >
                  <span className="route-name">
                    {routeLabel(key, route.label)}
                    {changed.includes(key) && (
                      <i className="dirty-dot" title="有未启用的修改" />
                    )}
                  </span>
                  <small>{route.target || "未填写目标文件"}</small>
                  <span className="route-tags">
                    {route.template && <Chip tone="ok">模板</Chip>}
                    {route.date_source === "write" && (
                      <Chip tone="transfer">写入日期</Chip>
                    )}
                    {issues[key]?.length > 0 && (
                      <Chip tone="warn">{issues[key].length} 项待修正</Chip>
                    )}
                  </span>
                </button>
              ))}
              <div className="route-add">
                <label className="field">
                  <span>新增业务</span>
                  <input
                    aria-label="新增业务标识"
                    placeholder="例如 lunch"
                    value={newBusiness}
                    onChange={(e) => {
                      setNewBusiness(e.target.value);
                      setAddError("");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addBusiness();
                      }
                    }}
                  />
                </label>
                <small className="muted">
                  小写字母开头，可含数字、下划线和连字符。添加后设置名称、文件与记录模板。
                </small>
                {addError && <p className="field-hint warn">{addError}</p>}
                <button
                  type="button"
                  className="ghost small"
                  onClick={addBusiness}
                >
                  添加业务
                </button>
              </div>
            </nav>
            <section className="layout-detail" aria-label="业务配置">
              {confirm === "remove" && selected !== "overview" && (
                <Notice
                  action={
                    <>
                      <button
                        className="ghost small"
                        onClick={() => {
                          change({
                            ...layout,
                            routes: Object.fromEntries(
                              Object.entries(layout.routes).filter(
                                ([key]) => key !== selected,
                              ),
                            ),
                          });
                          setSelected("overview");
                        }}
                      >
                        确认移除
                      </button>
                      <button
                        className="ghost small"
                        onClick={() => setConfirm("")}
                      >
                        保留
                      </button>
                    </>
                  }
                >
                  移除「{routeLabel(selected, layout.routes[selected]?.label)}」后，
                  新记录不再写入该文件；历史记录与旧文件保持原位。
                </Notice>
              )}
              {selected === "overview" ? (
                <>
                  <div className="work-head">
                    <h3>业务与文件总览</h3>
                    <span className="panel-meta">
                      {changed.length > 0
                        ? `${changed.length} 个业务待启用`
                        : "当前编辑与生效配置一致"}
                    </span>
                  </div>
                  <label className="field">
                    <span>账本入口</span>
                    <input
                      aria-label="账本入口"
                      value={layout.entry}
                      onChange={(e) => change({ ...layout, entry: e.target.value })}
                    />
                    <small>
                      入口须已存在并包含全部历史账本；当前生效入口为{" "}
                      {original?.entry}。
                    </small>
                  </label>
                  {entryIssue && (
                    <p className="field-hint warn">入口：{entryIssue}</p>
                  )}
                  <table className="route-table">
                    <thead>
                      <tr>
                        <th>业务</th>
                        <th>目标文件</th>
                        <th>包含链</th>
                        <th>表单</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(layout.routes).map(([key, route]) => (
                        <tr
                          key={key}
                          className={changed.includes(key) ? "changed" : ""}
                        >
                          <td>
                            <button
                              type="button"
                              className="ghost small"
                              onClick={() => setSelected(key)}
                            >
                              {routeLabel(key, route.label)}
                            </button>
                            {issues[key]?.length > 0 && (
                              <Chip tone="warn">待修正</Chip>
                            )}
                          </td>
                          <td>
                            <code>{route.target}</code>
                          </td>
                          <td>
                            <code>
                              {[
                                layout.entry,
                                ...route.indexes,
                                route.target,
                              ].join(" → ")}
                            </code>
                          </td>
                          <td>
                            {route.template ? "记录模板" : "内置表单"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {flagged.length > 0 && (
                    <Notice tone="warn">
                      <span>以下业务需要修正：</span>
                      <ul className="issue-list">
                        {flagged.map(([key, list]) => (
                          <li key={key}>
                            <button
                              type="button"
                              className="ghost small"
                              onClick={() => setSelected(key)}
                            >
                              {routeLabel(key, layout.routes[key].label)}
                            </button>
                            {list[0]}
                            {list.length > 1 && `（共 ${list.length} 项）`}
                          </li>
                        ))}
                      </ul>
                    </Notice>
                  )}
                  <div className="toolbar">
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => setConfirm("default")}
                    >
                      填入默认 MyBill 布局
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      disabled={!dirty}
                      onClick={() => setConfirm("reset")}
                    >
                      还原为当前生效配置
                    </button>
                  </div>
                  {confirm === "default" && (
                    <Notice
                      action={
                        <>
                          <button
                            className="ghost small"
                            onClick={() => {
                              change(config.default);
                              setSelected("overview");
                            }}
                          >
                            确认填入
                          </button>
                          <button
                            className="ghost small"
                            onClick={() => setConfirm("")}
                          >
                            取消
                          </button>
                        </>
                      }
                    >
                      默认 MyBill 布局会替换当前编辑内容，仍需预览并启用后才生效。
                    </Notice>
                  )}
                  {confirm === "reset" && (
                    <Notice
                      action={
                        <>
                          <button
                            className="ghost small"
                            onClick={() => {
                              change(config.layout);
                              setSelected("overview");
                            }}
                          >
                            确认还原
                          </button>
                          <button
                            className="ghost small"
                            onClick={() => setConfirm("")}
                          >
                            取消
                          </button>
                        </>
                      }
                    >
                      放弃未启用的修改，恢复为当前生效配置。
                    </Notice>
                  )}
                </>
              ) : (
                <RouteEditor
                  layout={layout}
                  business={selected}
                  original={original?.routes[selected]}
                  day={day}
                  writeDay={writeDay}
                  files={files}
                  issues={issues[selected] ?? []}
                  onChange={change}
                  onRemove={() => setConfirm("remove")}
                />
              )}
            </section>
          </fieldset>
          {preview && (
            <section className="layout-preview" aria-label="布局预览">
              <div className="preview-head">
                <h3>布局预览 · 已校验</h3>
                <span className="target">
                  {preview.routes.length} 个业务 ·{" "}
                  {Object.keys(preview.diffs).length} 个文件变更
                </span>
              </div>
              <p className="muted small">
                预览基于账本当前内容与 {day}；启用只更新布局配置，示例文件与
                include 会在保存新记录时才写入。
                {preview.write_day &&
                  ` 使用实际写入日期的业务按 ${preview.write_day} 生成。`}
              </p>
              <div className="preview-routes">
                {preview.routes.map((route) => (
                  <button
                    type="button"
                    className="preview-route"
                    key={route.business}
                    onClick={() => setSelected(route.business)}
                  >
                    <strong>
                      {routeLabel(
                        route.business,
                        layout.routes[route.business]?.label,
                      )}
                    </strong>
                    <code>{route.target}</code>
                    <small>{route.chain.join(" → ")}</small>
                  </button>
                ))}
              </div>
              <details>
                <summary>
                  查看 include 示例差异（{Object.keys(preview.diffs).length} 个文件）
                </summary>
                {Object.entries(preview.diffs).map(([name, diff]) => (
                  <section className="file-card" key={name}>
                    <h4>
                      {name}
                      {files && !files.includes(name) ? "（新建）" : ""}
                    </h4>
                    <Diff diff={diff} />
                  </section>
                ))}
                {Object.keys(preview.diffs).length === 0 && (
                  <p className="muted">没有需要新建或修改的 include。</p>
                )}
              </details>
            </section>
          )}
          <div className="layout-actions">
            <label className="field inline">
              <span>预览交易日期</span>
              <input
                aria-label="预览交易日期"
                type="date"
                value={day}
                onChange={(e) => {
                  setDay(e.target.value);
                  setPreview(undefined);
                  setNotice("");
                }}
              />
            </label>
            <span className="layout-status" role="status">
              {status}
            </span>
            <div className="toolbar push-end">
              {preview && (
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() => setPreview(undefined)}
                >
                  取消预览
                </button>
              )}
              <button
                type="button"
                disabled={busy || !day}
                title="Ctrl+Enter"
                onClick={() => void submit(false)}
              >
                检查并预览布局
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || !preview}
                title={preview ? "写入布局配置" : "先检查并预览"}
                onClick={() => void submit(true)}
              >
                启用此布局
              </button>
            </div>
          </div>
        </>
      )}
    </dialog>
  );
}
