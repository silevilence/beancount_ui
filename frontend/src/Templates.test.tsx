import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import Templates from "./Templates";
import type { Journal } from "./api";
import type { EntryFields } from "./Editor";

const KEY = "beancount-ui.templates.v1.test";

const journal = { identity: "test", date: "2026-09-30" } as Journal;

const fields: EntryFields = {
  date: "2026-09-30",
  payee: "淘宝",
  narration: "购物",
  amount: "100",
  currency: "CNY",
  category: "Expenses:Food",
  payment: "Assets:Cash",
  note: "私密备注",
};

const accounts: Journal["accounts"] = [
  { name: "Expenses:Food", currencies: ["CNY"] },
  { name: "Assets:Cash", currencies: ["CNY"] },
];

/** 在模板管理区按名称定位到行，再点击该行的启用 / 停用按钮。 */
function clickRowToggle(container: HTMLElement, name: string, label: string) {
  const row = Array.from(container.querySelectorAll(".template-row")).find(
    (element) => element.textContent?.startsWith(name),
  );
  if (!row) throw new Error(`未找到模板行：${name}`);
  fireEvent.click(
    within(row as HTMLElement).getByRole("button", { name: label }),
  );
}

it("无存储时回退内置模板，快捷入口标出业务类型并可套用", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => [] })),
  );
  const onApply = vi.fn();
  render(
    <Templates
      journal={journal}
      fields={fields}
      business="ordinary"
      accounts={accounts}
      onApply={onApply}
    />,
  );
  const salary = screen.getByRole("button", { name: "工资 / 奖金" });
  expect(
    within(screen.getByRole("button", { name: "餐饮" })).getByText("日常消费"),
  ).toBeInTheDocument();
  expect(screen.getByText("模板管理")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "停用" })).toHaveLength(7);
  fireEvent.click(salary);
  expect(onApply).toHaveBeenLastCalledWith(
    expect.objectContaining({
      name: "工资 / 奖金",
      business: "salary",
      narration: "工资",
      category: "",
      payment: "",
      currency: "CNY",
    }),
  );
});

it("固定当前组合只落模板字段，同名再固定为覆盖", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => [] })),
  );
  const onApply = vi.fn();
  const { rerender } = render(
    <Templates
      journal={journal}
      fields={fields}
      business="ordinary"
      accounts={accounts}
      onApply={onApply}
    />,
  );
  fireEvent.change(screen.getByLabelText("模板名称"), {
    target: { value: "周末采购" },
  });
  fireEvent.click(screen.getByText("将当前组合固定为模板"));
  let saved = JSON.parse(localStorage.getItem(KEY)!);
  expect(saved).toHaveLength(8);
  expect(saved.at(-1)).toEqual({
    name: "周末采购",
    business: "ordinary",
    payee: "淘宝",
    narration: "购物",
    category: "Expenses:Food",
    payment: "Assets:Cash",
    currency: "CNY",
  });
  rerender(
    <Templates
      journal={journal}
      fields={{ ...fields, narration: "日用品" }}
      business="ordinary"
      accounts={accounts}
      onApply={onApply}
    />,
  );
  fireEvent.click(screen.getByText("将当前组合固定为模板"));
  saved = JSON.parse(localStorage.getItem(KEY)!);
  const pinned = saved.filter(
    (item: { name: string }) => item.name === "周末采购",
  );
  expect(saved).toHaveLength(8);
  expect(pinned).toEqual([
    {
      name: "周末采购",
      business: "ordinary",
      payee: "淘宝",
      narration: "日用品",
      category: "Expenses:Food",
      payment: "Assets:Cash",
      currency: "CNY",
    },
  ]);
  expect(pinned[0]).not.toHaveProperty("date");
  expect(pinned[0]).not.toHaveProperty("amount");
  expect(pinned[0]).not.toHaveProperty("note");
});

it("套用模板时按现有科目过滤分类与付款账户", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => [] })),
  );
  localStorage.setItem(
    KEY,
    JSON.stringify([
      {
        name: "外卖",
        business: "ordinary",
        payee: "美团",
        narration: "午餐",
        category: "Expenses:Food",
        payment: "Assets:Cash",
        currency: "CNY",
      },
    ]),
  );
  const onApply = vi.fn();
  const { rerender } = render(
    <Templates
      journal={journal}
      fields={fields}
      business="ordinary"
      accounts={accounts}
      onApply={onApply}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "外卖" }));
  expect(onApply).toHaveBeenLastCalledWith(
    expect.objectContaining({
      category: "Expenses:Food",
      payment: "Assets:Cash",
    }),
  );
  rerender(
    <Templates
      journal={journal}
      fields={fields}
      business="ordinary"
      accounts={[{ name: "Assets:Bank", currencies: ["CNY"] }]}
      onApply={onApply}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "外卖" }));
  expect(onApply).toHaveBeenLastCalledWith(
    expect.objectContaining({ category: "", payment: "" }),
  );
});

it("停用后退出快捷入口并持久化，启用后恢复", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => [] })),
  );
  const onApply = vi.fn();
  const { container, unmount } = render(
    <Templates
      journal={journal}
      fields={fields}
      business="ordinary"
      accounts={accounts}
      onApply={onApply}
    />,
  );
  clickRowToggle(container, "餐饮", "停用");
  expect(
    screen.queryByRole("button", { name: "餐饮" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "启用" })).toBeInTheDocument();
  const stored = JSON.parse(localStorage.getItem(KEY)!);
  expect(stored[2]).toMatchObject({ name: "餐饮", disabled: true });
  unmount();
  const remount = render(
    <Templates
      journal={journal}
      fields={fields}
      business="ordinary"
      accounts={accounts}
      onApply={onApply}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "餐饮" }),
  ).not.toBeInTheDocument();
  clickRowToggle(remount.container, "餐饮", "启用");
  expect(screen.getByRole("button", { name: "餐饮" })).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem(KEY)!)[2]).toMatchObject({
    disabled: false,
  });
});

it("本地存储写入失败时提示错误且不改动模板列表", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => [] })),
  );
  const setItem = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
  const onApply = vi.fn();
  render(
    <Templates
      journal={journal}
      fields={fields}
      business="ordinary"
      accounts={accounts}
      onApply={onApply}
    />,
  );
  fireEvent.change(screen.getByLabelText("模板名称"), {
    target: { value: "新模板" },
  });
  fireEvent.click(screen.getByText("将当前组合固定为模板"));
  expect(screen.getByRole("alert")).toHaveTextContent("模板未保存");
  expect(
    screen.queryByRole("button", { name: "新模板" }),
  ).not.toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "停用" })).toHaveLength(7);
  setItem.mockRestore();
});

it("加载服务端推荐并可套用，分类为空时提示选择分类", async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => [
      {
        name: "最近外卖",
        business: "ordinary",
        payee: "美团",
        narration: "外卖",
        category: "Expenses:Food",
        payment: "",
        currency: "CNY",
      },
      {
        name: "最近打车",
        business: "ordinary",
        payee: "",
        narration: "打车",
        category: "",
        payment: "",
        currency: "CNY",
      },
    ],
  }));
  vi.stubGlobal("fetch", fetchMock);
  const onApply = vi.fn();
  render(
    <Templates
      journal={journal}
      fields={fields}
      business="ordinary"
      accounts={accounts}
      onApply={onApply}
    />,
  );
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/templates?day=2026-09-30",
    undefined,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "美团 · Expenses:Food" }),
  );
  expect(onApply).toHaveBeenLastCalledWith(
    expect.objectContaining({
      payee: "美团",
      narration: "外卖",
      category: "Expenses:Food",
      payment: "",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "打车 · 请选择分类" }));
  expect(onApply).toHaveBeenLastCalledWith(
    expect.objectContaining({ payee: "", narration: "打车" }),
  );
});

it("推荐接口失败时提示错误并保留空态", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ detail: "模板服务暂不可用" }),
    })),
  );
  const onApply = vi.fn();
  render(
    <Templates
      journal={journal}
      fields={fields}
      business="ordinary"
      accounts={accounts}
      onApply={onApply}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "推荐加载失败：模板服务暂不可用",
  );
  expect(
    screen.getByText("最近暂无可用推荐，先记几笔后自动出现。"),
  ).toBeInTheDocument();
});

it("quick 模式只渲染快捷入口", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => [] })),
  );
  const onApply = vi.fn();
  render(
    <Templates
      journal={journal}
      fields={fields}
      business="ordinary"
      accounts={accounts}
      onApply={onApply}
      mode="quick"
    />,
  );
  expect(screen.getByRole("button", { name: "餐饮" })).toBeInTheDocument();
  expect(screen.queryByText("将当前组合固定为模板")).not.toBeInTheDocument();
  expect(screen.queryByText("模板管理")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("模板名称")).not.toBeInTheDocument();
  expect(
    screen.queryByText("最近暂无可用推荐，先记几笔后自动出现。"),
  ).not.toBeInTheDocument();
});
