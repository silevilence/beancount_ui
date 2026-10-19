import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import StockActionEditor from "./StockActionEditor";
import type { InventoryData, Product } from "./Inventory";

it("手动库存操作先预览再确认，未知结果保留核对入口", async () => {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      paths.push(path);
      return {
        ok: true,
        json: async () => ({
          id: "request",
          status: path.endsWith("preview") ? "draft" : "unknown",
          error: "响应丢失",
          payload: { amount: "1" },
        }),
      };
    }),
  );
  render(
    <StockActionEditor
      product={
        { id: 1, name: "牛奶", location_id: 1, qu_id_stock: 1 } as Product
      }
      data={
        {
          instance_id: "one",
          currency: "CNY",
          units: [{ id: 1, name: "瓶" }],
          locations: [{ id: 1, name: "冰箱" }],
        } as InventoryData
      }
      entries={[]}
      onChanged={async () => {}}
    />,
  );
  fireEvent.click(screen.getByText("预览库存动作"));
  fireEvent.click(await screen.findByText("确认库存操作"));
  expect(await screen.findByText("结果待确认")).toBeInTheDocument();
  expect(paths).toEqual([
    "/api/grocy/manual/preview",
    "/api/grocy/manual/commit",
  ]);
});
