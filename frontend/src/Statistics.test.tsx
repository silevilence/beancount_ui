import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import Statistics from "./Statistics";
import { presetRange, type Report, type ReportDetails } from "./statisticsData";

export function report(over: Partial<Report> = {}): Report {
  return {
    start: "2026-10-01",
    end: "2026-10-31",
    grain: "day",
    currency: "CNY",
    currencies: ["CNY", "JPY"],
    revision: "r1",
    view_revision: "r1",
    stale: false,
    available: true,
    errors: [],
    count: 2,
    totals: {
      income: "1000.123456789",
      expenses: "-20",
      net: "1020.123456789",
    },
    buckets: [
      {
        start: "2026-10-01",
        end: "2026-10-01",
        count: 1,
        income: "1000.123456789",
        expenses: "0",
        net: "1000.123456789",
      },
      {
        start: "2026-10-02",
        end: "2026-10-02",
        count: 1,
        income: "0",
        expenses: "-20",
        net: "20",
      },
    ],
    ...over,
  };
}
const details: ReportDetails = {
  revision: "r1",
  view_revision: "r1",
  stale: false,
  available: true,
  errors: [],
  transactions: [
    {
      id: "row1",
      date: "2026-10-02",
      payee: "测试商户",
      narration: "退款",
      file: "refund.bean",
      line: 3,
      raw: '2026-10-02 * "退款"\n  Expenses:Food -20 CNY',
      income: "0",
      expenses: "-20",
      net: "20",
      contributions: [
        {
          account: "Expenses:Food",
          amount: "-20",
          currency: "CNY",
          kind: "expenses",
          note: "原单退款",
        },
      ],
    },
  ],
};
const ok = (data: unknown) => ({ ok: true, json: async () => data });
const fail = (detail: string) => ({
  ok: false,
  status: 409,
  json: async () => ({ detail }),
});
function routing(handler?: (url: URL) => unknown) {
  const fetcher = vi.fn(async (input: string) => {
    const url = new URL(input, "http://local");
    return (
      handler?.(url) ||
      ok(url.pathname.endsWith("details") ? details : report())
    );
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

it("日期预设使用自然周月和上海当天，包括闰月和跨年", () => {
  expect(presetRange("week", "2026-01-01")).toEqual({
    start: "2025-12-29",
    end: "2026-01-04",
  });
  expect(presetRange("week", "2026-01-04")).toEqual({
    start: "2025-12-29",
    end: "2026-01-04",
  });
  expect(presetRange("month", "2024-02-29")).toEqual({
    start: "2024-02-01",
    end: "2024-02-29",
  });
  expect(presetRange("month", "2026-12-31")).toEqual({
    start: "2026-12-01",
    end: "2026-12-31",
  });
  expect(presetRange("year", "2026-10-13")).toEqual({
    start: "2026-01-01",
    end: "2026-12-31",
  });
  expect(presetRange("recent", "2026-01-01")).toEqual({
    start: "2025-12-03",
    end: "2026-01-01",
  });
});

it("默认本月按日，切换粒度保留日期，币种与自定义范围联动", async () => {
  const fetcher = routing();
  render(<Statistics />);
  await screen.findByRole("region", { name: "区间收支" });
  expect(screen.getByRole("button", { name: "本月" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const start = (screen.getByLabelText("开始日期") as HTMLInputElement).value;
  const end = (screen.getByLabelText("结束日期") as HTMLInputElement).value;
  fireEvent.click(screen.getByRole("button", { name: "周" }));
  await waitFor(() =>
    expect(fetcher.mock.calls.at(-1)?.[0]).toContain("grain=week"),
  );
  expect(screen.getByLabelText("开始日期")).toHaveValue(start);
  expect(screen.getByLabelText("结束日期")).toHaveValue(end);
  fireEvent.change(screen.getByLabelText("币种"), { target: { value: "JPY" } });
  await waitFor(() =>
    expect(fetcher.mock.calls.at(-1)?.[0]).toContain("currency=JPY"),
  );
  fireEvent.click(screen.getByRole("button", { name: "自定义" }));
  fireEvent.change(screen.getByLabelText("开始日期"), {
    target: { value: "2026-01-01" },
  });
  fireEvent.change(screen.getByLabelText("结束日期"), {
    target: { value: "2026-02-01" },
  });
  fireEvent.click(screen.getByRole("button", { name: "月" }));
  await waitFor(() =>
    expect(fetcher.mock.calls.at(-1)?.[0]).toContain(
      "start=2026-01-01&end=2026-02-01&grain=month",
    ),
  );
  fireEvent.change(screen.getByLabelText("开始日期"), {
    target: { value: "2027-01-01" },
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "开始日期不能晚于结束日期",
  );
  expect(
    screen.queryByRole("region", { name: "区间收支" }),
  ).not.toBeInTheDocument();
});

it("负费用与精确金额可核对，键盘和点击时段查看流水原文，返回保留筛选", async () => {
  const fetcher = routing();
  render(<Statistics />);
  const bucket = await screen.findByRole("button", {
    name: /2026-10-02，收入/,
  });
  fireEvent.focus(bucket);
  expect(screen.getByText(/2026-10-02 · 收入/)).toHaveTextContent(
    "支出 -20.00 CNY",
  );
  expect(screen.getByRole("region", { name: "区间收支" })).toHaveTextContent(
    "1,000.123456789",
  );
  fireEvent.keyDown(bucket, { key: "ArrowRight" });
  expect(fetcher.mock.calls.some(([url]) => url.includes("details"))).toBe(
    false,
  );
  fireEvent.keyDown(bucket, { key: "Enter" });
  const region = await screen.findByRole("region", { name: "统计流水" });
  await within(region).findByText("测试商户");
  expect(region).toHaveTextContent("原单退款");
  expect(region).toHaveTextContent("Expenses:Food -20 CNY");
  expect(fetcher.mock.calls.at(-1)?.[0]).toContain("revision=r1");
  fireEvent.click(within(region).getByRole("button", { name: "返回图表" }));
  expect(
    screen.queryByRole("region", { name: "统计流水" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "净额走势" }));
  const net = screen.getByRole("button", { name: /2026-10-02，净额/ });
  fireEvent.mouseEnter(net);
  fireEvent.keyDown(net, { key: " " });
  await screen.findByText("测试商户");
});

it("请求失败明确区分无数据与上次视图，刷新重试后恢复", async () => {
  let broken = true;
  routing(() => (broken ? fail("读取失败") : ok(report())));
  render(<Statistics />);
  expect(await screen.findByRole("alert")).toHaveTextContent("读取失败");
  expect(
    screen.queryByRole("region", { name: "区间收支" }),
  ).not.toBeInTheDocument();
  broken = false;
  fireEvent.click(screen.getByRole("button", { name: "重新加载统计" }));
  await screen.findByRole("region", { name: "区间收支" });
  broken = true;
  fireEvent.click(screen.getByRole("button", { name: "刷新统计" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("上一次有效视图");
  expect(screen.getByRole("region", { name: "区间收支" })).toBeInTheDocument();
});

it("旧筛选响应不能覆盖新筛选结果，卸载取消请求", async () => {
  let resolveOld!: (value: unknown) => void;
  const fetcher = routing((url) =>
    url.searchParams.get("grain") === "day"
      ? new Promise((resolve) => {
          resolveOld = resolve;
        })
      : ok(report({ currency: "JPY" })),
  );
  const view = render(<Statistics />);
  fireEvent.click(screen.getByRole("button", { name: "周" }));
  await screen.findByRole("region", { name: "区间收支" });
  await act(async () => resolveOld(ok(report())));
  expect(screen.getByRole("region", { name: "区间收支" })).toHaveTextContent(
    "JPY",
  );
  view.unmount();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("账本错误显示最后有效视图，首次无有效账本不伪装为零收支", async () => {
  let available = true;
  routing(() =>
    ok(
      report({
        stale: true,
        available,
        errors: [{ file: "main.bean", line: 2, message: "未知账户" }],
      }),
    ),
  );
  const view = render(<Statistics revision="r1" />);
  expect(await screen.findByText(/统计保留上一次有效视图/)).toHaveTextContent(
    "未知账户",
  );
  available = false;
  view.rerender(<Statistics revision="r2" />);
  await screen.findByText(/尚无有效统计数据/);
  expect(
    screen.queryByRole("region", { name: "区间收支" }),
  ).not.toBeInTheDocument();
});

it("无币种的空账本展示零值与空态，明细空态与失败可重试", async () => {
  let detailFailure = true;
  routing((url) =>
    url.pathname.endsWith("details")
      ? detailFailure
        ? fail("账本已变化")
        : ok({ ...details, stale: true, transactions: [] })
      : ok(
          report({
            currency: "",
            currencies: [],
            count: 0,
            totals: { income: "0", expenses: "0", net: "0" },
          }),
        ),
  );
  render(<Statistics />);
  await screen.findByText(/所有时段按零展示/);
  fireEvent.click(screen.getByRole("button", { name: /2026-10-02，收入/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("账本已变化");
  detailFailure = false;
  fireEvent.click(screen.getByRole("button", { name: "刷新并重试" }));
  await screen.findByText("该时段没有所选币种的收支流水。");
  expect(screen.getByText(/明细来自上一次有效视图/)).toBeInTheDocument();
});

it("轮询刷新账本，保留自定义日期，失败后继续轮询", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
  let broken = false;
  const fetcher = routing(() => (broken ? fail("暂时失败") : ok(report())));
  try {
    await act(async () => {
      render(<Statistics />);
    });
    fireEvent.change(screen.getByLabelText("开始日期"), {
      target: { value: "2026-09-01" },
    });
    await act(async () => {});
    broken = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("暂时失败");
    broken = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("开始日期")).toHaveValue("2026-09-01");
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(4);
  } finally {
    vi.useRealTimers();
  }
});
