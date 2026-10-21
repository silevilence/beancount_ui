import { Chip } from "./ui";
import { useState } from "react";
import { post } from "./api";
import { reasonOf } from "./api";
import { Notice } from "./ui";

export interface StockOperation {
  id: string;
  status: string;
  error: string;
  evidence?: Record<string, unknown>;
  product_id?: number;
  action?: string;
  payload?: Record<string, unknown>;
  open_target_location_id?: number | null;
}
export const syncLabels: Record<string, string> = {
  pending: "待同步",
  sending: "正在发送 / 结果待确认",
  unknown: "结果待确认",
  failed: "明确未发送",
  success: "同步成功",
  conflict: "需要人工核对",
  undone: "远端已撤销",
  cancelled: "已停止操作",
  resolved: "已人工核实",
  undoing: "撤销结果待确认",
  draft: "尚未确认",
};
export const settledStatuses = new Set([
  "success",
  "undone",
  "cancelled",
  "resolved",
]);
export function needsSyncReview(status: string) {
  return !settledStatuses.has(status);
}
export function orderSyncLabel(operations: { status: string }[] = []): string {
  if (!operations.length) return "尚无库存操作";
  const unsettled = operations.filter((o) => needsSyncReview(o.status));
  if (unsettled.length)
    return `同步待处理 ${unsettled.length}/${operations.length}`;
  if (operations.every((o) => o.status === "success")) return "库存同步成功";
  return "库存操作已处理（含撤销或人工处理）";
}

export default function OperationStatus({
  operations,
  onChanged,
  title = "库存同步",
}: {
  operations: StockOperation[];
  onChanged?: () => Promise<void>;
  title?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function resolve(id: string, applied: boolean) {
    const reason = window.prompt(
      "请填写人工核对依据（至少 10 字），说明远端日志、批次及原执行已停止的证据：",
    );
    if (
      !reason ||
      reason.trim().length < 10 ||
      !window.confirm(
        applied
          ? "确认已经核实远端操作完整生效？这里只保存结论，不操作库存。"
          : "确认原执行已停止？这里只关闭追踪，不操作库存；已有库存需另行更正。",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await post(`/grocy/operations/${id}/resolve`, {
        reason,
        applied,
        original_stopped: true,
      });
      await onChanged?.();
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      setBusy(false);
    }
  }
  async function action(id: string, retry = false) {
    if (busy) return;
    let body: Record<string, unknown> = {};
    if (retry) {
      const reason = window.prompt(
        "仅在已核实原请求停止、没有任何入库时重发。查无日志本身不是证明；仍有重复入库风险。请填写核对依据（至少 10 字）：",
      );
      if (!reason || reason.trim().length < 10) return;
      if (
        !window.confirm(
          "确认已核实原执行不会继续，且没有产生库存写入？系统将再次查日志，再沿用原编号发送。",
        )
      )
        return;
      body = { reason, original_stopped: true, no_effect: true };
    }
    setBusy(true);
    setError("");
    try {
      await post(`/grocy/operations/${id}/${retry ? "retry" : "check"}`, body);
      await onChanged?.();
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h3>{title}</h3>
      {error && <Notice tone="error">{error}</Notice>}
      {!operations.length && <p className="muted">暂无库存操作。</p>}
      {operations.map((o) => (
        <article className="inventory-row" key={o.id}>
          <Chip
            tone={
              o.status === "success"
                ? "ok"
                : o.status === "conflict"
                  ? "danger"
                  : "warn"
            }
          >
            {syncLabels[o.status] ?? o.status}
          </Chip>
          <small>操作编号 {o.id}</small>
          {o.error && <p>{o.error}</p>}
          {onChanged && (
            <div className="toolbar">
              {["unknown", "conflict", "undoing"].includes(o.status) && (
                <>
                  <button
                    disabled={busy}
                    className="ghost small"
                    onClick={() => void resolve(o.id, true)}
                  >
                    记录人工核实成功
                  </button>
                  <button
                    disabled={busy}
                    className="ghost small"
                    onClick={() => void resolve(o.id, false)}
                  >
                    人工核对后停止
                  </button>
                </>
              )}
              <button
                disabled={busy}
                className="ghost small"
                onClick={() => void action(o.id)}
              >
                核对最新日志与库存
              </button>
              {["unknown", "failed", "conflict", "sending"].includes(
                o.status,
              ) && (
                <button
                  disabled={busy}
                  className="ghost small"
                  onClick={() => void action(o.id, true)}
                >
                  人工核实后重发
                </button>
              )}
            </div>
          )}
          <details>
            <summary>核对证据</summary>
            <pre className="changes">
              {JSON.stringify(o.evidence ?? {}, null, 2)}
            </pre>
          </details>
        </article>
      ))}
    </section>
  );
}
