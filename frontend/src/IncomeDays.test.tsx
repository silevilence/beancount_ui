import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { StrictMode } from "react";
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

it("默认账户随候选加载，只选择唯一余额宝账户，失效后禁止提交", async () => {
  stub(payload(false));
  const onAdd = vi.fn();
  const view = render(
    <IncomeDays date="2026-09-30" accounts={[]} onAdd={onAdd} />,
  );
  await screen.findByText("09-24");
  expect(screen.getByLabelText("收益账户")).toHaveValue("");
  view.rerender(
    <IncomeDays date="2026-09-30" accounts={accounts} onAdd={onAdd} />,
  );
  expect(screen.getByLabelText("收益账户")).toHaveValue("Income:Yuebao");
  expect(screen.getByLabelText("收益到账账户")).toHaveValue("Assets:Yuebao");
  fireEvent.change(screen.getByLabelText("实际收益 2026-09-24"), {
    target: { value: "0.42" },
  });
  expect(
    screen.getByRole("button", { name: "将已填收益加入草稿" }),
  ).toBeEnabled();
  view.rerender(
    <IncomeDays
      date="2026-09-30"
      accounts={[...accounts, { name: "Assets:Other:余额宝", currencies: [] }]}
      onAdd={onAdd}
    />,
  );
  expect(screen.getByLabelText("收益到账账户")).toHaveValue("");
  expect(
    screen.getByRole("button", { name: "将已填收益加入草稿" }),
  ).toBeDisabled();
  view.rerender(
    <IncomeDays
      date="2026-09-30"
      accounts={accounts}
      selectedAccounts={{ category: "Income:Closed", payment: "Assets:Closed" }}
      onAccountsChange={vi.fn()}
      onAdd={onAdd}
    />,
  );
  expect(screen.getByLabelText("收益账户")).toHaveValue("");
  expect(screen.getByLabelText("收益到账账户")).toHaveValue("");
  expect(
    screen.getByRole("button", { name: "将已填收益加入草稿" }),
  ).toBeDisabled();
});

it("默认区间跨天刷新，已填金额仍归原日期并使用默认账户加入草稿", async () => {
  const mock = stub(payload(false));
  const onAdd = vi.fn();
  const view = render(
    <IncomeDays date="2026-09-30" accounts={accounts} onAdd={onAdd} />,
  );
  fireEvent.change(await screen.findByLabelText("实际收益 2026-09-30"), {
    target: { value: "0.42" },
  });
  mock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => payload(false, ["2026-09-30", "2026-10-01"]),
    url: "",
  });
  view.rerender(
    <IncomeDays date="2026-10-01" accounts={accounts} onAdd={onAdd} />,
  );
  await screen.findByLabelText("实际收益 2026-10-01");
  expect(screen.getByLabelText("实际收益 2026-09-30")).toHaveValue("0.42");
  expect(screen.getByLabelText("实际收益 2026-10-01")).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "将已填收益加入草稿" }));
  expect(onAdd).toHaveBeenCalledWith([
    expect.objectContaining({
      entry: expect.objectContaining({
        date: "2026-09-30",
        amount: "0.42",
        category: "Income:Yuebao",
        payment: "Assets:Yuebao",
      }),
    }),
  ]);
});

it("旧日期查询晚返回时不会覆盖新的区间", async () => {
  let finish!: (value: unknown) => void;
  const mock = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({
      ok: true,
      json: async () => payload(false, ["2026-10-01"]),
    });
  vi.stubGlobal("fetch", mock);
  const view = render(
    <IncomeDays date="2026-09-30" accounts={accounts} onAdd={vi.fn()} />,
  );
  view.rerender(
    <IncomeDays date="2026-10-01" accounts={accounts} onAdd={vi.fn()} />,
  );
  await screen.findByLabelText("实际收益 2026-10-01");
  await act(async () => {
    finish({ ok: true, json: async () => payload(false) });
  });
  expect(
    screen.queryByLabelText("实际收益 2026-09-24"),
  ).not.toBeInTheDocument();
  expect(screen.getByLabelText("实际收益 2026-10-01")).toBeInTheDocument();
});

it("严格模式下重新进入手动区间仍完成核对", async () => {
  stub(payload(false));
  render(
    <StrictMode>
      <IncomeDays
        date="2026-10-06"
        range={{ start: "2026-09-24", end: "2026-09-30" }}
        onRangeChange={vi.fn()}
        accounts={accounts}
        onAdd={vi.fn()}
      />
    </StrictMode>,
  );
  expect(
    await screen.findByLabelText("实际收益 2026-09-24"),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "核对日期" })).toBeEnabled();
});

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
  expect(screen.getByText('2026-09-28 * "余额宝收益"')).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "更正 2026-09-28" }));
  expect(onEdit).toHaveBeenCalledWith(
    expect.objectContaining({ id: "t1", date: "2026-09-28" }),
  );
});

it("多个空缺日期填写后提交，只有无记录已填的日期进入队列且提交后清空", async () => {
  const mock = stub(payload(true));
  const onAdd = vi.fn<(items: DraftItem[]) => boolean | void>();
  render(<IncomeDays date="2026-09-30" accounts={accounts} onAdd={onAdd} />);
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
  render(<IncomeDays date="2026-09-30" accounts={accounts} onAdd={onAdd} />);
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
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => payload(false),
    })
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
  render(<IncomeDays date="2026-09-30" accounts={accounts} onAdd={vi.fn()} />);
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
    <IncomeDays
      date="2026-09-30"
      accounts={[
        { name: "Income:Interest", currencies: [] },
        { name: "Assets:Cash", currencies: [] },
      ]}
      onAdd={onAdd}
    />,
  );
  await screen.findByText("09-24");
  const submit = screen.getByRole("button", { name: "将已填收益加入草稿" });
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByLabelText("实际收益 2026-09-24"), {
    target: { value: "1" },
  });
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByLabelText("收益账户"), {
    target: { value: "Income:Interest" },
  });
  fireEvent.change(screen.getByLabelText("收益到账账户"), {
    target: { value: "Assets:Cash" },
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
