import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import Orders from "./Orders";
import type { Journal } from "./api";
import type { DraftItem } from "./BatchEditor";

interface TestOrder {
  id: string;
  date: string;
  payee: string;
  narration: string;
  mode: string;
  total: string;
  unpaid: string;
  refunded: string;
  currency: string;
  account: string;
  categories: Record<string, string>;
}

const ORDERS: TestOrder[] = [
  {
    id: "o1",
    date: "2026-09-12",
    payee: "老张百货",
    narration: "日用品",
    mode: "deferred",
    total: "268.00",
    unpaid: "268.00",
    refunded: "0.00",
    currency: "CNY",
    account: "Liabilities:TaobaoPayable",
    categories: { "Expenses:Daily": "268.00" },
  },
  {
    id: "o2",
    date: "2026-09-18",
    payee: "云记数码",
    narration: "键盘",
    mode: "paid",
    total: "680.00",
    unpaid: "0.00",
    refunded: "120.00",
    currency: "CNY",
    account: "Assets:Cash",
    categories: {
      "Expenses:Digital": "560.00",
      "Expenses:Accessory": "120.00",
    },
  },
  {
    id: "o3",
    date: "2026-09-21",
    payee: "菜市",
    narration: "生鲜",
    mode: "deferred",
    total: "88.50",
    unpaid: "88.50",
    refunded: "0.00",
    currency: "CNY",
    account: "Liabilities:TaobaoPayable",
    categories: { "Expenses:Food": "88.50" },
  },
  {
    id: "o4",
    date: "2026-09-22",
    payee: "街角食堂",
    narration: "午饭",
    mode: "historical",
    total: "25.50",
    unpaid: "25.50",
    refunded: "5.00",
    currency: "CNY",
    account: "Assets:Cash",
    categories: { "Expenses:Food": "25.50" },
  },
];

const ACCOUNTS: Journal["accounts"] = [
  { name: "Assets:Cash", currencies: ["CNY"] },
  { name: "Assets:Bank", currencies: ["CNY"] },
  { name: "Liabilities:TaobaoPayable", currencies: ["CNY"] },
  { name: "Expenses:Digital", currencies: ["CNY"] },
  { name: "Income:Refund", currencies: ["CNY"] },
];

const CONFIRM = "我已确认关联交易及负债 / 付款语义";
const SUBMIT = "将处理加入草稿";

function stubOrders(data: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => data })),
  );
}

function mount(onAdd: (item: DraftItem) => boolean | void = vi.fn(() => true)) {
  render(<Orders date="2026-09-30" accounts={ACCOUNTS} onAdd={onAdd} />);
}

it("渲染历史订单列表与状态芯片，未选择时提示先选订单", async () => {
  stubOrders(ORDERS);
  mount();
  expect(
    await screen.findByText("老张百货 · 日用品"),
  ).toBeInTheDocument();
  expect(screen.getByText("云记数码 · 键盘")).toBeInTheDocument();
  expect(screen.getByText("菜市 · 生鲜")).toBeInTheDocument();
  expect(screen.getByText("2026-09-12 · Liabilities:TaobaoPayable")).toBeInTheDocument();
  expect(screen.getByText("268.00 CNY")).toBeInTheDocument();
  expect(screen.getByText("680.00 CNY")).toBeInTheDocument();
  // o2 直接付款 + 已退款，o1/o3 挂账未结清且不显示已退款芯片；o4 为历史记录
  expect(screen.getByText("直接付款")).toBeInTheDocument();
  expect(screen.getByText("挂账未结清 268.00 CNY")).toBeInTheDocument();
  expect(screen.getByText("挂账未结清 88.50 CNY")).toBeInTheDocument();
  expect(screen.getByText("历史记录 · 可结算 25.50 CNY")).toBeInTheDocument();
  expect(screen.getByText("已退款 120.00 CNY")).toBeInTheDocument();
  expect(screen.queryAllByText(/已退款/)).toHaveLength(2);
  // 未选择订单：处理区空态、提交按钮禁用
  expect(screen.getByText(/先在上方选择一个历史订单/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: SUBMIT })).toBeDisabled();
});

it("settle：deferred 订单金额默认未结清，账户必填并可加入草稿", async () => {
  stubOrders(ORDERS);
  const onAdd = vi.fn<(item: DraftItem) => boolean | void>(() => true);
  mount(onAdd);
  fireEvent.click(await screen.findByText("老张百货 · 日用品"));
  expect(screen.getByLabelText("本次处理金额")).toHaveValue("268.00");
  expect(screen.getByText(/结算只结转负债、不再生成消费/)).toBeInTheDocument();
  const submit = screen.getByRole("button", { name: SUBMIT });
  expect(submit).toBeDisabled();
  // 账户下拉只列资产 / 负债，费用与收入账户不出现
  expect(
    screen.queryByRole("option", { name: "Expenses:Digital" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: "Income:Refund" }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("实际付款 / 收款账户"), {
    target: { value: "Assets:Cash" },
  });
  fireEvent.click(screen.getByLabelText(CONFIRM));
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
  expect(onAdd).toHaveBeenCalledWith({
    business: "ordinary",
    order: {
      kind: "settle",
      source_id: "o1",
      date: "2026-09-30",
      amount: "268.00",
      account: "Assets:Cash",
      category: "Expenses:Daily",
      note: "",
    },
  });
  // 成功后清空金额与勾选，保留选中订单
  expect(screen.getByLabelText("本次处理金额")).toHaveValue("");
  expect(screen.getByLabelText(CONFIRM)).not.toBeChecked();
  expect(screen.getByRole("button", { name: SUBMIT })).toBeDisabled();
  expect(screen.getByText("老张百货 · 日用品").closest("button")).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

it("refund_unpaid：不选账户，入草稿时用原订单账户", async () => {
  stubOrders(ORDERS);
  const onAdd = vi.fn<(item: DraftItem) => boolean | void>(() => true);
  mount(onAdd);
  fireEvent.click(await screen.findByText("菜市 · 生鲜"));
  fireEvent.click(screen.getByRole("button", { name: "未结算负债冲回" }));
  expect(screen.getByText(/未结算冲回减少原待付款负债/)).toBeInTheDocument();
  expect(screen.queryByLabelText("实际付款 / 收款账户")).not.toBeInTheDocument();
  expect(screen.getByLabelText("原费用类别")).toHaveValue("Expenses:Food");
  fireEvent.click(screen.getByLabelText(CONFIRM));
  fireEvent.click(screen.getByRole("button", { name: SUBMIT }));
  expect(onAdd.mock.calls[0][0]).toEqual({
    business: "ordinary",
    order: {
      kind: "refund_unpaid",
      source_id: "o3",
      date: "2026-09-30",
      amount: "88.50",
      account: "Liabilities:TaobaoPayable",
      category: "Expenses:Food",
      note: "",
    },
  });
});

it("refund_paid：按已付款订单处理，可冲回类别进入 payload", async () => {
  stubOrders(ORDERS);
  const onAdd = vi.fn<(item: DraftItem) => boolean | void>(() => true);
  mount(onAdd);
  fireEvent.click(await screen.findByText("云记数码 · 键盘"));
  // 直接付款订单没有未结清金额，默认留空由用户填写
  expect(screen.getByLabelText("本次处理金额")).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "已付款退款" }));
  expect(screen.getByText(/已付款退款冲回原费用/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("本次处理金额"), {
    target: { value: "120.00" },
  });
  fireEvent.change(screen.getByLabelText("实际付款 / 收款账户"), {
    target: { value: "Assets:Bank" },
  });
  fireEvent.change(screen.getByLabelText("原费用类别"), {
    target: { value: "Expenses:Accessory" },
  });
  expect(screen.getByText(/可冲回 120\.00 CNY/)).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText(CONFIRM));
  fireEvent.click(screen.getByRole("button", { name: SUBMIT }));
  expect(onAdd.mock.calls[0][0]).toEqual({
    business: "ordinary",
    order: {
      kind: "refund_paid",
      source_id: "o2",
      date: "2026-09-30",
      amount: "120.00",
      account: "Assets:Bank",
      category: "Expenses:Accessory",
      note: "",
    },
  });
});

it("确认勾选控制提交：切换处理方式或改动金额会清除勾选", async () => {
  stubOrders(ORDERS);
  mount();
  fireEvent.click(await screen.findByText("老张百货 · 日用品"));
  const submit = screen.getByRole("button", { name: SUBMIT });
  fireEvent.change(screen.getByLabelText("实际付款 / 收款账户"), {
    target: { value: "Assets:Cash" },
  });
  fireEvent.click(screen.getByLabelText(CONFIRM));
  expect(submit).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "已付款退款" }));
  expect(screen.getByLabelText(CONFIRM)).not.toBeChecked();
  expect(submit).toBeDisabled();
  fireEvent.click(screen.getByLabelText(CONFIRM));
  expect(submit).toBeEnabled();
  fireEvent.change(screen.getByLabelText("本次处理金额"), {
    target: { value: "100.00" },
  });
  expect(screen.getByLabelText(CONFIRM)).not.toBeChecked();
  expect(submit).toBeDisabled();
});

it("取消关联：清空选中、金额与勾选并回到初始禁用态", async () => {
  stubOrders(ORDERS);
  mount();
  fireEvent.click(await screen.findByText("老张百货 · 日用品"));
  fireEvent.click(screen.getByLabelText(CONFIRM));
  expect(screen.getByRole("button", { name: SUBMIT })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "取消关联" }));
  expect(screen.queryByLabelText(CONFIRM)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: SUBMIT })).toBeDisabled();
  expect(screen.queryByLabelText("本次处理金额")).not.toBeInTheDocument();
  expect(screen.getByText(/先在上方选择一个历史订单/)).toBeInTheDocument();
  expect(screen.getByText("老张百货 · 日用品").closest("button")).toHaveAttribute(
    "aria-selected",
    "false",
  );
});

it("onAdd 返回 false 时保留表单内容", async () => {
  stubOrders(ORDERS);
  const onAdd = vi.fn<(item: DraftItem) => boolean | void>(() => false);
  mount(onAdd);
  fireEvent.click(await screen.findByText("老张百货 · 日用品"));
  fireEvent.change(screen.getByLabelText("实际付款 / 收款账户"), {
    target: { value: "Assets:Cash" },
  });
  fireEvent.click(screen.getByLabelText(CONFIRM));
  fireEvent.click(screen.getByRole("button", { name: SUBMIT }));
  expect(onAdd).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("本次处理金额")).toHaveValue("268.00");
  expect(screen.getByLabelText(CONFIRM)).toBeChecked();
});

it("切换订单会重置金额与勾选", async () => {
  stubOrders(ORDERS);
  mount();
  fireEvent.click(await screen.findByText("老张百货 · 日用品"));
  fireEvent.click(screen.getByLabelText(CONFIRM));
  expect(screen.getByLabelText(CONFIRM)).toBeChecked();
  fireEvent.click(screen.getByText("菜市 · 生鲜"));
  expect(screen.getByLabelText("本次处理金额")).toHaveValue("88.50");
  expect(screen.getByLabelText(CONFIRM)).not.toBeChecked();
  expect(screen.getByText("菜市 · 生鲜").closest("button")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByText("老张百货 · 日用品").closest("button")).toHaveAttribute(
    "aria-selected",
    "false",
  );
});

it("没有历史订单时给出空态提示", async () => {
  stubOrders([]);
  mount();
  expect(
    await screen.findByText("没有可处理的历史订单"),
  ).toBeInTheDocument();
  expect(screen.queryByText(/挂账未结清/)).not.toBeInTheDocument();
});

it("刷新订单失败显示错误，再次刷新成功后错误消失", async () => {
  let fail = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      fail
        ? {
            ok: false,
            status: 409,
            json: async () => ({ detail: "订单服务不可用" }),
          }
        : { ok: true, status: 200, json: async () => ORDERS },
    ),
  );
  mount();
  expect(await screen.findByText("老张百货 · 日用品")).toBeInTheDocument();
  fail = true;
  fireEvent.click(screen.getByRole("button", { name: "刷新订单" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("订单服务不可用");
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "刷新订单" }));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  expect(screen.getByText("老张百货 · 日用品")).toBeInTheDocument();
});
