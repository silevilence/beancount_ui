import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import PurchaseItems, { blankItem } from "./PurchaseItems";

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
