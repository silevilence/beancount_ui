import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import MasterData from "./MasterData";
import type { InventoryData } from "./Inventory";

it("产品更新保留 ID，删除先确认，未知结果不发起新请求", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return {
        ok: true,
        json: async () => ({ status: "unknown", message: "引用限制，请核对" }),
      };
    }),
  );
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const data = {
    instance_id: "one",
    products: [
      {
        id: 2,
        name: "牛奶",
        location_id: 1,
        qu_id_stock: 1,
        qu_id_purchase: 1,
      },
    ],
    locations: [{ id: 1, name: "冰箱" }],
    units: [{ id: 1, name: "瓶" }],
    conversions: [],
    shopping_locations: [],
  } as unknown as InventoryData;
  render(<MasterData data={data} onChanged={async () => {}} />);
  fireEvent.change(screen.getByLabelText("编辑记录"), {
    target: { value: "2" },
  });
  expect(screen.getByLabelText("名称")).toHaveValue("牛奶");
  fireEvent.click(screen.getByText("删除资料"));
  expect(await screen.findByText("引用限制，请核对")).toBeInTheDocument();
  fireEvent.click(screen.getByText("读取原请求结果"));
  await screen.findByText("引用限制，请核对");
  expect(bodies[0].entity_id).toBe(2);
  expect(bodies[0].delete).toBe(true);
  expect(bodies[1].request_id).toBe(bodies[0].request_id);
});
