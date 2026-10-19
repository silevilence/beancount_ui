import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import PurchaseItems, {
  blankItem,
  linkedItem,
  shortagePurchase,
  type PurchaseItem,
} from "./PurchaseItems";
import type { InventoryData, Product } from "./Inventory";

it("告警建议扣除在途与已收未同步，换算缺失或无净缺口时不猜数量", () => {
  const product = {
    id: 1,
    name: "水",
    qu_id_purchase: 2,
    qu_id_stock: 1,
    min_stock_amount: "30",
  } as Product;
  const data = {
    instance_id: "one",
    currency: "CNY",
    units: [],
    stock: [{ product_id: 1, amount: "1" }],
    conversions: [{ product_id: 1, from_qu_id: 2, to_qu_id: 1, factor: "12" }],
    purchase_quantities: {
      "1": { pending: "12", received_unsynced: "5", order_ids: [] },
    },
  } as unknown as InventoryData;
  expect(shortagePurchase(product, data).quantity).toBe("1");
  expect(
    shortagePurchase({ ...product, min_stock_amount: "6" }, data).quantity,
  ).toBe("");
  expect(shortagePurchase(product, { ...data, conversions: [] }).quantity).toBe(
    "",
  );
  expect(
    shortagePurchase(product, {
      ...data,
      stock: [],
      purchase_quantities: undefined,
    }).quantity,
  ).toBe("3");
  expect(
    shortagePurchase({ ...product, min_stock_amount: "bad" }, data).quantity,
  ).toBe("");
});

it("2 箱每箱 12 瓶计算每瓶 5 元，多商品不自动分配整单金额", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        instance_id: "one",
        currency: "CNY",
        products: [{ id: 1, name: "水", qu_id_stock: 1, qu_id_purchase: 2 }],
        units: [
          { id: 1, name: "瓶" },
          { id: 2, name: "箱" },
        ],
        conversions: [
          { product_id: 1, from_qu_id: 2, to_qu_id: 1, factor: "12" },
        ],
      }),
    })),
  );
  function Form() {
    const [items, setItems] = useState([blankItem()]);
    return (
      <PurchaseItems
        items={items}
        onChange={setItems}
        amount="120"
        currency="CNY"
      />
    );
  }
  render(<Form />);
  fireEvent.click(screen.getByText("读取 Grocy 产品"));
  await screen.findByRole("option", { name: "水" });
  fireEvent.change(screen.getByLabelText("关联 Grocy 产品"), {
    target: { value: "1" },
  });
  fireEvent.change(screen.getByLabelText("采购数量"), {
    target: { value: "2" },
  });
  fireEvent.click(screen.getByText("按单商品金额计算单价"));
  expect(screen.getByLabelText(/每库存单位价格/)).toHaveValue("5");
  expect(screen.getByText(/本次 24 瓶/)).toBeInTheDocument();
  fireEvent.click(screen.getByText("添加商品明细"));
  expect(screen.queryByText("按单商品金额计算单价")).toBeNull();
});

it("断连仍可编辑未关联商品，不把其他币种整单金额填为价格", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ detail: "Grocy 已停用" }),
    })),
  );
  function Form() {
    const [items, setItems] = useState<PurchaseItem[]>([
      {
        ...blankItem(),
        product_id: 1,
        name: "保存的水",
        currency: "USD",
        factor: "",
        stock_unit: "瓶",
      },
    ]);
    return (
      <PurchaseItems
        items={items}
        onChange={setItems}
        amount="120"
        currency="CNY"
      />
    );
  }
  render(<Form />);
  expect(screen.getByText(/币种不同/)).toBeInTheDocument();
  expect(screen.queryByText("按单商品金额计算单价")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/每库存单位价格/), {
    target: { value: "2" },
  });
  fireEvent.click(screen.getByLabelText("已核对商品、换算和分配后价格"));
  fireEvent.click(screen.getByText("读取 Grocy 产品"));
  await screen.findByText(/可继续记录未关联商品/);
  fireEvent.change(screen.getByLabelText("关联 Grocy 产品"), {
    target: { value: "" },
  });
  fireEvent.change(screen.getByLabelText("商品名称"), {
    target: { value: "普通商品" },
  });
  fireEvent.change(screen.getByLabelText("采购单位"), {
    target: { value: "袋" },
  });
  expect(screen.getByLabelText("商品名称")).toHaveValue("普通商品");
  fireEvent.click(screen.getByText("移除此商品"));
  expect(screen.queryByLabelText("商品名称")).not.toBeInTheDocument();
});
it("优先产品换算，同单位不换算，缺失换算不可猜测", () => {
  const data = {
    instance_id: "one",
    currency: "CNY",
    units: [],
    conversions: [
      { from_qu_id: 2, to_qu_id: 1, product_id: null, factor: "10" },
      { from_qu_id: 2, to_qu_id: 1, product_id: 1, factor: "12" },
    ],
  } as unknown as InventoryData;
  const product = {
    id: 1,
    name: "水",
    qu_id_stock: 1,
    qu_id_purchase: 2,
    location_id: 1,
    default_best_before_days: -1,
  } as Product;
  expect(linkedItem(product, data).factor).toBe("12");
  expect(linkedItem({ ...product, id: 2 }, data).factor).toBe("10");
  expect(linkedItem({ ...product, qu_id_purchase: 1 }, data).factor).toBe("1");
  expect(linkedItem({ ...product, qu_id_purchase: 3 }, data).factor).toBe("");
});
