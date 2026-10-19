import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import OrderPage from "./OrderPage";
import type { Journal } from "./api";

vi.mock("./Orders", () => ({
  default: ({ onAdd }: { onAdd: (item: unknown) => void }) => (
    <button
      onClick={() =>
        onAdd({
          business: "ordinary",
          order: {
            kind: "settle",
            date: "2026-10-19",
            amount: "20",
            account: "Assets:Cash",
          },
        })
      }
    >
      预览账务处理
    </button>
  ),
}));
it("独立页面保留收货和付款状态，结算预览后直接保存", async () => {
  const journal = {
    identity: "test",
    revision: "a",
    accounts: [],
  } as unknown as Journal;
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      calls.push(path);
      return {
        ok: true,
        json: async () =>
          path.endsWith("fulfillment/orders")
            ? [
                {
                  id: "one",
                  source: {
                    payee: "商户",
                    narration: "采购",
                    date: "2026-10-19",
                    total: "20",
                    currency: "CNY",
                    raw: "原购买",
                  },
                  items: [],
                  receipts: [],
                  receipt_state: "pending",
                  payment_state: "paid",
                },
              ]
            : path.endsWith("/orders")
              ? []
              : path.endsWith("ledger")
                ? { revision: "b" }
                : {
                    request_id: "request",
                    status: "preview",
                    items: [{ raw: '2026-10-19 * "结算"\n' }],
                    diffs: { file: "+新增" },
                  },
      };
    }),
  );
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<OrderPage journal={journal} onChanged={async () => {}} />);
  expect(await screen.findByText("已付款")).toBeInTheDocument();
  expect(screen.getAllByText("待收货").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByText("商户 · 采购"));
  expect(screen.getByText("原购买")).toBeInTheDocument();
  fireEvent.click(screen.getByText("结算与退款"));
  fireEvent.click(screen.getByText("预览账务处理"));
  fireEvent.click(await screen.findByText("确认保存账务"));
  expect(await screen.findByText("账务处理已保存")).toBeInTheDocument();
  expect(calls.filter((p) => p === "/api/commit")).toHaveLength(1);
  expect(calls.some((p) => p.includes("receive"))).toBe(false);
});
