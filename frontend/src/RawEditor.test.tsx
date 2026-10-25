import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import RawEditor from "./RawEditor";
import TextComplete from "./TextComplete";
import { completeBeancount, highlightBeancount } from "./beancountEditing";

const history = {
  payees: ["Bitcash", '店 "A"'],
  narrations: ["充值", "购物"],
  currencies: ["CNY", "JPY"],
  tags: ["topup"],
  links: ["receipt"],
};
const accounts = ["Assets:Bank", "Assets:Bitcash"];
function Harness({ initial = "" }) {
  const [value, setValue] = useState(initial);
  return (
    <RawEditor
      label="原文"
      value={value}
      onChange={setValue}
      completions={history}
      accounts={accounts.map((name) => ({ name, currencies: ["CNY", "JPY"] }))}
    />
  );
}
function type(text: string, cursor = text.length) {
  const input = screen.getByLabelText("原文");
  fireEvent.change(input, {
    target: { value: text, selectionStart: cursor, selectionEnd: cursor },
  });
  return input;
}
it("原文上下选择与 Tab 补全替换整个光标词，保留后续金额并定位光标", () => {
  render(<Harness />);
  const text = '2026-10-24 * "Bitcash" "充值"\n  Assets:B 10000 JPY';
  const input = type(text, text.indexOf(" 10000"));
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input).toHaveValue(text.replace("Assets:B", "Assets:Bitcash"));
  expect((input as HTMLTextAreaElement).selectionStart).toBe(
    text.indexOf("Assets:B") + "Assets:Bitcash".length,
  );
  fireEvent.scroll(input, { target: { scrollTop: 40, scrollLeft: 20 } });
  expect(document.querySelector(".raw-highlight code")).toHaveStyle({
    transform: "translate(-20px, -40px)",
  });
});
it("原文补全支持手动唤起、关闭、鼠标选择及输入法，不占用 Ctrl+Enter", () => {
  const submitKey = vi.fn();
  render(
    <div
      onKeyDown={(e) => {
        if (e.ctrlKey && e.key === "Enter") submitKey();
      }}
    >
      <Harness />
    </div>,
  );
  const input = type("  Assets:B");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "ArrowUp" });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  fireEvent.keyDown(input, { key: " ", code: "Space", ctrlKey: true });
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  expect(submitKey).toHaveBeenCalledOnce();
  fireEvent.compositionStart(input);
  type("  Assets:Bi");
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(input).toHaveValue("  Assets:Bi");
  fireEvent.compositionEnd(input);
  fireEvent.mouseDown(screen.getByRole("option", { name: "Assets:Bitcash" }));
  fireEvent.click(screen.getByRole("option", { name: "Assets:Bitcash" }));
  expect(input).toHaveValue("  Assets:Bitcash");
  type("  Assets:B");
  fireEvent.keyDown(input, { key: "ArrowLeft" });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  type("  Assets:");
  fireEvent.blur(input);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});
it("商户与摘要补全根据引号位置识别，并正确转义", () => {
  render(<Harness />);
  const input = type('2026-10-24 * "店" "充值"', '2026-10-24 * "店'.length);
  fireEvent.click(screen.getByRole("option", { name: '店 "A"' }));
  expect(input).toHaveValue(
    `2026-10-24 * ${JSON.stringify('店 "A"')} "充值"`,
  );
  type('2026-10-24 * "Bitcash" "充');
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input).toHaveValue('2026-10-24 * "Bitcash" "充值');
});
it.each([
  ["  Assets:B", "Assets:Bank"],
  ["2026-10-24 balance Assets:B", "Assets:Bank"],
  ["  Assets:Bank 10 J", "JPY"],
  ["2026-10-24 ba", "balance"],
  ['2026-10-24 * "店" #to', "#topup"],
  ['2026-10-24 * "店" ^re', "^receipt"],
])("原文候选上下文 %s", (text, expected) => {
  expect(
    completeBeancount(text, text.length, accounts, history)?.options.map(
      (o) => o.label,
    ),
  ).toContain(expected);
});
it.each([
  "; Assets:B",
  '  memo: "Bit',
  '2026-10-24 * "x" "y" "Bi',
  "random",
  "  ",
  "  Assets:Missing",
])("注释、元数据和未匹配输入不弹出无关候选：%s", (text) => {
  expect(
    completeBeancount(text, text.length, accounts, history),
  ).toBeUndefined();
});
it("空行可显式补全账户，高亮不会改变或执行原文", () => {
  expect(
    completeBeancount("  ", 2, accounts, history, true)?.options,
  ).toHaveLength(2);
  const text =
    '2026-10-24 * "<img src=x>" #tag ^link\n  Assets:Bank -10000 JPY @@ 430 CNY\n; comment';
  const tokens = highlightBeancount(text);
  expect(tokens.map((t) => t.text).join("")).toBe(text);
  expect(new Set(tokens.map((t) => t.kind))).toEqual(
    new Set([
      undefined,
      "date",
      "string",
      "tag",
      "account",
      "number",
      "keyword",
      "operator",
      "comment",
    ]),
  );
  render(<Harness initial={text} />);
  expect(document.querySelector("img")).toBeNull();
});
it("自由文本补全可关闭、键盘重开，输入法和 Ctrl+Enter 不选中候选", () => {
  const onChange = vi.fn();
  render(
    <TextComplete
      label="商户"
      value=""
      options={history.payees}
      onChange={onChange}
    />,
  );
  const input = screen.getByLabelText("商户");
  fireEvent.focus(input);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "ArrowUp" });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Escape" });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith("Bitcash");
});
