import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import Inventory, { inventoryTree, type InventoryData } from "./Inventory";

it.each([true, false])(
  "人工结论保存后即使库存刷新失败仍显示新状态 applied=%s",
  async (applied) => {
    const product = { id: 1, name: "测试食品", qu_id_stock: 1, location_id: 1 };
    let resolved = false;
    const fetch = vi.fn(async (path: string) => {
      if (path.endsWith("/resolve")) resolved = true;
      const failed = resolved && path.endsWith("/inventory");
      return {
        ok: !failed,
        status: failed ? 503 : 200,
        json: async () => {
          if (failed) return { detail: "库存刷新失败" };
          if (path.endsWith("/resolve"))
            return {
              id: "op",
              product_id: 1,
              status: applied ? "resolved" : "cancelled",
              error: "",
            };
          if (path.endsWith("/operations"))
            return [{ id: "op", product_id: 1, status: "unknown", error: "" }];
          if (path.endsWith("/products/1")) return { details: {}, entries: [] };
          return {
            products: [product],
            stock: [{ product_id: 1, amount: "1" }],
            units: [{ id: 1, name: "件" }],
            locations: [{ id: 1, name: "厨房" }],
            alerts: {},
          };
        },
      };
    });
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(window, "prompt").mockReturnValue(
      "已人工核实日志与批次并确认原执行停止",
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Inventory />);
    fireEvent.click(await screen.findByRole("button", { name: "测试食品" }));
    fireEvent.click(
      await screen.findByText(applied ? "记录人工核实成功" : "人工核对后停止"),
    );
    expect(await screen.findByText(/库存刷新失败/)).toBeInTheDocument();
    expect(
      await screen.findByText(applied ? "已人工核实" : "已停止操作"),
    ).toBeInTheDocument();
    expect(screen.queryByText("结果待确认")).not.toBeInTheDocument();
    expect(
      fetch.mock.calls.filter(([path]) => path.endsWith("/resolve")),
    ).toHaveLength(1);
  },
);

it("接口聚合数量不重复累加，叶子产品保留自有数量，搜索保留上下文", () => {
  const data = {
    products: [
      { id: 1, name: "洗发水", qu_id_stock: 1 },
      { id: 2, name: "海飞丝", parent_product_id: 1, qu_id_stock: 1 },
      { id: 3, name: "补充装", parent_product_id: 2, qu_id_stock: 1 },
    ],
    stock: [
      {
        product_id: 1,
        amount: "0",
        amount_aggregated: "5",
        amount_opened_aggregated: "1",
      },
      { product_id: 2, amount: "2", amount_aggregated: "5" },
      {
        product_id: 3,
        amount: "3",
        amount_aggregated: "0",
        is_aggregated_amount: false,
      },
    ],
    alerts: {},
  } as unknown as InventoryData;
  const rows = inventoryTree(data, "洗发水", false);
  expect(rows.map((r) => r.amount)).toEqual([5, 5, 3]);
  expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
  expect(inventoryTree(data, "补充装", false)).toHaveLength(3);
});

it("默认隐藏空库存无告警产品，保留父子树并显示子产品汇总", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        products: [
          {
            id: 1,
            name: "洗发水",
            qu_id_stock: 1,
            cumulate_min_stock_amount_of_sub_products: 1,
            parent_product_id: null,
          },
          { id: 2, name: "海飞丝", qu_id_stock: 1, parent_product_id: 1 },
          { id: 3, name: "空库存", qu_id_stock: 1 },
          { id: 4, name: "需补货", qu_id_stock: 1, min_stock_amount: "2" },
        ],
        stock: [{ product_id: 2, amount: "2", amount_opened: "1" }],
        alerts: {},
        units: [{ id: 1, name: "瓶" }],
        locations: [],
      }),
    })),
  );
  render(<Inventory />);
  await screen.findByText("海飞丝");
  expect(screen.queryByText("空库存")).not.toBeInTheDocument();
  expect(screen.getByText("需补货")).toBeInTheDocument();
  expect(screen.getByText(/含子产品合计 2 瓶/)).toBeInTheDocument();
  expect(screen.getAllByRole("treeitem")).toHaveLength(3);
  fireEvent.click(screen.getByLabelText("收起洗发水"));
  expect(screen.queryByText("海飞丝")).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("展开洗发水"));
  expect(screen.getByText("海飞丝")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("显示全部产品"));
  expect(screen.getByText("空库存")).toBeInTheDocument();
});

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
