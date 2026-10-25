import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import PostingFields, { blankPosting } from "./PostingFields";

function Harness() {
  const [postings, setPostings] = useState([blankPosting(), blankPosting()]);
  return (
    <PostingFields
      postings={postings}
      onChange={setPostings}
      accounts={[
        { name: "Assets:Bitcash", currencies: ["JPY"] },
        { name: "Assets:Bank", currencies: ["USD", "CNY"] },
        { name: "Assets:Any", currencies: [] },
      ]}
    />
  );
}
function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
it("带空白及逗号的分录实时汇总，失焦规范化，币种候选可 Tab 采纳", () => {
  render(<Harness />);
  change("分录金额 1", " 2,000.01 ");
  change("分录金额 2", " -2,000.01 ");
  expect(screen.getByText(/已平衡/)).toBeInTheDocument();
  fireEvent.blur(screen.getByLabelText("分录金额 1"));
  expect(screen.getByLabelText("分录金额 1")).toHaveValue("2000.01");
  change("分录账户 1", "Assets:Bank");
  const currency = screen.getByLabelText("分录币种 1");
  fireEvent.change(currency, { target: { value: "U" } });
  expect(fireEvent.keyDown(currency, { key: "Tab" })).toBe(false);
  expect(currency).toHaveValue("USD");
});
it("账户币种自动切换，多币种账户保留有效币种，未声明账户不改变币种", () => {
  render(<Harness />);
  change("分录账户 1", "Assets:Bitcash");
  expect(screen.getByLabelText("分录币种 1")).toHaveValue("JPY");
  change("分录账户 1", "Assets:Bank");
  expect(screen.getByLabelText("分录币种 1")).toHaveValue("USD");
  change("分录币种 1", "CNY");
  change("分录账户 1", "Assets:Any");
  expect(screen.getByLabelText("分录币种 1")).toHaveValue("CNY");
  change("分录账户 1", "Assets:Bank");
  expect(screen.getByLabelText("分录币种 1")).toHaveValue("CNY");
  fireEvent.click(screen.getByLabelText("自动推导 1"));
  change("分录账户 1", "Assets:Bitcash");
  expect(screen.getByLabelText("分录币种 1")).toHaveValue("");
  fireEvent.click(screen.getByLabelText("自动推导 1"));
  expect(screen.getByLabelText("分录币种 1")).toHaveValue("JPY");
});
it("跨币种价格输入支持总价与单价，推导时清除价格，合计不误报未平衡", () => {
  render(<Harness />);
  change("分录金额 1", "10000");
  change("分录金额 2", "-430");
  change("价格换算 1", "total");
  change("换算总价 1", "430");
  change("换算币种 1", "USD");
  expect(screen.getByText(/含价格换算/)).toBeInTheDocument();
  expect(screen.queryByText(/未平衡/)).not.toBeInTheDocument();
  change("价格换算 1", "unit");
  change("汇率 / 单价 1", "0.043");
  expect(screen.getByLabelText("换算币种 1")).toHaveValue("USD");
  change("价格换算 1", "");
  expect(screen.queryByLabelText("换算币种 1")).not.toBeInTheDocument();
  change("价格换算 1", "total");
  fireEvent.click(screen.getByLabelText("自动推导 1"));
  expect(screen.getByLabelText("价格换算 1")).toBeDisabled();
  expect(screen.queryByLabelText("换算总价 1")).not.toBeInTheDocument();
});
