import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import AccountSelect from "./AccountSelect";

const options = [
  { value: "Assets:Bank:工行1614" },
  { value: "Assets:Cash", label: "现金 · Assets:Cash" },
  { value: "Liabilities:Card" },
];
function Harness() {
  const [value, setValue] = useState("Assets:Cash");
  return (
    <>
      <AccountSelect
        label="账户"
        required
        value={value}
        onChange={setValue}
        options={options}
      />
      <output data-testid="value">{value}</output>
      <button onClick={() => setValue("Liabilities:Card")}>外部切换</button>
    </>
  );
}
it("支持中文、账户片段和多关键词搜索，搜索文字不会提交为账户", () => {
  render(<Harness />);
  const input = screen.getByRole("combobox");
  fireEvent.focus(input);
  expect(screen.getAllByRole("option")).toHaveLength(3);
  fireEvent.change(input, { target: { value: "bank 1614" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByTestId("value")).toBeEmptyDOMElement();
  expect(input).toBeInvalid();
  fireEvent.change(input, { target: { value: "工行" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(screen.getByTestId("value")).toBeEmptyDOMElement();
  fireEvent.mouseDown(screen.getByRole("option"));
  fireEvent.click(screen.getByRole("option"));
  expect(input).toHaveValue("Assets:Bank:工行1614");
  expect(input).toBeValid();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});
it("键盘选择、Escape、失焦、无匹配和外部值变化保持一致", () => {
  render(<Harness />);
  const input = screen.getByRole("combobox");
  fireEvent.focus(input);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "ArrowUp" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input).toHaveValue(options[0].value);
  fireEvent.change(input, { target: { value: "missing" } });
  expect(screen.getByText("没有匹配账户")).toBeInTheDocument();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByTestId("value")).toBeEmptyDOMElement();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input).toHaveValue("");
  fireEvent.change(input, { target: { value: "Assets:Cash" } });
  fireEvent.blur(input);
  expect(input).toHaveValue("Assets:Cash");
  fireEvent.click(screen.getByText("外部切换"));
  expect(input).toHaveValue("Liabilities:Card");
});
it("可禁用且非必填账户允许清空", () => {
  const change = vi.fn();
  const { rerender } = render(
    <AccountSelect
      label="账户"
      value=""
      options={[]}
      onChange={change}
      disabled
    />,
  );
  expect(screen.getByRole("combobox")).toBeDisabled();
  rerender(
    <AccountSelect label="账户" value="" options={[]} onChange={change} />,
  );
  expect(screen.getByRole("combobox")).toBeValid();
});
