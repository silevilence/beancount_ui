import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import ReceiptEditor from "./ReceiptEditor";
import type { ManagedOrder } from "./OrderPage";
import type { Journal } from "./api";

it("已付款商品收货先预览，取消不写入，确认不调用账务提交", async () => {
  const order = {
    id: "one",
    source: { mode: "paid", unpaid: "0" },
    items: [
      {
        id: "item",
        name: "食品",
        remaining: "2",
        unit: "件",
        product_id: null,
      },
    ],
    source_changed: false,
  } as unknown as ManagedOrder;
  const calls: string[] = [];
  const result = {
    request_id: "r",
    received_date: "2026-10-19",
    receipt_saved: false,
    financial: null,
    settlement_status: "none",
    actions: [{ name: "食品", quantity: "2", unit: "件", product_id: null }],
    operations: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      calls.push(path);
      return {
        ok: true,
        json: async () => ({
          ...result,
          receipt_saved: path.endsWith("commit"),
        }),
      };
    }),
  );
  render(
    <ReceiptEditor
      order={order}
      journal={{ identity: "test", accounts: [] } as unknown as Journal}
      onChanged={async () => {}}
    />,
  );
  fireEvent.click(screen.getByText("预览本次收货"));
  expect(
    await screen.findByText("本次不新增 Beancount 账务记录。"),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByText("取消收货预览"));
  expect(calls.some((p) => p.endsWith("commit"))).toBe(false);
  fireEvent.click(screen.getByText("预览本次收货"));
  fireEvent.click(await screen.findByText("确认收货并执行预览动作"));
  expect(await screen.findByText(/实物收货已保存/)).toBeInTheDocument();
  expect(calls.filter((p) => p.endsWith("commit"))).toEqual([
    "/api/fulfillment/receipt/commit",
  ]);
});
