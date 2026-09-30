import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import SplitFields, { decimalTotal } from "./SplitFields";
import type { EntryFields } from "./Editor";

it("商品和负折扣精确求和并保留各项备注", () => {
  expect(decimalTotal(["0.1", "0.2", "-0.01"])).toBe("0.29");
  expect(decimalTotal(["-1"])).toBe("-1");
  expect(decimalTotal([""])).toContain("待填写");
  function Form() { const [fields, set] = useState<EntryFields>({ date: "2026-09-30", amount: "28", currency: "CNY", category: "Expenses:Food", payment: "Assets:Cash", payee: "", narration: "", note: "" }); return <SplitFields fields={fields} onChange={set} accounts={[{ name: "Expenses:Food", currencies: [] }]} />; }
  render(<Form />);
  fireEvent.click(screen.getByText("展开商品与折扣明细"));
  fireEvent.change(screen.getByLabelText("明细金额 1"), { target: { value: "30" } });
  fireEvent.change(screen.getByLabelText("商品备注 1"), { target: { value: "商品" } });
  fireEvent.click(screen.getByText("增加商品 / 折扣项"));
  fireEvent.change(screen.getByLabelText("明细金额 2"), { target: { value: "-2" } });
  expect(screen.getByText(/明细合计：28/)).toBeInTheDocument();
  fireEvent.click(screen.getByText("移除明细 2"));
  expect(screen.getByLabelText("商品备注 1")).toHaveValue("商品");
});
