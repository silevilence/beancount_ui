import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import Inventory from "./Inventory";

it("待收货不抵消库存告警，购买只回传预填信息", async () => {
  const purchase = vi.fn();
  const onOrder = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        instance_id: "one",
        updated_at: "2026-10-19T16:30:00Z",
        products: [
          {
            id: 1,
            name: "牛奶",
            qu_id_stock: 1,
            location_id: 1,
            min_stock_amount: "6",
          },
        ],
        units: [{ id: 1, name: "瓶" }],
        locations: [{ id: 1, name: "冰箱" }],
        stock: [{ product_id: 1, amount: "1" }],
        alerts: { missing_products: [{ id: 1 }] },
        purchase_quantities: {
          "1": {
            pending: "12",
            received_unsynced: "2",
            order_ids: ["order-one"],
          },
        },
      }),
    })),
  );
  render(<Inventory onPurchase={purchase} onOrder={onOrder} />);
  expect(await screen.findByText(/已购买待收货 12 瓶/)).toBeInTheDocument();
  expect(screen.getByText(/更新于 10\/20 00:30/)).toBeInTheDocument();
  expect(screen.getByText("缺货 / 低于最低库存")).toBeInTheDocument();
  fireEvent.click(screen.getByText("购买"));
  expect(purchase).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText(/查看订单/));
  expect(onOrder).toHaveBeenCalledWith("order-one");
});

it("显示库存告警与批次，刷新失败保留旧数据标识", async () => {
  let fail = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => ({
      ok: !fail,
      json: async () =>
        fail
          ? { detail: "连接失败" }
          : path.endsWith("inventory")
            ? {
                instance_id: "one",
                updated_at: new Date().toISOString(),
                products: [
                  { id: 1, name: "牛奶", qu_id_stock: 1, location_id: 1 },
                ],
                units: [{ id: 1, name: "瓶" }],
                locations: [{ id: 1, name: "冰箱" }],
                stock: [{ product_id: 1, amount: "1" }],
                alerts: {
                  missing_products: [{ id: 1 }],
                  due_products: [{ product_id: 1 }],
                },
              }
            : {
                entries: [
                  {
                    id: 2,
                    stock_id: "batch",
                    amount: "1",
                    location_id: 1,
                    best_before_date: "2026-10-20",
                    open: 1,
                  },
                ],
                details: {},
              },
    })),
  );
  render(<Inventory />);
  fireEvent.click(await screen.findByText("牛奶"));
  expect(await screen.findByText(/批次 batch/)).toBeInTheDocument();
  expect(screen.getByText("缺货 / 低于最低库存")).toBeInTheDocument();
  expect(screen.getByText("临期")).toBeInTheDocument();
  fail = true;
  fireEvent.click(screen.getByText("刷新库存"));
  expect(await screen.findByText(/以下是旧数据/)).toBeInTheDocument();
});
