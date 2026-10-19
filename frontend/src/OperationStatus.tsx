import { Chip } from "./ui";

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
}: {
  operations: StockOperation[];
}) {
  return (
    <section>
      <h3>库存同步</h3>
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
