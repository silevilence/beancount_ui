import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import SplitFields, { decimalTotal } from "./SplitFields";
import type { EntryFields } from "./Editor";

const accounts = [
  { name: "Expenses:Food", currencies: ["CNY"] },
  { name: "Expenses:Home", currencies: ["CNY"] },
  { name: "Assets:Cash", currencies: ["CNY"] },
];

function Form({ onChange }: { onChange?: (fields: EntryFields) => void }) {
  const [fields, set] = useState<EntryFields>({
    date: "2026-09-30",
    amount: "28",
    currency: "CNY",
    category: "Expenses:Food",
    payment: "Assets:Cash",
    payee: "",
    narration: "",
    note: "",
  });
  return (
    <SplitFields
      fields={fields}
      onChange={(next) => {
        set(next);
        onChange?.(next);
      }}
      accounts={accounts}
    />
  );
}

it("明细金额精确求和，非法输入不参与计算", () => {
  expect(decimalTotal(["0.1", "0.2", "-0.01"])).toBe("0.29");
  expect(decimalTotal(["-1"])).toBe("-1");
  expect(decimalTotal([""])).toContain("待填写");
  expect(decimalTotal(["1.0", "abc"])).toContain("待填写");
});

it("商品与负折扣精确求和、与实付对照并保留各项备注", () => {
  render(<Form />);
  expect(screen.getByText(/尚未展开明细/)).toBeInTheDocument();
  fireEvent.click(screen.getByText("展开商品与折扣明细"));
  expect(
    screen.queryByRole("option", { name: "Assets:Cash" }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("明细金额 1"), {
    target: { value: "30" },
  });
  fireEvent.change(screen.getByLabelText("商品备注 1"), {
    target: { value: "商品" },
  });
  expect(screen.getByText(/差额 -2\.00 CNY/)).toBeInTheDocument();
  fireEvent.click(screen.getByText("增加商品 / 折扣项"));
  fireEvent.change(screen.getByLabelText("明细金额 2"), {
    target: { value: "-2" },
  });
  expect(screen.getByText("合计与实付一致")).toBeInTheDocument();
  expect(screen.getAllByText("28.00 CNY")).toHaveLength(2);
  fireEvent.change(screen.getByLabelText("明细金额 2"), {
    target: { value: "-2.5" },
  });
  expect(screen.getByText(/差额 0\.50 CNY/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("明细金额 2"), {
    target: { value: "abc" },
  });
  expect(screen.getByText("待填写有效金额")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("明细金额 2"), {
    target: { value: "-2" },
  });
  fireEvent.click(screen.getByText("移除明细 2"));
  expect(screen.getByLabelText("商品备注 1")).toHaveValue("商品");
  expect(screen.getByText("30.00 CNY")).toBeInTheDocument();
  expect(screen.getByText(/差额 -2\.00 CNY/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("明细金额 1"), {
    target: { value: "28.000" },
  });
  expect(screen.getByText("合计与实付一致")).toBeInTheDocument();
  expect(screen.queryByText(/差额/)).not.toBeInTheDocument();
});

it("新增明细继承当前分类，分类变更回调完整字段", () => {
  const onChange = vi.fn();
  render(<Form onChange={onChange} />);
  fireEvent.click(screen.getByText("展开商品与折扣明细"));
  expect(onChange.mock.lastCall![0].splits[0]).toEqual({
    category: "Expenses:Food",
    amount: "",
    note: "",
  });
  expect(
    screen.getByRole("option", { name: "Expenses:Home" }),
  ).toBeInTheDocument();
});
