import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import MasterData from "./MasterData";
import type { InventoryData } from "./Inventory";

it("产品编辑包含分类父产品和该产品的换算，保存转换使用产品 ID", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return {
        ok: true,
        json: async () => ({ status: "done", message: "已保存" }),
      };
    }),
  );
  const data = {
    instance_id: "one",
    products: [
      {
        id: 1,
        name: "洗发水",
        no_own_stock: 1,
        qu_id_stock: 1,
        qu_id_purchase: 1,
      },
      {
        id: 2,
        name: "海飞丝",
        parent_product_id: 1,
        product_group_id: 1,
        qu_id_stock: 1,
        qu_id_purchase: 2,
        location_id: 1,
      },
    ],
    product_groups: [{ id: 1, name: "日用品" }],
    locations: [{ id: 1, name: "浴室" }],
    units: [
      { id: 1, name: "瓶" },
      { id: 2, name: "箱" },
    ],
    shopping_locations: [],
    conversions: [
      { id: 5, product_id: 2, from_qu_id: 2, to_qu_id: 1, factor: "12" },
      { id: 6, product_id: 1, from_qu_id: 2, to_qu_id: 1, factor: "99" },
    ],
  } as unknown as InventoryData;
  render(<MasterData data={data} onChanged={async () => {}} />);
  fireEvent.change(screen.getByLabelText("编辑记录"), {
    target: { value: "2" },
  });
  expect(screen.getByLabelText("父产品")).toHaveValue("1");
  expect(screen.getByLabelText("产品分类")).toHaveValue("1");
  expect(screen.queryByRole("option", { name: /99/ })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("编辑单位换算"), {
    target: { value: "5" },
  });
  fireEvent.change(screen.getByLabelText("换算倍数"), {
    target: { value: "24" },
  });
  fireEvent.click(screen.getByText("保存单位换算"));
  await waitFor(() => expect(bodies).toHaveLength(1));
  expect(bodies[0]).toMatchObject({
    entity: "quantity_unit_conversions",
    entity_id: 5,
    data: { product_id: 2, from_qu_id: 2, to_qu_id: 1, factor: "24" },
  });
});

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
