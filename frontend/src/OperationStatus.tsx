import { Chip } from "./ui";
import { useState } from "react";
import { post } from "./GrocySettings";
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
};
export default function OperationStatus({
  operations,
  onChanged,
}: {
  operations: StockOperation[];
  onChanged?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
      <h3>库存同步</h3>
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
