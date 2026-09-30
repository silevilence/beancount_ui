import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import App from "./App";
import { PENDING_KEY } from "./Editor";

const status = {
  writable: true,
  version: "3.2.3",
  files: [],
  errors: [],
  git: { sync: "待提交" },
  include_graph: {},
  unreferenced: [],
};
it("filters by date and payee, distinguishes stale data and drafts", async () => {
  const fetcher = vi.fn().mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url === "/api/ledger"
        ? status
        : {
            date: new URL(`http://local${url}`).searchParams.get("day"),
            stale: true,
            transactions: [],
            expenses: { CNY: "25.50" },
            income: { CNY: "100.12" },
            accounts: [],
          },
  }));
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  expect(await screen.findByText("25.50 CNY")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("上一次有效视图");
  fireEvent.change(screen.getByLabelText("记账日期"), {
    target: { value: "2026-09-30" },
  });
  fireEvent.change(screen.getByPlaceholderText("筛选商户"), {
    target: { value: "食堂" },
  });
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([url]) =>
        String(url).includes("day=2026-09-30&payee="),
      ),
    ).toBe(true),
  );
  fireEvent.change(screen.getByLabelText("待记便笺"), {
    target: { value: "待记 20 元" },
  });
  expect(screen.getByText("草稿 · 不计入收支")).toBeInTheDocument();
  fireEvent.click(screen.getByText("清除便笺"));
  expect(screen.getByLabelText("待记便笺")).toHaveValue("");
});

it("renders the journal and configuration errors", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({
        ok: false,
        json: async () => ({ detail: "请配置账本" }),
      }),
  );
  render(<App />);
  expect(
    screen.getByRole("heading", { name: "把日子，记清楚。" }),
  ).toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent("请配置账本");
});

it("shows sources and diagnostics, opens edit/delete and resumes a pending preview", async () => {
  const row = {
    id: "record",
    date: "2026-09-30",
    payee: "测试商户",
    narration: "午饭",
    kind: "消费",
    tags: [],
    postings: [
      { account: "Expenses:Food", amount: "12", currency: "CNY" },
      { account: "Assets:Cash", amount: "-12", currency: "CNY" },
    ],
    file: "txs/2026/08.bean",
    line: 2,
    raw: '2026-09-30 * "测试商户" "午饭"\n  Expenses:Food 12 CNY\n  Assets:Cash -12 CNY\n',
    simple: true,
    readonly: false,
    note: "",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () =>
        url === "/api/ledger"
          ? {
              ...status,
              git: {
                sync: "待提交",
                branch: "master-1",
                commit: "abcdef123",
                changes: ["M txs/2026/08.bean"],
              },
              errors: [{ file: "bad.bean", line: 1, message: "诊断示例" }],
              unreferenced: ["extra.bean"],
            }
          : {
              date: new URL(`http://local${url}`).searchParams.get("day"),
              revision: "a".repeat(64),
              stale: false,
              transactions: [
                row,
                {
                  ...row,
                  id: "other",
                  payee: "",
                  kind: "收入",
                  simple: false,
                  tags: ["salary"],
                },
              ],
              expenses: { CNY: "12" },
              income: {},
              accounts: [],
              sync: "待提交",
            },
    })),
  );
  render(<App />);
  expect(await screen.findByText("测试商户")).toBeInTheDocument();
  expect(screen.getByText("bad.bean:1 · 诊断示例")).toBeInTheDocument();
  fireEvent.click(screen.getByText("修改"));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("关闭编辑"));
  fireEvent.click(screen.getAllByText("删除")[0]);
  expect(await screen.findByText("预览删除影响")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("关闭编辑"));
  localStorage.setItem(
    PENDING_KEY,
    JSON.stringify({
      request: {
        request_id: "test",
        revision: "a".repeat(64),
        operation: "create",
        business: "ordinary",
        raw: row.raw,
      },
    }),
  );
  fireEvent.click(screen.getByText("＋ 记一笔"));
  fireEvent.click(screen.getByLabelText("关闭编辑"));
  fireEvent.click(await screen.findByText("恢复原请求"));
  expect(screen.getByLabelText("Beancount 原文")).toHaveValue(row.raw);
});
