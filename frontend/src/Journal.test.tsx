import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import Journal from "./Journal";
import type { Journal as JournalView, Transaction } from "./api";

const settlement: Transaction = {
  id: "settlement",
  date: "2026-11-09",
  payee: "淘宝",
  narration: "订单付款结算",
  kind: "转账 / 还款",
  tags: [],
  postings: [],
  file: "txs/2026/11.bean",
  line: 10,
  raw: "结算原文",
  simple: false,
  readonly: false,
  note: "",
  metadata: { "order-ref": "purchase-key" },
  related_order: {
    key: "purchase-key",
    date: "2026-10-01",
    payee: "淘宝",
    narration: "洗碗块",
    note: "24块装",
    total: "155.86",
    currency: "CNY",
    file: "txs/2026/10.bean",
    line: 25,
    raw: "原购买分录",
  },
};
function show(row: Transaction) {
  return render(
    <Journal
      journal={{ transactions: [row], sync: "已保存" } as JournalView}
      filters={{ payee: "", narration: "", account: "" }}
      onFilter={() => {}}
      canEdit
      onEdit={() => {}}
      onDelete={() => {}}
    />,
  );
}

it("还款卡片展示冲减的负债金额，手续费和抵扣单列在分录中", () => {
  show({
    ...settlement,
    kind: "还款",
    payee: "",
    narration: "信用账户还款",
    related_order: undefined,
    metadata: {},
    postings: [
      {
        account: "Liabilities:Card",
        amount: "4772.99",
        currency: "CNY",
        note: "",
      },
      { account: "Assets:Bank", amount: "-4773.81", currency: "CNY", note: "" },
      { account: "Expenses:Fee", amount: "1.00", currency: "CNY", note: "" },
      { account: "Income:Gift", amount: "-0.18", currency: "CNY", note: "" },
    ],
  });
  expect(screen.getByTitle("还款")).toHaveTextContent("还");
  const figure = screen.getByText("还款").parentElement!;
  expect(within(figure).getByText("4,772.99 CNY")).toBeVisible();
});

it("结算流水直接展示原购买内容并可展开原文，与本条结算原文区分", () => {
  show(settlement);
  expect(screen.getByText("原购买：淘宝 · 洗碗块")).toBeInTheDocument();
  expect(screen.getByText("2026-10-01 · 155.86 CNY")).toBeInTheDocument();
  expect(screen.getByText("24块装")).toBeInTheDocument();
  fireEvent.click(screen.getByText("查看原始购买记录"));
  expect(screen.getByText("原购买分录")).toBeVisible();
  expect(screen.getByText("txs/2026/10.bean:25")).toBeVisible();
  fireEvent.click(screen.getByText("查看原文"));
  expect(screen.getByText("结算原文")).toBeVisible();
});

it("关联缺失时显示编号，不将普通流水当作订单", () => {
  const view = show({ ...settlement, related_order: null });
  expect(screen.getByRole("status")).toHaveTextContent("purchase-key");
  expect(screen.queryByText("查看原始购买记录")).not.toBeInTheDocument();
  view.unmount();
  show({ ...settlement, related_order: undefined, metadata: {} });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
