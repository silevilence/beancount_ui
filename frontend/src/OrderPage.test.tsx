import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  expect(screen.getByText("尚无库存操作")).toBeInTheDocument();
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

it("过期账务原请求经后端核对取消后可继续操作", async () => {
  const key = "beancount-ui.orders.pending.stale-test";
  localStorage.setItem(
    key,
    JSON.stringify({
      path: "/preview",
      body: { request_id: "old" },
      uncertain: true,
      preview: { request_id: "old", items: [], diffs: {} },
    }),
  );
  const fetch = vi.fn(async (path: string) => ({
    ok: !path.endsWith("/commit"),
    status: 409,
    json: async () =>
      path.endsWith("/cancel")
        ? { status: "cancelled" }
        : path.endsWith("/commit")
          ? { detail: "预览后账本已修改" }
          : [],
  }));
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(
    <OrderPage
      journal={
        {
          identity: "stale-test",
          revision: "a",
          accounts: [],
        } as unknown as Journal
      }
      onChanged={async () => {}}
    />,
  );
  fireEvent.click(screen.getByText("确认保存账务"));
  await screen.findByText("预览后账本已修改");
  fireEvent.click(screen.getByText("核对并结束原账务请求"));
  await screen.findByText("原预览已取消，可重新处理账务");
  expect(localStorage.getItem(key)).toBeNull();
  fireEvent.click(screen.getByText("结算与退款"));
  expect(screen.getByText("预览账务处理")).toBeEnabled();
});
it("历史购买认领可预览取消，筛选分别读取付款与收货状态", async () => {
  const rows = [
    {
      id: "o",
      source: {
        date: "2026-10-19",
        payee: "商店",
        narration: "水",
        total: "12",
        currency: "CNY",
        raw: "原文",
        events: [{ id: "e", raw: "付款原文" }],
      },
      items: [
        {
          id: "i",
          name: "水",
          quantity: "1",
          unit: "瓶",
          received: "1",
          remaining: "0",
          cancelled: "0",
          product_id: null,
        },
      ],
      receipts: [
        {
          request_id: "r",
          received_date: "2026-10-19",
          lines: [{ item_id: "i", quantity: "1" }],
          voided: true,
          item_snapshots: { i: { name: "历史商品名称", unit: "瓶" } },
        },
      ],
      receipt_state: "received",
      payment_state: "partial",
      source_changed: true,
      operations: [{ id: "op", status: "unknown", error: "需核对" }],
    },
  ];
  const fetch = vi.fn(async (path: string) => ({
    ok: true,
    json: async () =>
      path.endsWith("fulfillment/orders")
        ? rows
        : path.endsWith("/orders")
          ? [
              {
                id: "old",
                key: "old-key",
                date: "2026-09-01",
                payee: "旧商店",
                narration: "茶",
                total: "20",
                currency: "CNY",
                mode: "deferred",
                raw: "历史原文",
              },
            ]
          : path.endsWith("/ledger")
            ? { revision: "a" }
            : { request_id: "claim", diffs: { file: "+关联" }, items: [] },
  }));
  vi.stubGlobal("fetch", fetch);
  render(
    <OrderPage
      journal={
        {
          identity: "filters",
          revision: "a",
          accounts: [],
        } as unknown as Journal
      }
      initialOrder="o"
      onChanged={async () => {}}
    />,
  );
  await screen.findByText("原购买发生变化，请核对账本。");
  expect(screen.getByText("未关联 Grocy")).toBeInTheDocument();
  expect(screen.getByText(/2026.*已作废.*历史商品名称/)).toBeInTheDocument();
  expect(screen.getByText("付款原文")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("搜索订单"), {
    target: { value: "找不到" },
  });
  expect(
    screen.queryByRole("button", { name: "商店 · 水" }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("搜索订单"), {
    target: { value: "水" },
  });
  fireEvent.change(screen.getByLabelText("收货状态"), {
    target: { value: "sync" },
  });
  expect(screen.getByRole("button", { name: "商店 · 水" })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("购买起始日期"), {
    target: { value: "2026-10-20" },
  });
  expect(
    screen.queryByRole("button", { name: "商店 · 水" }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("购买起始日期"), {
    target: { value: "2026-10-01" },
  });
  fireEvent.change(screen.getByLabelText("购买结束日期"), {
    target: { value: "2026-10-18" },
  });
  expect(
    screen.queryByRole("button", { name: "商店 · 水" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("认领历史购买"));
  fireEvent.change(screen.getByLabelText("历史购买"), {
    target: { value: "old" },
  });
  expect(screen.getByText("历史原文")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("原购买付款方式"), {
    target: { value: "paid" },
  });
  fireEvent.click(screen.getByText("预览认领"));
  await screen.findByText("确认保存账务");
  fireEvent.click(screen.getByText("取消预览"));
  await waitFor(() =>
    expect(screen.queryByText("确认账务处理")).not.toBeInTheDocument(),
  );
  expect(fetch.mock.calls.some((c) => c[0].endsWith("/commit"))).toBe(false);
});
