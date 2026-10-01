import { useEffect, useRef, useState } from "react";
import { api, reasonOf } from "./api";
import Diff from "./Diff";
import {
  changeLabel,
  refreshSync,
  trimReason,
  useSyncSnapshot,
  type BackupPreview,
  type ConnectPreview,
  type SyncStatus,
} from "./syncStatus";
import { stampOf, timeAgo, untilWhen } from "./format";
import { Chip, Empty, Facts, Notice, Segmented, Toolbar } from "./ui";

const INTERVAL_PRESETS = [
  { value: "60", label: "1 分钟" },
  { value: "300", label: "5 分钟" },
  { value: "900", label: "15 分钟" },
  { value: "3600", label: "1 小时" },
];

function Changes({ changes }: { changes: SyncStatus["changes"] }) {
  if (!changes.length)
    return <p className="muted small">没有未提交的文件变更。</p>;
  return (
    <ul className="change-list">
      {changes.map((item) => (
        <li key={item.file}>
          <span className="file">{item.file}</span>
          <Chip tone="muted">{changeLabel(item.status)}</Chip>
        </li>
      ))}
    </ul>
  );
}

/** 备份中心：接入、手动同步与定时备份共用一个对话框，所有操作都先预览再确认。 */
export default function SyncDialog({
  auto,
  onChanged,
  onClose,
}: {
  auto?: boolean;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const { status, error: statusError } = useSyncSnapshot();
  const [preview, setPreview] = useState<ConnectPreview>();
  const [backup, setBackup] = useState<BackupPreview>();
  const [include, setInclude] = useState<string[]>([]);
  const [includeStale, setIncludeStale] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState("");
  const [interval, setIntervalSeconds] = useState(300);
  const [quiet, setQuiet] = useState(60);
  const editedSchedule = useRef(false);
  const [proxyMode, setProxyMode] = useState("system");
  const [proxyUrl, setProxyUrl] = useState("");
  const editedProxy = useRef(false);
  const autoStarted = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);

  function close() {
    dialog.current?.close();
    onClose();
  }
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (!editedSchedule.current && status) {
      setIntervalSeconds(status.interval ?? 300);
      setQuiet(status.quiet ?? 60);
    }
  }, [status]);
  useEffect(() => {
    if (!editedProxy.current && status) {
      setProxyMode(status.proxy_mode ?? "system");
      setProxyUrl(status.proxy_url ?? "");
    }
  }, [status]);

  async function post<T>(
    path: string,
    body: Record<string, unknown> = {},
  ): Promise<T> {
    return api<T>(`/sync/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async function run(path: string, work: () => Promise<void>) {
    setBusy(true);
    setAction(path);
    setError("");
    setDone("");
    try {
      await work();
      await refreshSync();
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      setBusy(false);
      setAction("");
    }
  }
  function previewConnect() {
    return run("preview", async () => {
      setPreview(
        await post<ConnectPreview>("preview", { revision: "", include }),
      );
      setIncludeStale(false);
    });
  }
  function cloneRepo() {
    return run("clone", async () => {
      setPreview(await post<ConnectPreview>("clone"));
      setIncludeStale(false);
    });
  }
  function previewBackup() {
    return run("backup-preview", async () => {
      setBackup(await post<BackupPreview>("backup-preview"));
    });
  }
  function confirmBackup() {
    if (!backup) return;
    return run("backup", async () => {
      const result = await post<SyncStatus>("backup", {
        revision: backup.revision,
        head: backup.head,
      });
      setBackup(undefined);
      setPreview(undefined);
      setInclude([]);
      setDone(
        `已同步；最后成功 ${stampOf(result.last_success ?? "") || "刚刚"}，可以关闭备份中心。`,
      );
      await onChanged();
    });
  }
  function confirmConnect() {
    if (!preview) return;
    return run("connect", async () => {
      await post<SyncStatus>("connect", {
        revision: preview.revision,
        include,
      });
      setPreview(undefined);
      setInclude([]);
      setIncludeStale(false);
      setDone("接入完成；自动备份保持关闭，可在「定时备份」中单独开启。");
      await onChanged();
    });
  }
  function saveSchedule(enabled: boolean) {
    return run("schedule", async () => {
      await post<SyncStatus>("schedule", { enabled, interval, quiet });
      editedSchedule.current = false;
      setDone(enabled ? "定时备份已更新。" : "定时备份已关闭。");
    });
  }
  function saveProxy() {
    return run("proxy", async () => {
      await post("proxy", {
        mode: proxyMode,
        url: proxyMode === "custom" ? proxyUrl.trim() : "",
      });
      editedProxy.current = false;
      setDone("代理设置已保存，下次连接 GitHub 时生效；可重新尝试克隆或同步。");
    });
  }
  // 「立即同步」直接进入预览，省去再点一次；只在打开时执行一次。
  useEffect(() => {
    if (!auto || autoStarted.current || !status?.connected) return;
    autoStarted.current = true;
    void previewBackup();
  }, [auto, status?.connected]);

  const connected = !!status?.connected;
  const pendingCount = backup?.outgoing_count ?? null;
  return (
    <dialog
      ref={dialog}
      className="editor-dialog backup-dialog"
      aria-label="备份中心"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <header className="editor-head">
        <div>
          <p className="eyebrow">GITHUB BACKUP / 远端备份</p>
          <h2>备份中心</h2>
        </div>
        <div className="editor-side">
          <Chip tone={connected ? "transfer" : "muted"}>
            {status?.branch ?? "master-1"}
          </Chip>
          <button
            className="ghost small"
            onClick={close}
            disabled={busy}
            aria-label="关闭备份"
          >
            关闭
          </button>
        </div>
      </header>
      {status?.blocked && (
        <Notice tone="error">
          备份已暂停：
          {trimReason(status.error || "仓库仍有未完成的合并、变基或冲突")}
          。请先在账本目录人工核对与合并，保留需要的双方记录，完成 Git
          操作后回到本页重新预览并立即同步；应用不会强推、硬重置或自动选择一侧。
        </Notice>
      )}
      {status?.error && !status.blocked && !error && (
        <Notice
          tone="warn"
          action={
            <button
              className="ghost small"
              disabled={busy}
              onClick={() => void previewBackup()}
            >
              重试立即同步
            </button>
          }
        >
          最近一次备份未完成：{trimReason(status.error)}
          。已保存的记录仍在本地，请勿重复录入。
        </Notice>
      )}
      {error && (
        <Notice tone="error">
          备份操作失败：{trimReason(error)}
          。已保存的记录仍在本地，请勿重复录入。
        </Notice>
      )}
      {done && (
        <Notice>
          <Chip tone="ok">完成</Chip> {done}
        </Notice>
      )}
      <div className="backup-grid">
        <aside className="backup-side" aria-label="备份状态">
          <Facts
            items={[
              { label: "状态", value: status?.sync ?? "读取中" },
              {
                label: "远端",
                value: status?.remote || "未配置（服务端环境）",
              },
              {
                label: "待提交",
                value: `${status?.changes.length ?? 0} 个文件`,
              },
              {
                label: "未推送",
                value:
                  status?.ahead === null || status?.ahead === undefined
                    ? "需联网核验"
                    : `${status.ahead} 个提交`,
              },
              {
                label: "最后成功",
                value: status?.last_success
                  ? `${stampOf(status.last_success)} · ${timeAgo(status.last_success)}`
                  : "尚无",
              },
              {
                label: "下次检查",
                value: !status?.enabled
                  ? "已关闭"
                  : status.next_check
                    ? untilWhen(status.next_check)
                    : "等待调度",
              },
            ]}
          />
          {!!status?.failures && (
            <p className="muted small">
              <Chip tone="warn">连续失败 {status.failures} 次</Chip>{" "}
              网络或服务失败会按上限退避重试，重启后继续补推。
            </p>
          )}
          {status?.schedule_reason && (
            <p className="muted small">调度：{status.schedule_reason}</p>
          )}
          <h4>未提交变更</h4>
          <Changes changes={status?.changes ?? []} />
          {statusError && (
            <p className="muted small">状态读取失败：{statusError}</p>
          )}
        </aside>
        <section className="backup-work">
          <section className="work-area" aria-label="网络代理">
            <div className="work-head">
              <h3>网络代理</h3>
              <p>
                用于 HTTPS 仓库的克隆、接入检查和备份；SSH 仓库使用服务端 SSH
                配置。
              </p>
            </div>
            <label className="field">
              代理模式
              <select
                value={proxyMode}
                disabled={busy}
                onChange={(e) => {
                  editedProxy.current = true;
                  setProxyMode(e.target.value);
                }}
              >
                <option value="system">跟随服务端配置</option>
                <option value="direct">直连（不使用 HTTP 代理）</option>
                <option value="custom">自定义代理</option>
              </select>
            </label>
            {proxyMode === "custom" && (
              <label className="field">
                代理服务器地址
                <input
                  type="url"
                  placeholder="http://192.168.1.10:7890"
                  autoComplete="off"
                  disabled={busy}
                  value={proxyUrl}
                  onChange={(e) => {
                    editedProxy.current = true;
                    setProxyUrl(e.target.value);
                  }}
                />
              </label>
            )}
            <p className="muted small">
              支持 HTTP、HTTPS、SOCKS5、SOCKS5H；地址不含用户名或密码。 NAS /
              Docker 请填写容器可访问的代理地址，127.0.0.1 指向容器自身。
              修改后先保存，再重试备份；详细错误可在服务端控制台或容器日志查看。
            </p>
            <Toolbar>
              <button
                disabled={busy || (proxyMode === "custom" && !proxyUrl.trim())}
                onClick={() => void saveProxy()}
              >
                {action === "proxy" ? "正在保存…" : "保存代理设置"}
              </button>
            </Toolbar>
          </section>
          {connected ? (
            <section className="work-area" aria-label="手动同步">
              <div className="work-head">
                <h3>手动同步</h3>
                <p>
                  只提交账本与必要索引；日志、缓存与草稿不参与，无变更不会创建空提交。
                </p>
              </div>
              <Toolbar>
                <button disabled={busy} onClick={() => void previewBackup()}>
                  {action === "backup-preview" ? "正在校验…" : "立即同步"}
                </button>
                {backup && (
                  <button
                    className="ghost"
                    disabled={busy}
                    onClick={() => void previewBackup()}
                  >
                    重新预览
                  </button>
                )}
              </Toolbar>
              {backup ? (
                <div className="preview-item">
                  <div className="preview-head">
                    <strong className="target">{backup.message}</strong>
                    <Chip tone={(pendingCount ?? 0) > 0 ? "warn" : "muted"}>
                      {pendingCount === null
                        ? "待推送数量需联网核验"
                        : `待推送提交 ${pendingCount}`}
                    </Chip>
                  </div>
                  <Facts
                    items={[
                      {
                        label: "纳入",
                        value: backup.files.join("、") || "无新变更",
                      },
                      {
                        label: "排除",
                        value: backup.excluded.join("、") || "无",
                      },
                      {
                        label: "待推送文件",
                        value: backup.outgoing_files?.join("、") || "无",
                      },
                    ]}
                  />
                  {backup.diff ? (
                    <Diff diff={backup.diff} />
                  ) : (
                    <p className="muted small">
                      没有文件差异；本次只会推送已验证的已有提交。
                    </p>
                  )}
                  <Toolbar>
                    <button
                      disabled={busy}
                      onClick={() => void confirmBackup()}
                    >
                      {action === "backup" ? "正在推送…" : "确认校验并推送"}
                    </button>
                  </Toolbar>
                </div>
              ) : (
                <Empty>
                  还没有预览。
                  <br />
                  <small>
                    点击「立即同步」查看将提交的文件、排除范围与差异，确认后才推送。
                  </small>
                </Empty>
              )}
            </section>
          ) : (
            <section className="work-area" aria-label="接入仓库">
              <div className="work-head">
                <h3>接入账本仓库</h3>
                <p>
                  前置条件：服务端配置远端地址与 Git 凭据；接入只补充
                  include，不覆盖既有文件。
                </p>
              </div>
              <ol className="steps" aria-label="接入步骤">
                {["核对远端", "预览范围", "确认接入"].map((name, index) => (
                  <li
                    key={name}
                    className={index === 0 || preview ? "done" : ""}
                  >
                    {name}
                  </li>
                ))}
              </ol>
              <Toolbar>
                <button disabled={busy} onClick={() => void previewConnect()}>
                  {action === "preview" ? "正在检查…" : "预览接入范围"}
                </button>
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={() => void cloneRepo()}
                >
                  {action === "clone" ? "正在克隆…" : "克隆到空目录"}
                </button>
              </Toolbar>
              <p className="muted small">
                已有本地副本使用「预览接入范围」；仅空目录可以克隆，应用不会覆盖非空目录或重新克隆。
              </p>
              {preview && (
                <div className="preview-item">
                  <div className="preview-head">
                    <strong className="target">{preview.remote}</strong>
                    <Chip tone="transfer">{preview.branch}</Chip>
                  </div>
                  <Facts
                    items={[
                      {
                        label: "既有变更",
                        value: `${preview.changes.length} 个文件`,
                      },
                      {
                        label: "未推送",
                        value:
                          preview.ahead === null || preview.ahead === undefined
                            ? "需联网核验"
                            : `${preview.ahead} 个提交`,
                      },
                    ]}
                  />
                  <Changes changes={preview.changes} />
                  {preview.unreferenced.length > 0 ? (
                    <div className="include-list">
                      <h4>未被 include 的账本文件</h4>
                      {preview.unreferenced.map((name) => (
                        <label key={name}>
                          <input
                            type="checkbox"
                            checked={include.includes(name)}
                            onChange={(e) => {
                              setIncludeStale(true);
                              setInclude(
                                e.target.checked
                                  ? [...include, name]
                                  : include.filter((item) => item !== name),
                              );
                            }}
                          />
                          {name}
                        </label>
                      ))}
                      <p className="muted small">
                        勾选后会把该文件追加到入口
                        include；改动选择后需要重新预览再确认。
                      </p>
                    </div>
                  ) : (
                    <p className="muted small">
                      所有账本文件都已被 include 覆盖。
                    </p>
                  )}
                  {preview.diff ? (
                    <Diff diff={preview.diff} />
                  ) : (
                    <p className="muted small">
                      入口文件没有 include
                      差异；勾选文件后重新预览即可看到改动。
                    </p>
                  )}
                  {preview.errors.length > 0 && (
                    <Notice tone="error">
                      {preview.errors.map((item, index) => (
                        <span className="diag" key={index}>
                          {item.file}:{item.line} · {item.message}
                        </span>
                      ))}
                    </Notice>
                  )}
                  {includeStale && (
                    <p className="muted small">
                      include 选择已变化，请重新预览后再确认接入。
                    </p>
                  )}
                  <Toolbar>
                    <button
                      disabled={
                        busy || preview.errors.length > 0 || includeStale
                      }
                      onClick={() => void confirmConnect()}
                    >
                      {action === "connect"
                        ? "正在接入…"
                        : "确认接入（保持自动备份关闭）"}
                    </button>
                    <button
                      className="ghost"
                      disabled={busy}
                      onClick={() => void previewConnect()}
                    >
                      重新预览
                    </button>
                  </Toolbar>
                </div>
              )}
            </section>
          )}
          {connected && (
            <section className="work-area" aria-label="定时备份">
              <div className="work-head">
                <h3>定时备份</h3>
                <p>
                  {status?.enabled
                    ? "按检查间隔发现账本变化；连续保存合并为一次提交，无变更不联网。"
                    : "关闭时只在手动「立即同步」中提交与推送。"}
                </p>
              </div>
              <Toolbar>
                <label className="switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={!!status?.enabled}
                    disabled={busy}
                    onChange={(e) => void saveSchedule(e.target.checked)}
                  />
                  自动备份
                </label>
                <Chip tone={status?.enabled ? "ok" : "muted"}>
                  {status?.enabled ? "已开启" : "已关闭"}
                </Chip>
              </Toolbar>
              <Segmented
                label="检查间隔预设"
                value={String(interval)}
                disabled={busy}
                options={INTERVAL_PRESETS}
                onChange={(value) => {
                  editedSchedule.current = true;
                  setIntervalSeconds(Number(value));
                }}
              />
              <div className="form-grid">
                <label className="field">
                  检查间隔（秒）
                  <input
                    type="number"
                    min="5"
                    max="86400"
                    disabled={busy}
                    value={interval}
                    onChange={(e) => {
                      editedSchedule.current = true;
                      setIntervalSeconds(Number(e.target.value));
                    }}
                  />
                </label>
                <label className="field">
                  保存后等待（秒）
                  <input
                    type="number"
                    min="0"
                    max="3600"
                    disabled={busy}
                    value={quiet}
                    onChange={(e) => {
                      editedSchedule.current = true;
                      setQuiet(Number(e.target.value));
                    }}
                  />
                </label>
              </div>
              <Toolbar>
                <button
                  disabled={busy}
                  onClick={() => void saveSchedule(!!status?.enabled)}
                >
                  {action === "schedule" ? "正在保存…" : "保存定时设置"}
                </button>
                <span className="muted small">
                  检查间隔 5—86400 秒，保存后等待 0—3600 秒
                </span>
              </Toolbar>
            </section>
          )}
        </section>
      </div>
    </dialog>
  );
}
