import { useState } from "react";
import { useReportResource } from "./statisticsData";
import { Empty, Notice } from "./ui";

interface LogPage {
  entries: Record<string, unknown>[];
  next_before: number | null;
  updated_at: string;
}
const actions: Record<string, string> = {
  purchase: "入库",
  consume: "消耗",
  "inventory-correction": "盘点调整",
  "product-opened": "开封",
  "transfer-from": "转出",
  "transfer-to": "转入",
  "stock-edit-old": "编辑前",
  "stock-edit-new": "编辑后",
};
export default function StockLog({
  products,
}: {
  products: { id: number; name: string }[];
}) {
  const [product, setProduct] = useState("");
  const [cursors, setCursors] = useState<(number | null)[]>([null]);
  const before = cursors[cursors.length - 1];
  const params = new URLSearchParams();
  if (product) params.set("product_id", product);
  if (before !== null) params.set("before", String(before));
  const resource = useReportResource<LogPage>(`/grocy/stock-log?${params}`, "");
  const page = resource.data;
  const display = (value: unknown) =>
    value == null || value === "" ? "—" : String(value);
  return (
    <section className="panel stock-log" aria-label="服务端库存日志">
      <div className="stats-panel-head">
        <h2>服务端库存日志</h2>
        <button
          className="ghost"
          disabled={resource.loading}
          onClick={() => {
            if (cursors.length > 1) setCursors([null]);
            else resource.retry();
          }}
        >
          刷新日志
        </button>
      </div>
      <p className="muted">
        包含 Grocy 和其他客户端产生的全部库存操作，按日志编号倒序，每页 100
        条。时间按服务端原值显示；历史范围以服务端保留的数据为准。
      </p>
      <label>
        日志产品
        <select
          value={product}
          onChange={(e) => {
            setProduct(e.target.value);
            setCursors([null]);
          }}
        >
          <option value="">全部产品</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {resource.error && (
        <Notice tone="error">
          {resource.error}
          {page && "。以下为上次读取的日志，请刷新后核对。"}
        </Notice>
      )}
      {resource.loading && <p role="status">正在读取服务端日志…</p>}
      {page && (
        <>
          <p className="muted">
            第 {cursors.length} 页 · {page.entries.length} 条 · 读取于{" "}
            {new Date(page.updated_at).toLocaleString("zh-CN")}
          </p>
          {!page.entries.length && <Empty>没有符合条件的库存日志。</Empty>}
          <div
            className="data-table-scroll"
            tabIndex={0}
            aria-label="库存日志表格，可横向滚动"
          >
            <table>
              <thead>
                <tr>
                  {["编号 / 时间", "产品", "动作", "数量", "状态", "详情"].map(
                    (s) => (
                      <th key={s}>{s}</th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {page.entries.map((row) => (
                  <tr key={String(row.id)}>
                    <td>
                      #{display(row.id)}
                      <br />
                      {display(
                        row.transaction_date || row.row_created_timestamp,
                      )}
                    </td>
                    <td>
                      {products.find(
                        (p) => String(p.id) === String(row.product_id),
                      )?.name || `产品 #${display(row.product_id)}`}
                    </td>
                    <td>
                      {actions[String(row.transaction_type)] ||
                        display(row.transaction_type)}
                    </td>
                    <td>{display(row.amount)}</td>
                    <td>
                      {Number(row.undone) === 1
                        ? "已撤销"
                        : Number(row.undo_stock_id) > 0
                          ? "撤销记录"
                          : "已记录"}
                    </td>
                    <td>
                      <details>
                        <summary>完整字段 #{display(row.id)}</summary>
                        <dl>
                          {Object.entries(row).map(([key, value]) => (
                            <div key={key}>
                              <dt>{key}</dt>
                              <dd>
                                {typeof value === "object" && value !== null
                                  ? JSON.stringify(value)
                                  : display(value)}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="actions">
        <button
          className="ghost"
          disabled={resource.loading || cursors.length === 1}
          onClick={() => setCursors(cursors.slice(0, -1))}
        >
          上一页日志
        </button>
        <button
          className="ghost"
          disabled={resource.loading || !!resource.error || !page?.next_before}
          onClick={() => setCursors([...cursors, page!.next_before])}
        >
          下一页日志
        </button>
      </div>
    </section>
  );
}
