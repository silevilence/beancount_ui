import { useEffect, useRef, useState } from "react";
import { post, reasonOf, type Journal } from "./api";
import { requestId } from "./requestId";
import { confirmEntryDates } from "./confirmEntryDates";
import type { ReceiptDraft } from "./receiptDraft";
import type { ReceiptPreview } from "./ReceiptEditor";
import Diff from "./Diff";
import OperationStatus from "./OperationStatus";
import { Notice } from "./ui";

interface BatchResult {
  request_id: string;
  status: string;
  financial: ReceiptPreview["financial"];
  receipts: (ReceiptPreview & {
    payee: string;
    narration: string;
    note?: string;
    error?: string;
  })[];
}
interface Pending {
  body: { request_id: string; receipts: ReceiptDraft["body"][] };
  preview?: BatchResult;
  uncertain?: boolean;
}
export default function ReceiptBatch({
  journal,
  drafts,
  onDraftsChange,
  onEdit,
  onChanged,
  onLockChange,
}: {
  journal: Journal;
  drafts: ReceiptDraft[];
  onDraftsChange: (drafts: ReceiptDraft[]) => void;
  onEdit: (id: string) => void;
  onChanged: () => Promise<void>;
  onLockChange: (locked: boolean) => void;
}) {
  const key = `beancount-ui.receipt-batch.${journal.identity ?? "default"}`;
  const [pending, setPending] = useState<Pending | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  useEffect(() => {
    onLockChange(!!pending);
  }, [pending, onLockChange]);
  function persist(value: Pending | null) {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
    setPending(value);
  }
  async function work(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function preview() {
    const next = pending ?? {
      body: {
        request_id: requestId(),
        receipts: drafts.map((d) => ({ ...d.body, request_id: requestId() })),
      },
    };
    persist(next);
    const result = await post<BatchResult>(
      "/fulfillment/receipt/batch/preview",
      next.body,
    );
    persist({ ...next, preview: result });
  }
  const result = pending?.preview;
  if (!drafts.length && !pending) return null;
  return (
    <section className="panel card" aria-label="批量收货草稿">
      <h2>
        批量收货 · {pending?.body.receipts.length ?? drafts.length} 个订单
      </h2>
      <p className="muted">
        逐单填写后加入这里，一次预览全部账单和入库内容，再统一确认。
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {!pending &&
        drafts.map((d) => (
          <article className="inventory-row" key={d.order.id}>
            <strong>
              {d.order.source.payee} · {d.order.source.narration}
            </strong>
            {d.order.source.note && (
              <p className="order-note">备注：{d.order.source.note}</p>
            )}
            <p>
              {d.body.received_date} ·{" "}
              {d.body.lines
                .map(
                  (l) =>
                    `${d.order.items.find((i) => i.id === l.item_id)?.name} × ${l.quantity}`,
                )
                .join("、")}
            </p>
            <p>
              {d.body.settlement
                ? `账单 ${d.body.settlement.amount} ${d.order.source.currency} · ${d.body.settlement.account}`
                : "已付款，不重复记账"}
            </p>
            <div className="toolbar">
              <button
                className="ghost"
                disabled={busy}
                onClick={() => onEdit(d.order.id)}
              >
                编辑该单
              </button>
              <button
                className="ghost"
                disabled={busy}
                onClick={() =>
                  onDraftsChange(
                    drafts.filter((r) => r.order.id !== d.order.id),
                  )
                }
              >
                移出本批
              </button>
            </div>
          </article>
        ))}
      {result && (
        <>
          {result.receipts.map((r) => (
            <article className="inventory-row" key={r.request_id}>
              <strong>
                {r.payee} · {r.narration}
              </strong>
              {r.note && <p className="order-note">备注：{r.note}</p>}
              <p>收货日期：{r.received_date}</p>
              {r.actions.map((a, index) => (
                <p key={index}>
                  {a.name} · 收货 {a.quantity} {a.unit}
                  {a.product_id
                    ? ` → 入库 ${a.stock_amount}，位置：${a.location_name ?? "需核对"}，到期日期：${a.best_before_date}，单价 ${a.unit_price} ${a.currency}`
                    : " · 仅记录收货"}
                </p>
              ))}
              <p>
                {r.financial ? "先保存账单，再入库" : "不新增账务"}
                {r.receipt_saved && " · 收货已保存"}
              </p>
              {(r.error || r.settlement_error) && (
                <Notice tone="error">{r.error || r.settlement_error}</Notice>
              )}
              <OperationStatus
                operations={r.operations}
                onChanged={async (operation) => {
                  const next = {
                    ...result,
                    receipts: result.receipts.map((item) =>
                      item.request_id === r.request_id
                        ? {
                            ...item,
                            operations: item.operations.map((o) =>
                              o.id === operation.id ? operation : o,
                            ),
                          }
                        : item,
                    ),
                  };
                  persist({ ...pending!, preview: next });
                  await onChanged();
                }}
              />
            </article>
          ))}
          {result.financial && (
            <>
              <h3>整批账单变更</h3>
              {Object.entries(result.financial.diffs).map(([file, diff]) => (
                <div key={file}>
                  <h4>{file}</h4>
                  <Diff diff={diff} />
                </div>
              ))}
            </>
          )}
        </>
      )}
      {pending?.uncertain && result?.status !== "done" && (
        <Notice tone="warn">
          请恢复原批次继续处理；已完成的账单、收货和入库不会重复执行。
        </Notice>
      )}
      {result?.status === "done" && (
        <Notice>
          整批收货已保存。各商品的入库结果见上方；如有待核对或失败项，可在对应项继续处理。
        </Notice>
      )}
      <div className="toolbar">
        {!pending && (
          <button
            disabled={busy || !drafts.length}
            onClick={() => void work(preview)}
          >
            批量预览收货与入库
          </button>
        )}
        {pending && !result && (
          <button disabled={busy} onClick={() => void work(preview)}>
            恢复整批预览
          </button>
        )}
        {result && result.status !== "done" && (
          <button
            disabled={busy}
            onClick={() =>
              void work(async () => {
                if (
                  !pending!.uncertain &&
                  result.financial &&
                  !confirmEntryDates(result.financial.items)
                )
                  return;
                const next = { ...pending!, uncertain: true };
                persist(next);
                const saved = await post<BatchResult>(
                  "/fulfillment/receipt/batch/commit",
                  { request_id: result.request_id },
                );
                persist({ ...next, preview: saved });
                await onChanged();
              })
            }
          >
            {pending?.uncertain ? "恢复原批次" : "确认整批记账与入库"}
          </button>
        )}
        {pending && result?.status !== "done" && (
          <button
            className="ghost"
            disabled={busy}
            onClick={() =>
              void work(async () => {
                // A preview cannot write ledger/stock. A lost preview response can safely be discarded.
                if (result || pending.uncertain)
                  await post("/fulfillment/receipt/batch/cancel", {
                    request_id: pending.body.request_id,
                  });
                persist(null);
              })
            }
          >
            {pending.uncertain ? "核对并返回编辑" : "返回编辑整批"}
          </button>
        )}
        {result?.status === "done" && (
          <button
            disabled={busy}
            onClick={() =>
              void work(async () => {
                onDraftsChange([]);
                persist(null);
                await onChanged();
              })
            }
          >
            完成本批
          </button>
        )}
      </div>
    </section>
  );
}
