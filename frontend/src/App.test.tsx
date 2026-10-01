import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import App from "./App";
import { PENDING_KEY } from "./Editor";

vi.mock("./SyncPanel", () => ({ default: () => null }));

type Payload = Record<string, unknown>;
type Reply = { ok: boolean; status?: number; json: () => Promise<unknown> };

const ok = (data: unknown): Reply => ({ ok: true, json: async () => data });

const fail = (detail: string, status = 422): Reply => ({
  ok: false,
  status,
  json: async () => ({ detail }),
});

const PENDING_NOTICE = "有一笔待确认的保存请求，重试不会重复入账。";

function status(over: Payload = {}) {
  return {
    entry: "main.beancount",
    version: "3.2.3",
    revision: "r1",
    writable: true,
    errors: [],
    files: ["main.beancount", "index.bean"],
    include_graph: { "main.beancount": ["index.bean"], "index.bean": [] },
    unreferenced: [],
    entry_count: 12,
    accounts: [],
    git: {
      repository: true,
      branch: "master-1",
      commit: "abcdef1234",
      changes: [],
      sync: "待提交",
    },
    ...over,
  };
}

const row = {
  id: "r1",
  date: "2026-09-30",
  payee: "测试商户",
  narration: "午饭",
  kind: "消费",
  tags: ["dining"],
  postings: [
    { account: "Expenses:Food", amount: "25.50", currency: "CNY" },
    { account: "Assets:Cash", amount: "-25.50", currency: "CNY" },
  ],
  file: "txs/2026/09.bean",
  line: 2,
  raw: '2026-09-30 * "测试商户" "午饭"\n  Expenses:Food 25.50 CNY\n  Assets:Cash -25.50 CNY\n',
  simple: true,
  readonly: false,
  note: "",
};

function view(day: string, over: Payload = {}) {
  return {
    date: day,
    revision: "a".repeat(64),
    view_revision: "a".repeat(64),
    stale: false,
    errors: [],
    transactions: [],
    expenses: {},
    income: {},
    accounts: [],
    sync: "待提交",
    ...over,
  };
}

function sync(over: Payload = {}) {
  return {
    connected: true,
    enabled: false,
    remote: "https://example.invalid/ledger.git",
    branch: "master-1",
    sync: "已同步",
    ahead: 0,
    last_success: new Date(Date.now() - 60_000).toISOString(),
    changes: [],
    ...over,
  };
}

function routing(handler: (url: URL) => Reply, backup: Payload = sync()) {
  return vi.fn(async (input: string) => {
    const url = new URL(String(input), "http://local");
    return url.pathname === "/api/sync" ? ok(backup) : handler(url);
  });
}

it("包含图出现循环时显示诊断，仍可进入布局设置", async () => {
  vi.stubGlobal(
    "fetch",
    routing((url) => {
      if (url.pathname === "/api/ledger")
        return ok(
          status({
            writable: false,
            errors: [
              { file: "index.bean", line: 0, message: "include 存在循环" },
            ],
            include_graph: {
              "main.beancount": ["index.bean"],
              "index.bean": ["main.beancount"],
            },
          }),
        );
      if (url.pathname === "/api/layout") return fail("请先修复入口");
      return ok(view(url.searchParams.get("day") || "2026-10-01"));
    }),
  );
  render(<App />);
  expect(
    await screen.findByText("main.beancount（循环引用）"),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "文件布局" }));
  expect(await screen.findByText("请先修复入口")).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "n" });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  fireEvent.click(screen.getByText("关闭布局"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

/** 手动泵：按路径解析挂起请求，避免依赖请求发起顺序。 */
function deferredFetch() {
  const queue: { path: string; resolve: (reply: Reply) => void }[] = [];
  const fetcher = vi.fn(
    (input: string) =>
      new Promise<Reply>((resolve) => {
        queue.push({
          path: new URL(String(input), "http://local").pathname,
          resolve,
        });
      }),
  );
  const pending = (path: string) =>
    queue.filter((item) => item.path === path);
  return { fetcher, pending };
}

it("按日期展示流水与合计，可切换日期、筛选并记录便笺", async () => {
  const fetcher = routing((url) =>
    url.pathname === "/api/ledger"
      ? ok(status())
      : ok(
          view(url.searchParams.get("day") ?? "", {
            transactions: [row],
            expenses: { CNY: "25.50" },
            income: { CNY: "100.12" },
          }),
        ),
  );
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  expect(await screen.findByText("测试商户")).toBeInTheDocument();
  expect(screen.getAllByText("25.50 CNY").length).toBeGreaterThan(0);
  expect(screen.getByText("74.62 CNY")).toBeInTheDocument();
  expect(screen.getAllByText("今天")).toHaveLength(2);
  expect(screen.getByText("-25.50 CNY")).toBeInTheDocument();
  expect(screen.getAllByText("1 笔")).toHaveLength(2);
  expect(screen.getByText("Expenses:Food")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "今天" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "前一天" }));
  await waitFor(() => expect(screen.getAllByText("今天")).toHaveLength(1));
  expect(screen.getByRole("button", { name: "今天" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "后一天" }));
  await waitFor(() => expect(screen.getAllByText("今天")).toHaveLength(2));
  expect(screen.getByRole("button", { name: "今天" })).toBeDisabled();

  fireEvent.change(screen.getByLabelText("商户"), {
    target: { value: "食堂" },
  });
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([input]) =>
        String(input).includes("payee=%E9%A3%9F%E5%A0%82"),
      ),
    ).toBe(true),
  );
  fireEvent.click(screen.getByText("清空筛选"));
  await waitFor(() => expect(screen.getByLabelText("商户")).toHaveValue(""));

  fireEvent.change(screen.getByLabelText("待记便笺"), {
    target: { value: "待记 20 元" },
  });
  expect(screen.getByText("草稿 · 不计入收支")).toBeInTheDocument();
  fireEvent.click(screen.getByText("清除便笺"));
  expect(screen.getByLabelText("待记便笺")).toHaveValue("");
});

it("读取失败时提示连接异常且不伪装旧视图", async () => {
  const { fetcher, pending } = deferredFetch();
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  expect(screen.getByText("正在读取账本…")).toBeInTheDocument();
  expect(screen.getByText("正在读取账本信息…")).toBeInTheDocument();
  expect(screen.getByText("正在读取…")).toBeInTheDocument();
  expect(screen.getByText("—")).toBeInTheDocument();
  act(() => {
    pending("/api/ledger")[0].resolve(ok(status()));
    pending("/api/journal")[0].resolve(fail("请配置账本"));
    pending("/api/sync")[0].resolve(ok(sync()));
  });
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("请配置账本");
  expect(alert).not.toHaveTextContent("无法确认最新状态");
  expect(screen.getByText("连接异常")).toBeInTheDocument();
  expect(screen.getByText("未连接")).toBeInTheDocument();
  expect(screen.getByText("已同步")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "＋ 记一笔" })).toBeDisabled();
});

it("旧请求不会覆盖新选择的日期", async () => {
  const { fetcher, pending } = deferredFetch();
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  fireEvent.change(screen.getByLabelText("记账日期"), {
    target: { value: "2026-09-29" },
  });
  await waitFor(() =>
    expect(pending("/api/journal").length).toBe(2),
  );
  const journals = pending("/api/journal");
  act(() => {
    pending("/api/ledger")[1].resolve(ok(status()));
    journals[1].resolve(
      ok(
        view("2026-09-29", {
          transactions: [{ ...row, id: "new", payee: "新视图" }],
        }),
      ),
    );
  });
  expect(await screen.findByText("新视图")).toBeInTheDocument();
  act(() => {
    pending("/api/ledger")[0].resolve(ok(status()));
    journals[0].resolve(
      ok(
        view("2026-09-30", {
          transactions: [{ ...row, id: "old", payee: "旧视图" }],
        }),
      ),
    );
  });
  await waitFor(() =>
    expect(screen.queryByText("旧视图")).not.toBeInTheDocument(),
  );
  expect(screen.getByText("新视图")).toBeInTheDocument();
});

it("快捷键打开录入、聚焦搜索与刷新，输入中不触发", async () => {
  let journalCalls = 0;
  const fetcher = routing((url) => {
    if (url.pathname === "/api/ledger") return ok(status());
    journalCalls += 1;
    return ok(view(url.searchParams.get("day") ?? "", { transactions: [row] }));
  });
  vi.stubGlobal("fetch", fetcher);
  // DOM 可先于快捷键 effect 更新；等待初始请求和 effect 完成后再发送按键。
  await act(async () => {
    render(<App />);
  });
  await screen.findByText("测试商户");
  const before = journalCalls;
  fireEvent.keyDown(window, { key: "x" });
  expect(journalCalls).toBe(before);
  fireEvent.keyDown(window, { key: "n", ctrlKey: true });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.keyDown(window, { key: "n" });
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("关闭编辑"));
  const searchBox = screen.getByLabelText("商户");
  fireEvent.keyDown(searchBox, { key: "n" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.keyDown(window, { key: "/" });
  expect(searchBox).toHaveFocus();
  fireEvent.keyDown(window, { key: "s" });
  expect(await screen.findByRole("dialog")).toHaveAccessibleName("备份中心");
  fireEvent.click(screen.getByLabelText("关闭备份"));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  const beforeRefresh = journalCalls;
  fireEvent.keyDown(window, { key: "r" });
  await waitFor(() => expect(journalCalls).toBeGreaterThan(beforeRefresh));
});

it("账本诊断、包含关系、未纳入文件与只读记录", async () => {
  const readonlyRow = {
    ...row,
    id: "gnucash",
    payee: "",
    narration: "历史导入",
    tags: ["imported"],
    readonly: true,
  };
  const complexRow = { ...row, id: "complex", payee: "", simple: false };
  const fetcher = routing((url) =>
    url.pathname === "/api/ledger"
      ? ok(
          status({
            errors: [{ file: "bad.bean", line: 1, message: "诊断示例" }],
            unreferenced: ["extra.bean"],
            git: {
              repository: true,
              branch: "",
              changes: ["M txs/2026/09.bean"],
              sync: "待提交",
            },
            include_graph: {
              "main.beancount": ["index.bean", "missing.bean"],
              "index.bean": [],
            },
          }),
        )
      : ok(
          view(url.searchParams.get("day") ?? "", {
            transactions: [readonlyRow, complexRow],
          }),
        ),
  );
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  expect(await screen.findByText("bad.bean:1 · 诊断示例")).toBeInTheDocument();
  expect(screen.getByText("历史导入只读")).toBeInTheDocument();
  expect(screen.queryByText("修改")).not.toBeInTheDocument();
  expect(screen.getByText("高级编辑")).toBeInTheDocument();
  expect(screen.getByText("#imported")).toBeInTheDocument();
  expect(screen.getByText("复杂分录")).toBeInTheDocument();
  expect(screen.getByText("未纳入文件：extra.bean")).toBeInTheDocument();
  expect(screen.getByText("无 Git 仓库 · 无提交")).toBeInTheDocument();
  expect(screen.getByText("M txs/2026/09.bean")).toBeInTheDocument();
  fireEvent.click(screen.getByText("包含关系"));
  expect(screen.getByText("missing.bean")).toBeInTheDocument();
  expect(screen.getByText("index.bean")).toBeInTheDocument();
});

it("待确认请求可恢复，恢复期间暂停记录操作", async () => {
  const fetcher = routing((url) =>
    url.pathname === "/api/ledger"
      ? ok(status())
      : ok(view(url.searchParams.get("day") ?? "", { transactions: [row] })),
  );
  vi.stubGlobal("fetch", fetcher);
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
  render(<App />);
  expect(await screen.findByText(PENDING_NOTICE)).toBeInTheDocument();
  expect(screen.getByText("修改")).toBeDisabled();
  fireEvent.click(screen.getByText("恢复原请求"));
  expect(await screen.findByLabelText("Beancount 原文")).toHaveValue(row.raw);
  fireEvent.click(screen.getByLabelText("关闭编辑"));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.getByText("修改")).toBeDisabled();
});

it("顶栏备份状态直接打开备份中心并自动预览", async () => {
  const fetcher = routing((url) => {
    if (url.pathname === "/api/ledger") return ok(status());
    if (url.pathname === "/api/sync/backup-preview")
      return ok({
        revision: "r",
        head: "h",
        files: ["txs/2026/09.bean"],
        excluded: ["secret.log"],
        message: "账本备份：1 个文件",
        diff: "+saved\n",
        outgoing_count: 0,
      });
    return ok(view("2026-09-30"));
  });
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /已同步/ }));
  expect(await screen.findByRole("dialog")).toHaveAccessibleName("备份中心");
  expect(await screen.findByText("secret.log")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("关闭备份"));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

it("备份失败显示待备份提示，暂停时给出人工处理指引", async () => {
  const failing = routing(
    (url) =>
      url.pathname === "/api/ledger" ? ok(status()) : ok(view("2026-09-30")),
    sync({ sync: "已保存 · 待提交", error: "网络不可用" }),
  );
  vi.stubGlobal("fetch", failing);
  const first = render(<App />);
  expect(
    await screen.findByText(
      "备份未完成：网络不可用。已保存的记录仍在本地，无需重复录入。",
    ),
  ).toBeInTheDocument();
  first.unmount();

  const forks = routing(
    (url) =>
      url.pathname === "/api/ledger" ? ok(status()) : ok(view("2026-09-30")),
    sync({
      sync: "已保存 · 待提交",
      blocked: true,
      error: "历史分叉；请备份两侧内容并人工合并",
    }),
  );
  vi.stubGlobal("fetch", forks);
  render(<App />);
  expect(
    await screen.findByText(/备份已暂停：历史分叉/),
  ).toBeInTheDocument();
});

it("修改与删除从流水直接进入编辑器", async () => {
  const fetcher = routing((url) =>
    url.pathname === "/api/ledger"
      ? ok(status())
      : ok(view(url.searchParams.get("day") ?? "", { transactions: [row] })),
  );
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  fireEvent.click(await screen.findByText("修改"));
  expect(screen.getByText("纠正这笔记录")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("金额"), {
    target: { value: "26.00" },
  });
  fireEvent.click(screen.getByLabelText("关闭编辑"));
  fireEvent.click(screen.getByText("删除"));
  expect(screen.getByText("删除误记记录")).toBeInTheDocument();
  expect(
    within(screen.getByRole("dialog")).getByText(/Expenses:Food 25.50 CNY/),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("关闭编辑"));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

it("空流水、刷新失败与重新加载", async () => {
  let ledgerFails = false;
  const fetcher = routing((url) => {
    if (url.pathname === "/api/ledger")
      return ledgerFails ? fail("账本暂不可用", 503) : ok(status());
    return ok(view(url.searchParams.get("day") ?? ""));
  });
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  expect(
    await screen.findByText("这一天还没有匹配的记录。"),
  ).toBeInTheDocument();
  expect(screen.getAllByText("0.00")).toHaveLength(3);
  expect(screen.getAllByText("0 笔")).toHaveLength(2);
  ledgerFails = true;
  fireEvent.click(screen.getByText("刷新"));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("账本暂不可用");
  expect(alert).toHaveTextContent("当前为上一次有效视图");
  ledgerFails = false;
  fireEvent.click(screen.getByText("重新加载"));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
});

it("账本校验失败时保留旧视图并暂停写入", async () => {
  const fetcher = routing((url) =>
    url.pathname === "/api/ledger"
      ? ok(status())
      : ok(view("2020-01-01", { stale: true })),
  );
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  expect(
    await screen.findByText("账本校验失败，以下保留上一次有效视图，已暂停写入。"),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "＋ 记一笔" })).toBeDisabled();
  expect(screen.getByText("读取中")).toBeInTheDocument();
});

it("原文可复制，剪贴板不可用时保持原提示", async () => {
  const fetcher = routing((url) =>
    url.pathname === "/api/ledger"
      ? ok(status())
      : ok(view(url.searchParams.get("day") ?? "", { transactions: [row] })),
  );
  vi.stubGlobal("fetch", fetcher);
  Object.defineProperty(navigator, "clipboard", {
    value: undefined,
    configurable: true,
  });
  render(<App />);
  fireEvent.click(await screen.findByText("查看原文"));
  fireEvent.click(screen.getByText("复制"));
  expect(screen.queryByText("已复制")).not.toBeInTheDocument();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  fireEvent.click(screen.getByText("复制"));
  expect(await screen.findByText("已复制")).toBeInTheDocument();
  expect(writeText).toHaveBeenCalledWith(row.raw);
});

it("从工作台完成一笔录入并刷新当日视图", async () => {
  const requests: Record<string, unknown>[] = [];
  let journalCalls = 0;
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    const url = new URL(String(path), "http://local");
    if (url.pathname === "/api/ledger") return ok(status());
    if (url.pathname === "/api/sync") return ok(sync());
    if (url.pathname === "/api/journal") {
      journalCalls += 1;
      return ok(
        view(url.searchParams.get("day") ?? "2026-09-30", {
          transactions: [row],
          accounts: [
            { name: "Expenses:Food", currencies: ["CNY"] },
            { name: "Assets:Cash", currencies: ["CNY"] },
          ],
        }),
      );
    }
    const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
    requests.push(body);
    return ok({
      request_id: body.request_id,
      target: "txs/2026/09.bean",
      diffs: { "txs/2026/09.bean": "+  Expenses:Food 12.30 CNY" },
      status: "committed",
      revision: "b".repeat(64),
    });
  });
  vi.stubGlobal("fetch", fetcher);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "＋ 记一笔" }));
  fireEvent.change(screen.getByLabelText("金额"), {
    target: { value: "12.30" },
  });
  fireEvent.change(screen.getByLabelText("支出分类"), {
    target: { value: "Expenses:Food" },
  });
  fireEvent.change(screen.getByLabelText("付款账户"), {
    target: { value: "Assets:Cash" },
  });
  fireEvent.click(screen.getByText("预览并校验"));
  fireEvent.click(await screen.findByText("确认保存"));
  expect(await screen.findByText("本次已录入")).toBeInTheDocument();
  expect(screen.getByText("12.30 CNY")).toBeInTheDocument();
  expect(requests[1].request_id).toBe(requests[0].request_id);
  expect(journalCalls).toBeGreaterThanOrEqual(3);
  expect(screen.queryByText(PENDING_NOTICE)).not.toBeInTheDocument();
});
