import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import OrderCorrections from "./OrderCorrections";
import type { ManagedOrder } from "./OrderPage";

it("取消剩余只提交显式更正，不触发退款", async () => {
  const fetch = vi.fn(async (_path: string) => ({
    ok: true,
    json: async () => ({ message: "更正已记录" }),
  }));
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const order = {
    id: "cancel-test",
    source: { currency: "CNY" },
    items: [{ id: "item", name: "牛奶", remaining: "2", unit: "瓶" }],
    receipts: [],
  } as unknown as ManagedOrder;
  render(<OrderCorrections order={order} onChanged={async () => {}} />);
  fireEvent.change(screen.getByLabelText("商品"), {
    target: { value: "item" },
  });
  fireEvent.change(screen.getByLabelText("更正／核对依据"), {
    target: { value: "未发货取消剩余" },
  });
  fireEvent.click(screen.getByText("确认所选更正"));
  expect(await screen.findByText("更正已记录")).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/fulfillment/corrections");
});
