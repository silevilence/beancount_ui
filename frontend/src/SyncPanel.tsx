import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Diagnostic } from "./api";

interface Status {
  connected: boolean;
  enabled: boolean;
  remote?: string;
  branch: string;
  error?: string;
  message?: string;
  sync?: string;
  last_success?: string;
  ahead?: number | null;
  interval?: number;
  quiet?: number;
  schedule_reason?: string;
  changes: { file: string; status: string }[];
}
interface Preview {
  revision: string;
  remote: string;
  branch: string;
  unreferenced: string[];
  changes: Status["changes"];
  errors: Diagnostic[];
  diff: string;
}
interface BackupPreview {
  revision: string;
  head: string;
  files: string[];
  excluded: string[];
  message: string;
  diff: string;
}
export default function SyncPanel({
  onChanged,
}: {
  onChanged: () => Promise<void>;
}) {
  const [status, setStatus] = useState<Status>();
  const [preview, setPreview] = useState<Preview>();
  const [backup, setBackup] = useState<BackupPreview>();
  const [include, setInclude] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [interval, setIntervalSeconds] = useState(300);
  const [quiet, setQuiet] = useState(60);
  const editedSchedule = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const result = await api<Status>("/sync");
      setStatus(result);
      if (!editedSchedule.current) {
        setIntervalSeconds(result.interval ?? 300);
        setQuiet(result.quiet ?? 60);
      }
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(t);
  }, [refresh]);
  async function act(path: string, body = {}) {
    setBusy(true);
    setError("");
    try {
      const result = await api<Preview & BackupPreview>(`/sync/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (path === "preview" || path === "clone") setPreview(result);
      else if (path === "backup-preview") setBackup(result);
      else {
        setPreview(undefined);
        setBackup(undefined);
        setInclude([]);
        await onChanged();
      }
      if (path === "schedule") editedSchedule.current = false;
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel card sync-panel" aria-label="账本备份">
      <h2>GitHub 备份</h2>
      <p>本地保存与远端备份分别确认。</p>
      {status && (
        <>
          <p>
            {status.connected ? "已接入" : "尚未接入"} · {status.branch}
          </p>
          <p className="muted">{status.remote}</p>
          <p role="status">{status.message || "自动备份关闭"}</p>
          <p>{status.sync}</p>
          <p>未推送提交：{status.ahead ?? "尚未核验"}（本地远端引用）</p>
          {status.error && <p>{status.error}</p>}
          <p>
            最后成功：
            {status.last_success
              ? new Date(status.last_success).toLocaleString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                })
              : "尚无"}
          </p>
        </>
      )}
      {error && (
        <p role="alert">
          备份操作失败：{error}。已保存的记录仍在本地，请勿重复录入。
        </p>
      )}
      <div className="button-row">
        <button
          disabled={busy}
          onClick={() => void act("preview", { revision: "", include })}
        >
          预览接入范围
        </button>
        {!status?.connected && (
          <button disabled={busy} onClick={() => void act("clone")}>
            克隆到空目录
          </button>
        )}
        {status?.connected && (
          <button disabled={busy} onClick={() => void act("backup-preview")}>
            立即同步
          </button>
        )}
      </div>
      {status?.connected && (
        <fieldset disabled={busy}>
          <legend>定时备份 · {status.enabled ? "已开启" : "已关闭"}</legend>
          <label>
            检查间隔（秒）
            <input
              type="number"
              min="5"
              max="86400"
              value={interval}
              onChange={(e) => {
                editedSchedule.current = true;
                setIntervalSeconds(Number(e.target.value));
              }}
            />
          </label>
          <label>
            保存后等待（秒）
            <input
              type="number"
              min="0"
              max="3600"
              value={quiet}
              onChange={(e) => {
                editedSchedule.current = true;
                setQuiet(Number(e.target.value));
              }}
            />
          </label>
          <button
            onClick={() =>
              void act("schedule", { enabled: true, interval, quiet })
            }
          >
            启用 / 更新定时备份
          </button>
          <button
            disabled={!status.enabled}
            onClick={() =>
              void act("schedule", { enabled: false, interval, quiet })
            }
          >
            关闭定时备份
          </button>
          <p>{status.schedule_reason}</p>
        </fieldset>
      )}
      {backup && (
        <div>
          <p>{backup.message}</p>
          <p>纳入：{backup.files.join("、") || "无新变更（检查未推送提交）"}</p>
          <p>排除：{backup.excluded.join("、") || "无"}</p>
          <pre>{backup.diff}</pre>
          <button
            disabled={busy}
            onClick={() =>
              void act("backup", {
                revision: backup.revision,
                head: backup.head,
              })
            }
          >
            确认校验并推送
          </button>
        </div>
      )}
      {preview && (
        <div>
          <p>
            {preview.remote} · {preview.branch}
          </p>
          <ul>
            {preview.changes.map((c) => (
              <li key={c.file}>
                {c.status} {c.file}
              </li>
            ))}
          </ul>
          {preview.unreferenced.map((name) => (
            <label key={name}>
              <input
                type="checkbox"
                checked={include.includes(name)}
                onChange={(e) => {
                  setInclude(
                    e.target.checked
                      ? [...include, name]
                      : include.filter((n) => n !== name),
                  );
                  setPreview(undefined);
                }}
              />
              纳入 include：{name}
            </label>
          ))}
          <pre>{preview.diff}</pre>
          {preview.errors.map((e, i) => (
            <p key={i}>
              {e.file}:{e.line} {e.message}
            </p>
          ))}
          <button
            disabled={busy || preview.errors.length > 0}
            onClick={() =>
              void act("connect", { revision: preview.revision, include })
            }
          >
            确认接入（保持自动备份关闭）
          </button>
        </div>
      )}
    </section>
  );
}
