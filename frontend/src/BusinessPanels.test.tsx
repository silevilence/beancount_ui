import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import Finance from "./Finance";
import IncomeDays from "./IncomeDays";
import Orders from "./Orders";
import type { Transaction } from "./api";

const accounts = [
  "Assets:Cash",
  "Assets:Yuebao",
  "Liabilities:Card",
  "Income:Interest",
  "Expenses:Food",
].map((name) => ({ name, currencies: ["CNY"] }));
const set = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const ok = (data: unknown) => ({ ok: true, json: async () => data });
const bad = () => ({
  ok: false,
  status: 409,
  json: async () => ({ detail: "测试失败，请重试" }),
});

it("转账、手续费和日初余额核对生成明确分录，变更日期使结果过期", async () => {
  const onAdd = vi.fn();
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    return ok(
      body.kind === "balance"
        ? {
            business: "balance",
            raw: "balance text",
            actual: "90",
            expected: "100",
            difference: "-10",
          }
        : { business: "ordinary", raw: "transfer text" },
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const props = { date: "2026-09-30", accounts, onAdd };
  const mounted = render(<Finance {...props} />);
  set("转出账户", "Assets:Cash");
  set("转入 / 还款账户", "Liabilities:Card");
  set("转入金额", "20");
  set("手续费", "1");
  set("手续费分类", "Expenses:Food");
  set("账户备注", "还款");
  set("账户币种", "CNY");
  fireEvent.click(screen.getByText("生成分录 / 核对差额"));
  fireEvent.click(await screen.findByText("将核对结果加入草稿"));
  expect(onAdd).toHaveBeenCalledWith({
    business: "ordinary",
    raw: "transfer text",
  });
  set("账户业务", "repayment");
  set("转入金额", "10");
  fireEvent.click(screen.getByText("生成分录 / 核对差额"));
  await screen.findByText("transfer text");
  set("账户业务", "balance");
  set("预期余额", "100");
  fireEvent.click(screen.getByText("生成分录 / 核对差额"));
  await screen.findByText(/账面实际 90/);
  mounted.rerender(<Finance {...props} date="2026-10-01" />);
  expect(screen.queryByText("将核对结果加入草稿")).not.toBeInTheDocument();
  fetcher.mockImplementationOnce(async () => bad());
  fireEvent.click(screen.getByText("生成分录 / 核对差额"));
  await screen.findByText(/测试失败/);
});

it("逐日收益只加入已填写缺口，已有记录明确更正，失败保留输入", async () => {
  const row = { id: "r", raw: "收益原文" } as Transaction;
  const fetcher = vi.fn(async () =>
    ok([
      { date: "2026-09-29", records: [] },
      { date: "2026-09-30", records: [row] },
    ]),
  );
  vi.stubGlobal("fetch", fetcher);
  const onAdd = vi.fn(),
    onEdit = vi.fn();
  render(
    <IncomeDays
      date="2026-09-30"
      accounts={accounts}
      onAdd={onAdd}
      onEdit={onEdit}
    />,
  );
  set("收益起始日", "2026-09-29");
  set("收益结束日", "2026-09-30");
  fireEvent.click(screen.getByText("核对日期"));
  await screen.findByText("收益原文");
  set("收益账户", "Income:Interest");
  set("收益到账账户", "Assets:Yuebao");
  set("实际收益 2026-09-29", "0.12");
  fireEvent.click(screen.getByText("将已填收益加入草稿"));
  expect(onAdd.mock.lastCall![0]).toHaveLength(1);
  expect(onAdd.mock.lastCall![0][0]).toMatchObject({
    business: "yuebao",
    entry: { amount: "0.12", date: "2026-09-29" },
  });
  fireEvent.click(screen.getByText("更正 2026-09-30"));
  expect(onEdit).toHaveBeenCalledWith(row);
  fetcher.mockImplementationOnce(async () => bad());
  fireEvent.click(screen.getByText("核对日期"));
  await screen.findByText(/测试失败/);
});

it("结算和退款须确认关联，取消关联不入账", async () => {
  const row = {
    id: "order",
    date: "2026-09-29",
    payee: "淘宝",
    narration: "商品",
    mode: "deferred",
    total: "100",
    unpaid: "70",
    refunded: "0",
    currency: "CNY",
    account: "Liabilities:Card",
    categories: { "Expenses:Food": "100" },
  };
  const fetcher = vi.fn(async () => ok([row]));
  vi.stubGlobal("fetch", fetcher);
  const onAdd = vi.fn();
  render(<Orders date="2026-09-30" accounts={accounts} onAdd={onAdd} />);
  await screen.findByRole("option", { name: /商品/ });
  set("关联订单", "order");
  expect(screen.getByLabelText("本次处理金额")).toHaveValue("70");
  set("实际付款 / 收款账户", "Assets:Cash");
  set("处理备注", "部分收货");
  set("本次处理金额", "30");
  expect(screen.getByText("将处理加入草稿")).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByText("将处理加入草稿"));
  expect(onAdd.mock.lastCall![0].order).toMatchObject({
    kind: "settle",
    amount: "30",
    source_id: "order",
  });
  set("处理方式", "refund_unpaid");
  set("本次处理金额", "10");
  set("原费用类别", "Expenses:Food");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByText("将处理加入草稿"));
  expect(onAdd.mock.lastCall![0].order.account).toBe("Liabilities:Card");
  set("处理方式", "refund_paid");
  set("本次处理金额", "5");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByText("取消关联"));
  expect(screen.getByText("将处理加入草稿")).toBeDisabled();
  expect(onAdd).toHaveBeenCalledTimes(2);
  fetcher.mockImplementationOnce(async () => bad());
  fireEvent.click(screen.getByText("刷新订单"));
  await screen.findByText(/测试失败/);
  fireEvent.click(screen.getByText("刷新订单"));
  await waitFor(() =>
    expect(screen.queryByText(/测试失败/)).not.toBeInTheDocument(),
  );
});
