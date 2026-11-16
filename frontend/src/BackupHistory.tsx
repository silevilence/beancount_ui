import { useEffect, useState } from "react";
import { api, reasonOf } from "./api";
import { stampOf } from "./format";
import { Chip, Empty, Notice } from "./ui";

interface BackupEvent {
  time: string;
  action: string;
  source: string;
  outcome: string;
  message: string;
  elapsed: number;
}

export default function BackupHistory({
  revision = "",
}: {
  revision?: string;
}) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<BackupEvent[]>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState("all");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<BackupEvent[]>("/sync/history", { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setEvents(data);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(reasonOf(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, revision, attempt]);
  const visible = events?.filter(
    (e) => filter === "all" || e.outcome === "failed",
  );
  return (
    <details
      className="backup-history"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>查看备份日志</summary>
      {open && (
        <>
          <p className="muted small">
            最近 200
            条，按时间从新到旧。记录手动预览、手动及自动备份结果；升级前的运行记录无法补录。日志保存在本机，不随账本上传。
          </p>
          <div className="toolbar">
            <label>
              日志筛选
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">全部结果</option>
                <option value="failed">仅失败</option>
              </select>
            </label>
            <button
              className="ghost small"
              disabled={loading}
              onClick={() => setAttempt((n) => n + 1)}
            >
              {loading ? "正在读取日志…" : "刷新日志"}
            </button>
          </div>
          {error && (
            <Notice tone="error">
              日志读取失败：{error}。请重试刷新日志。
              {events && "以下为上次读取的记录。"}
            </Notice>
          )}
          {!loading && !error && !visible?.length && (
            <Empty>
              {events?.length
                ? "没有失败的备份记录。"
                : "暂无备份日志。下次预览或备份后，结果会显示在这里。"}
            </Empty>
          )}
          <div
            className="backup-history-list"
            role="region"
            aria-label="备份日志记录"
            tabIndex={0}
          >
            {visible?.map((event, index) => (
              <article className="inventory-row" key={`${event.time}:${index}`}>
                <div className="toolbar">
                  <strong>
                    {event.action === "preview"
                      ? "备份预览"
                      : event.action === "check"
                        ? "自动检查"
                        : "同步备份"}
                  </strong>
                  <Chip
                    tone={
                      event.outcome === "failed"
                        ? "expense"
                        : event.outcome === "success"
                          ? "ok"
                          : "muted"
                    }
                  >
                    {event.outcome === "failed"
                      ? "失败"
                      : event.outcome === "success"
                        ? "成功"
                        : "跳过"}
                  </Chip>
                  <span className="muted small">
                    {event.source === "automatic" ? "自动" : "手动"} ·{" "}
                    {stampOf(event.time)} · {event.elapsed} 秒
                  </span>
                </div>
                <p>{event.message}</p>
              </article>
            ))}
          </div>
        </>
      )}
    </details>
  );
}
