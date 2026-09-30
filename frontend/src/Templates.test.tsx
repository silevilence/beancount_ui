import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import Templates from "./Templates";
import type { Journal } from "./api";

it("模板固定、调整、停用及账户有效性过滤，不持久化日期金额", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => [] })),
  );
  const onApply = vi.fn();
  const fields = {
    date: "2026-09-30",
    amount: "100",
    payee: "淘宝",
    narration: "购物",
    currency: "CNY",
    category: "Expenses:Food",
    payment: "Assets:Cash",
    note: "private",
  };
  const journal = { identity: "test" } as Journal;
  const { unmount } = render(
    <Templates
      journal={journal}
      fields={fields}
      business="ordinary"
      accounts={[]}
      onApply={onApply}
    />,
  );
  fireEvent.change(screen.getByLabelText("模板名称"), {
    target: { value: "常用" },
  });
  fireEvent.click(screen.getByText("将当前组合固定为模板"));
  const saved = JSON.parse(
    localStorage.getItem("beancount-ui.templates.v1.test")!,
  );
  expect(saved.at(-1)).not.toHaveProperty("amount");
  expect(saved.at(-1)).not.toHaveProperty("date");
  fireEvent.click(screen.getByRole("button", { name: "常用" }));
  expect(onApply.mock.lastCall![0]).toMatchObject({
    category: "",
    payment: "",
    business: "ordinary",
  });
  fireEvent.click(screen.getAllByText("停用").at(-1)!);
  expect(
    screen.queryByRole("button", { name: "常用" }),
  ).not.toBeInTheDocument();
  unmount();
  render(
    <Templates
      journal={journal}
      fields={fields}
      business="ordinary"
      accounts={[]}
      onApply={onApply}
    />,
  );
  expect(screen.getByText("启用")).toBeInTheDocument();
});
