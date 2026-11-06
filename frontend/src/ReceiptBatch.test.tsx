import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import ReceiptBatch from "./ReceiptBatch";
import type { ReceiptDraft } from "./receiptDraft";
import type { Journal } from "./api";

const draft = {
  order: {
    id: "order",
    source: { payee: "商店", narration: "米", note: "厨房补货" },
    items: [{ id: "item", name: "米" }],
  },
  body: {
    request_id: "draft",
    order_id: "order",
    received_date: "2026-10-25",
    lines: [{ item_id: "item", quantity: "2" }],
    settlement: null,
  },
} as ReceiptDraft;
const result = {
  request_id: "batch",
  status: "preview",
  financial: null,
  receipts: [
    {
      request_id: "receipt",
      received_date: "2026-10-25",
      payee: "商店",
      narration: "米",
      note: "厨房补货",
      receipt_saved: false,
      settlement_status: "none",
      financial: null,
      operations: [],
      actions: [
        {
          name: "米",
          quantity: "2",
          unit: "袋",
          product_id: 1,
          stock_amount: "2",
          unit_price: "5",
          currency: "CNY",
          location_name: "厨房",
          best_before_date: "2027-01-01",
        },
      ],
    },
  ],
};
function props(identity: string) {
  return {
    journal: { identity } as Journal,
    drafts: [draft],
    onDraftsChange: vi.fn(),
    onEdit: vi.fn(),
    onChanged: vi.fn(async () => {}),
    onLockChange: vi.fn(),
  };
}

it("提交响应丢失后刷新仍恢复原批次，不另建预览，入库位置展示名称", async () => {
  let commits = 0;
  const fetch = vi.fn(async (path: string, _init?: RequestInit) => {
    if (path.endsWith("/commit") && ++commits === 1)
      throw new Error("网络中断");
    return {
      ok: true,
      json: async () =>
        path.endsWith("/commit")
          ? {
              ...result,
              status: "done",
              receipts: result.receipts.map((r) => ({
                ...r,
                receipt_saved: true,
              })),
            }
          : result,
    };
  });
  vi.stubGlobal("fetch", fetch);
  const p = props("restore");
  const view = render(<ReceiptBatch {...p} />);
  fireEvent.click(screen.getByText("批量预览收货与入库"));
  await screen.findByText(/位置：厨房/);
  fireEvent.click(screen.getByText("确认整批记账与入库"));
  await screen.findByText("网络中断");
  view.unmount();
  render(<ReceiptBatch {...p} />);
  fireEvent.click(screen.getByText("恢复原批次"));
  await screen.findByText(/整批收货已保存/);
  expect(
    fetch.mock.calls.filter((c) => c[0].endsWith("/preview")),
  ).toHaveLength(1);
  expect(
    fetch.mock.calls
      .filter((c) => c[0].endsWith("/commit"))
      .map((c) => JSON.parse(String(c[1]?.body))),
  ).toEqual([{ request_id: "batch" }, { request_id: "batch" }]);
  fireEvent.click(screen.getByText("完成本批"));
  await waitFor(() =>
    expect(
      localStorage.getItem("beancount-ui.receipt-batch.restore"),
    ).toBeNull(),
  );
  expect(p.onDraftsChange).toHaveBeenCalledWith([]);
});

it("批量预览可返回编辑，提交不确定时取消被拒绝仍保留原请求", async () => {
  let rejectCancel = false;
  const fetch = vi.fn(async (path: string) => ({
    ok: !(path.endsWith("/cancel") && rejectCancel),
    status: rejectCancel ? 409 : 200,
    json: async () =>
      path.endsWith("/cancel")
        ? rejectCancel
          ? { detail: "账单已保存，请恢复原批次" }
          : { status: "cancelled" }
        : {
            ...result,
            status: path.endsWith("/commit") ? "needs_review" : "preview",
          },
  }));
  vi.stubGlobal("fetch", fetch);
  const p = props("cancel");
  render(<ReceiptBatch {...p} />);
  fireEvent.click(screen.getByText("编辑该单"));
  expect(p.onEdit).toHaveBeenCalledWith("order");
  fireEvent.click(screen.getByText("批量预览收货与入库"));
  fireEvent.click(await screen.findByText("返回编辑整批"));
  await screen.findByText("批量预览收货与入库");
  expect(localStorage.getItem("beancount-ui.receipt-batch.cancel")).toBeNull();
  fireEvent.click(screen.getByText("批量预览收货与入库"));
  fireEvent.click(await screen.findByText("确认整批记账与入库"));
  await screen.findByText("恢复原批次");
  rejectCancel = true;
  fireEvent.click(screen.getByText("核对并返回编辑"));
  await screen.findByText("账单已保存，请恢复原批次");
  expect(
    localStorage.getItem("beancount-ui.receipt-batch.cancel"),
  ).not.toBeNull();
});

it("整批收货的非今日账单先在页面内确认，取消保留预览，重复点击只提交一次", async () => {
  const preview = {
    ...result,
    financial: {
      request_id: "finance",
      items: [{ raw: '2000-01-01 * "历史结算"\n' }],
      diffs: {},
    },
  };
  const fetch = vi.fn(async (path: string) => ({
    ok: true,
    json: async () =>
      path.endsWith("/commit") ? { ...preview, status: "done" } : preview,
  }));
  vi.stubGlobal("fetch", fetch);
  const p = props("dates");
  render(<ReceiptBatch {...p} />);
  fireEvent.click(screen.getByText("批量预览收货与入库"));
  const save = await screen.findByRole("button", {
    name: "确认整批记账与入库",
  });
  const before = localStorage.getItem("beancount-ui.receipt-batch.dates");
  fireEvent.click(save);
  expect(
    screen.getByRole("dialog", { name: "确认入账日期" }),
  ).toHaveTextContent("2000-01-01：1 笔");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(save).toBeEnabled());
  expect(localStorage.getItem("beancount-ui.receipt-batch.dates")).toBe(before);
  expect(
    fetch.mock.calls.filter(([path]) => path.endsWith("/commit")),
  ).toHaveLength(0);
  fireEvent.click(save);
  fireEvent.click(save);
  fireEvent.click(screen.getByRole("button", { name: "按这些日期入账" }));
  await waitFor(() => expect(p.onChanged).toHaveBeenCalledOnce());
  expect(
    fetch.mock.calls.filter(([path]) => path.endsWith("/commit")),
  ).toHaveLength(1);
  expect(window.confirm).not.toHaveBeenCalled();
});
