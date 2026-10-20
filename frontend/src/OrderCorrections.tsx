import { useState } from "react";
import type { ManagedOrder } from "./OrderPage";
import { api, reasonOf } from "./api";
import { post } from "./api";
import { requestId } from "./requestId";
import { Notice } from "./ui";
import OperationStatus, { type StockOperation } from "./OperationStatus";
import PurchaseItems, { type PurchaseItem } from "./PurchaseItems";

export default function OrderCorrections({
  order,
  onChanged,
}: {
  order: ManagedOrder;
  onChanged: () => Promise<void>;
}) {
  const [action, setAction] = useState("cancel_remaining");
  const [item, setItem] = useState("");
  const [receipt, setReceipt] = useState("");
  const [reason, setReason] = useState("");
  const [replacement, setReplacement] = useState<PurchaseItem[]>([]);
  const [inspection, setInspection] = useState<{
    operations: StockOperation[];
    guidance: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const key = `beancount-ui.correction.${order.id}`;
  const [pending, setPending] = useState<Record<string, unknown> | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  });
  async function inspect() {
    setBusy(true);
    setMessage("");
    try {
      setInspection(
        await api(
          `/fulfillment/corrections/inspect?${new URLSearchParams({ order_id: order.id, receipt_id: receipt })}`,
        ),
      );
    } catch (e) {
      setMessage(reasonOf(e));
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    if (busy) return;
    if (
      !window.confirm(
        "确认执行所选更正？取消待收不退款；作废实收会先核对并尝试撤销其入库，已有后续操作时会停止。",
      )
    )
      return;
    setBusy(true);
    setMessage("");
    try {
      let clean: PurchaseItem | undefined;
      if (replacement[0]) {
        const r = replacement[0];
        clean = {
          id: r.id,
          name: r.name,
          quantity: r.quantity,
          unit: r.unit,
          product_id: r.product_id,
          instance_id: r.instance_id,
          factor: r.factor,
          stock_unit: r.stock_unit,
          purchase_unit_id: r.purchase_unit_id,
          stock_unit_id: r.stock_unit_id,
          unit_price: r.unit_price,
          allocated_amount: r.allocated_amount,
          currency: r.currency,
          price_confirmed: r.price_confirmed,
          default_location_id: r.default_location_id,
          default_best_before_days: r.default_best_before_days,
        };
      }
      const body = pending || {
        request_id: requestId(),
        order_id: order.id,
        action,
        reason,
        item_id: item,
        receipt_id: receipt,
        replacement: action === "replace_unreceived" ? clean : null,
      };
      localStorage.setItem(key, JSON.stringify(body));
      setPending(body);
      const result = await post<{ message: string }>(
        "/fulfillment/corrections",
        body,
      );
      setMessage(result.message);
      localStorage.removeItem(key);
      setPending(null);
      setInspection(undefined);
      await onChanged();
    } catch (e) {
      setMessage(reasonOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="inventory-row">
      <summary>取消、退货与误录更正</summary>
      <p className="muted small">
        仅退款和差价返还请使用结算与退款页，不扣库存。实际退货先核对批次，再在库存页执行对应消耗并保留说明。
      </p>
      {message && <Notice>{message}</Notice>}
      {pending && (
        <Notice tone="warn">
          原更正请求仍保留。请恢复原请求核对结果。
          <button disabled={busy} onClick={() => void submit()}>
            恢复原更正
          </button>
          <button
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "已核对可能已经发生的库存撤销和本地更正？关闭此请求不会恢复任何库存。",
                )
              ) {
                localStorage.removeItem(key);
                setPending(null);
              }
            }}
          >
            核对后关闭
          </button>
        </Notice>
      )}
      <fieldset className="grocy-form" disabled={busy || !!pending}>
        <label>
          更正类型
          <select
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setInspection(undefined);
            }}
          >
            <option value="cancel_remaining">取消商品剩余待收</option>
            <option value="replace_unreceived">
              更正未收货或已作废全部收货的商品
            </option>
            <option value="void_receipt">作废误录收货并核对入库撤销</option>
            <option value="return_note">记录实际退货核对说明</option>
            <option value="release">
              解除无有效收货的订单管理（保留历史）
            </option>
          </select>
        </label>
        {["cancel_remaining", "replace_unreceived"].includes(action) && (
          <label>
            商品
            <select
              value={item}
              onChange={(e) => {
                setItem(e.target.value);
                const i = order.items.find((i) => i.id === e.target.value);
                setReplacement(i ? [i] : []);
              }}
            >
              <option value="">请选择</option>
              {order.items
                .filter((i) =>
                  action === "replace_unreceived"
                    ? !order.receipts.some(
                        (r) =>
                          !r.voided &&
                          r.lines.some((line) => line.item_id === i.id),
                      )
                    : Number(i.remaining) > 0,
                )
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} · 剩余 {i.remaining} {i.unit}
                  </option>
                ))}
            </select>
          </label>
        )}
        {action === "replace_unreceived" && replacement.length > 0 && (
          <PurchaseItems
            items={replacement}
            autoCalculate={!pending}
            onChange={setReplacement}
            amount=""
            currency={order.source.currency}
          />
        )}
        {["void_receipt", "return_note"].includes(action) && (
          <>
            <label>
              收货批次
              <select
                value={receipt}
                onChange={(e) => {
                  setReceipt(e.target.value);
                  setInspection(undefined);
                }}
              >
                <option value="">请选择</option>
                {order.receipts
                  .filter((r) => !r.voided)
                  .map((r) => (
                    <option key={r.request_id} value={r.request_id}>
                      {r.received_date} · {r.request_id.slice(0, 8)}
                    </option>
                  ))}
              </select>
            </label>
            <button
              disabled={!receipt}
              className="ghost"
              onClick={() => void inspect()}
            >
              先核对关联批次与后续操作
            </button>
          </>
        )}
        {inspection && (
          <>
            <p>{inspection.guidance}</p>
            <OperationStatus
              operations={inspection.operations}
              title="该批次的库存操作"
            />
          </>
        )}
        <label>
          更正／核对依据
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <button
          disabled={
            reason.trim().length < 3 ||
            (["void_receipt", "return_note"].includes(action) && !inspection)
          }
          onClick={() => void submit()}
        >
          确认所选更正
        </button>
      </fieldset>
      {order.corrections?.map((c, i) => (
        <p key={i}>
          {c.action} · {c.reason}
        </p>
      ))}
    </details>
  );
}
