import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import IncomeDays from "./IncomeDays";
import type { DraftItem } from "./BatchEditor";
import type { Journal, Transaction } from "./api";

const DAYS = [
  "2026-09-24",
  "2026-09-25",
  "2026-09-26",
  "2026-09-27",
  "2026-09-28",
  "2026-09-29",
  "2026-09-30",
];

const accounts = [
  { name: "Income:Yuebao", currencies: ["CNY"] },
  { name: "Assets:Yuebao", currencies: ["CNY"] },
  { name: "Expenses:Food", currencies: ["CNY"] },
] as Journal["accounts"];

function record(date: string, id: string): Transaction {
  return {
    id,
    date,
    payee: "",
    narration: "余额宝收益",
    kind: "收入",
    tags: [],
    postings: [],
    file: "main.bean",
    line: 1,
    raw: `${date} * "余额宝收益"`,
    simple: true,
    readonly: false,
    note: "",
  };
}

/** 逐日接口返回：区间内每一天都有一行；recorded=true 时 09-28 已有记录。 */
function payload(recorded: boolean, days = DAYS) {
  return days.map((day) => ({
    date: day,
    records: recorded && day === "2026-09-28" ? [record(day, "t1")] : [],
  }));
}

function stub(data: unknown, ok = true, status = 200) {
  const mock = vi.fn(async (url: string) => ({
    ok,
    status,
    json: async () => data,
    url,
  }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

it("首次显示自动核对：展示逐日单元格，已记录日可进入更正", async () => {
  const mock = stub(payload(true));
  const onEdit = vi.fn();
  render(
    <IncomeDays
      date="2026-09-30"
      accounts={accounts}
      onAdd={vi.fn()}
      onEdit={onEdit}
    />,
  );
  expect(await screen.findByText("09-28")).toBeInTheDocument();
  expect(mock.mock.calls[0][0]).toBe(
    "/api/income/days?start=2026-09-24&end=2026-09-30",
  );
  expect(screen.getByText("09-25")).toBeInTheDocument();
  expect(screen.getByText("周五")).toBeInTheDocument();
  expect(screen.getByText("已记录")).toBeInTheDocument();
  expect(screen.getAllByText("未记录")).toHaveLength(6);
  expect(screen.getByText("2026-09-28 * \"余额宝收益\"")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "更正 2026-09-28" }));
  expect(onEdit).toHaveBeenCalledWith(
    expect.objectContaining({ id: "t1", date: "2026-09-28" }),
  );
});

it("多个空缺日期填写后提交，只有无记录已填的日期进入队列且提交后清空", async () => {
  const mock = stub(payload(true));
  const onAdd = vi.fn<(items: DraftItem[]) => boolean | void>();
  render(
    <IncomeDays date="2026-09-30" accounts={accounts} onAdd={onAdd} />,
  );
  await screen.findByText("09-28");
  expect(mock).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText("收益账户"), {
    target: { value: "Income:Yuebao" },
  });
  fireEvent.change(screen.getByLabelText("收益到账账户"), {
    target: { value: "Assets:Yuebao" },
  });
  fireEvent.change(screen.getByLabelText("实际收益 2026-09-24"), {
    target: { value: "1.23" },
  });
  fireEvent.change(screen.getByLabelText("实际收益 2026-09-25"), {
    target: { value: "2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "将已填收益加入草稿" }));
  expect(onAdd).toHaveBeenCalledTimes(1);
  expect(onAdd.mock.calls[0][0]).toEqual([
    {
      business: "yuebao",
      entry: {
        date: "2026-09-24",
        amount: "1.23",
        currency: "CNY",
        category: "Income:Yuebao",
        payment: "Assets:Yuebao",
        payee: "",
        narration: "余额宝收益",
        note: "",
      },
    },
    {
      business: "yuebao",
      entry: {
        date: "2026-09-25",
        amount: "2",
        currency: "CNY",
        category: "Income:Yuebao",
        payment: "Assets:Yuebao",
        payee: "",
        narration: "余额宝收益",
        note: "",
      },
    },
  ]);
  expect(
    (screen.getByLabelText("实际收益 2026-09-24") as HTMLInputElement).value,
  ).toBe("");
  expect(
    (screen.getByLabelText("实际收益 2026-09-25") as HTMLInputElement).value,
  ).toBe("");
});

it("onAdd 返回 false 时保留已填金额，且调用参数不变", async () => {
  stub(payload(true));
  const onAdd = vi.fn<(items: DraftItem[]) => boolean | void>(() => false);
  render(
    <IncomeDays date="2026-09-30" accounts={accounts} onAdd={onAdd} />,
  );
  await screen.findByText("09-28");
  fireEvent.change(screen.getByLabelText("收益账户"), {
    target: { value: "Income:Yuebao" },
  });
  fireEvent.change(screen.getByLabelText("收益到账账户"), {
    target: { value: "Assets:Yuebao" },
  });
  fireEvent.change(screen.getByLabelText("实际收益 2026-09-26"), {
    target: { value: "9.9" },
  });
  fireEvent.click(screen.getByRole("button", { name: "将已填收益加入草稿" }));
  expect(onAdd.mock.calls[0][0]).toEqual([
    {
      business: "yuebao",
      entry: {
        date: "2026-09-26",
        amount: "9.9",
        currency: "CNY",
        category: "Income:Yuebao",
        payment: "Assets:Yuebao",
        payee: "",
        narration: "余额宝收益",
        note: "",
      },
    },
  ]);
  expect(
    (screen.getByLabelText("实际收益 2026-09-26") as HTMLInputElement).value,
  ).toBe("9.9");
});

it("手改日期重新核对使用新参数，失败提示错误、重试成功后消失", async () => {
  const mock = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => payload(false) })
    .mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ detail: "区间过宽" }),
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => payload(false, ["2026-09-01", "2026-09-02"]),
    });
  vi.stubGlobal("fetch", mock);
  render(
    <IncomeDays date="2026-09-30" accounts={accounts} onAdd={vi.fn()} />,
  );
  await screen.findByText("09-24");
  fireEvent.change(screen.getByLabelText("收益起始日"), {
    target: { value: "2026-09-01" },
  });
  fireEvent.change(screen.getByLabelText("收益结束日"), {
    target: { value: "2026-09-05" },
  });
  fireEvent.click(screen.getByRole("button", { name: "核对日期" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("区间过宽");
  expect(mock.mock.calls[1][0]).toBe(
    "/api/income/days?start=2026-09-01&end=2026-09-05",
  );
  fireEvent.click(screen.getByRole("button", { name: "核对日期" }));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  expect(await screen.findByText("09-01")).toBeInTheDocument();
});

it("未选账户或未填有效金额时提交按钮禁用", async () => {
  stub(payload(false));
  const onAdd = vi.fn<(items: DraftItem[]) => boolean | void>();
  render(
    <IncomeDays date="2026-09-30" accounts={accounts} onAdd={onAdd} />,
  );
  await screen.findByText("09-24");
  const submit = screen.getByRole("button", { name: "将已填收益加入草稿" });
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByLabelText("实际收益 2026-09-24"), {
    target: { value: "1" },
  });
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByLabelText("收益账户"), {
    target: { value: "Income:Yuebao" },
  });
  fireEvent.change(screen.getByLabelText("收益到账账户"), {
    target: { value: "Assets:Yuebao" },
  });
  expect(submit).toBeEnabled();
  expect(screen.getByText("1.00 CNY")).toBeInTheDocument();
  expect(screen.getByText("1 天")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("实际收益 2026-09-24"), {
    target: { value: "abc" },
  });
  expect(submit).toBeDisabled();
  expect(screen.getAllByText("待填写有效金额")).toHaveLength(1);
});
