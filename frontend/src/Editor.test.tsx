import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import Editor, { PENDING_KEY } from "./Editor";
import type { Journal, Transaction } from "./api";

type Reply = { ok: boolean; status?: number; json: () => Promise<unknown> };

const ok = (data: unknown): Reply => ({ ok: true, json: async () => data });

const fail = (detail: string, status = 409): Reply => ({
  ok: false,
  status,
  json: async () => ({ detail }),
});

const journal: Journal = {
  date: "2026-09-30",
  revision: "a".repeat(64),
  view_revision: "a".repeat(64),
  stale: false,
  errors: [],
  transactions: [],
  expenses: {},
  income: {},
  sync: "待提交",
  accounts: [
    { name: "Expenses:Food", currencies: ["CNY"] },
    { name: "Assets:Cash", currencies: ["CNY", "USD"] },
  ],
};

const complexRow: Transaction = {
  id: "test",
  date: "2026-09-30",
  payee: "",
  narration: "",
  kind: "转账 / 还款",
  tags: [],
  postings: [],
  file: "txs/2026/09.bean",
  line: 1,
  raw: '2026-09-30 * "股票"\n  Assets:Shares 1 HOOL {10 USD}\n  Assets:Bank -10 USD\n',
  simple: false,
  readonly: false,
  note: "",
};

function fill() {
  fireEvent.change(screen.getByLabelText("金额"), {
    target: { value: "12.30" },
  });
  fireEvent.change(screen.getByLabelText("商户"), {
    target: { value: "超市" },
  });
  fireEvent.change(screen.getByLabelText("支出分类"), {
    target: { value: "Expenses:Food" },
  });
  fireEvent.change(screen.getByLabelText("付款账户"), {
    target: { value: "Assets:Cash" },
  });
}

function setup(
  mode: "success" | "timeout" | "invalid" | "empty" | "offline" = "success",
  op: "create" | "edit" | "delete" = "create",
) {
  let failures = mode === "timeout" ? 1 : 0;
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (path.includes("/journal")) return ok(journal);
    const body = JSON.parse(String(options?.body));
    requests.push({ path, body });
    if (path.endsWith("/preview")) {
      if (mode === "invalid") return fail("候选账本校验失败", 422);
      if (mode === "offline") throw new Error("网络不可用");
      return ok({
        request_id: body.request_id,
        target: "txs/2026/09.bean",
        diffs:
          mode === "empty"
            ? {}
            : {
                "txs/2026/09.bean":
                  '--- a/txs/2026/09.bean\n+++ b/txs/2026/09.bean\n@@ -1,1 +1,2 @@\n 2026-09-30 * "超市"\n+  Expenses:Food 12.30 CNY\n-  Expenses:Food 0.00 CNY\n',
              },
        status: "preview",
        revision: "b".repeat(64),
      });
    }
    if (failures-- > 0) throw new Error("network timeout");
    return ok({
      request_id: body.request_id,
      target: "txs/2026/09.bean",
      diffs: { "txs/2026/09.bean": "+ 12.30 CNY" },
      status: "committed",
      revision: "b".repeat(64),
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const onSaved = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <Editor
      journal={journal}
      row={op === "create" ? undefined : complexRow}
      operation={op}
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  return { requests, onSaved, onClose };
}

it("局域网 HTTP 可预览保存，防止重复点击，保存后保留日期并继续录入", async () => {
  vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
  const { requests, onSaved } = setup();
  fill();
  expect(screen.getByText("填写")).toHaveAttribute("aria-current", "step");
  fireEvent.click(screen.getByText("预览并校验"));
  fireEvent.click(await screen.findByText("确认保存"));
  fireEvent.click(screen.getByText("正在保存…"));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(requests.filter((r) => r.path.endsWith("/commit"))).toHaveLength(1);
  expect(screen.getByText("本次已录入")).toBeInTheDocument();
  expect(screen.getByText("12.30 CNY")).toBeInTheDocument();
  expect(
    screen.getByText("已保存到本地账本，可以继续记下一笔。"),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("金额")).toHaveValue("");
  expect(screen.getByLabelText("交易日期")).toHaveValue("2026-09-30");
  expect(screen.getByLabelText("付款账户")).toHaveValue("Assets:Cash");
  fireEvent.change(screen.getByLabelText("金额"), {
    target: { value: "3.20" },
  });
  fireEvent.click(screen.getByText("预览并校验"));
  await screen.findByText("确认保存");
  expect(
    requests.filter((r) => r.path.endsWith("/preview"))[1].body.revision,
  ).toBe("b".repeat(64));
  expect((requests[0].body.entry as Record<string, string>).amount).toBe(
    "12.30",
  );
});

it("保存超时后锁定内容，用原请求重试且不重复入账", async () => {
  const { requests, onSaved } = setup("timeout");
  fill();
  fireEvent.click(screen.getByText("预览并校验"));
  fireEvent.click(await screen.findByText("确认保存"));
  expect(await screen.findByRole("alert")).toHaveTextContent("不要重新录入");
  expect(screen.getByLabelText("金额")).toBeDisabled();
  expect(screen.getByText("写入")).toHaveAttribute("aria-current", "step");
  expect(JSON.parse(localStorage.getItem(PENDING_KEY)!).uncertain).toBe(true);
  fireEvent.click(screen.getByText("使用原请求重试保存"));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  const commits = requests.filter((r) => r.path.endsWith("/commit"));
  expect(commits[0].body.request_id).toBe(commits[1].body.request_id);
  expect(localStorage.getItem(PENDING_KEY)).toBeNull();
});

it("校验失败时保留输入以便修正", async () => {
  setup("invalid");
  fill();
  fireEvent.click(screen.getByText("预览并校验"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "候选账本校验失败",
  );
  expect(screen.getByLabelText("金额")).toHaveValue("12.30");
  expect(screen.queryByText("确认保存")).not.toBeInTheDocument();
});

it("预览请求失败时给出原因并保留内容", async () => {
  setup("offline");
  fill();
  fireEvent.click(screen.getByText("预览并校验"));
  expect(await screen.findByRole("alert")).toHaveTextContent("网络不可用");
  expect(screen.getByLabelText("金额")).toHaveValue("12.30");
});

it("复杂记录直接进入原文编辑，删除前先看影响", async () => {
  setup("success", "edit");
  expect(screen.getByLabelText("Beancount 原文")).toHaveValue(complexRow.raw);
  expect(screen.getAllByRole("checkbox")[0]).toBeDisabled();
  cleanup();
  setup("empty", "delete");
  expect(screen.getByText("预览删除影响")).toBeInTheDocument();
  fireEvent.click(screen.getByText("预览删除影响"));
  expect(await screen.findByText("原文没有变化。")).toBeInTheDocument();
});

it("保存超时后刷新页面仍能完成原请求", async () => {
  const { onSaved } = setup("timeout");
  fill();
  fireEvent.click(screen.getByText("预览并校验"));
  fireEvent.click(await screen.findByText("确认保存"));
  await screen.findByRole("alert");
  cleanup();
  const onClose = vi.fn();
  render(
    <Editor
      journal={journal}
      operation="create"
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  fireEvent.click(screen.getByLabelText("保存后继续录入（保留日期和账户）"));
  fireEvent.click(screen.getByText("使用原请求重试保存"));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(onSaved).toHaveBeenCalledOnce();
});

it("切换业务类型进入原文模式，取消预览后关闭不入账", async () => {
  const { onClose, onSaved } = setup();
  fireEvent.change(screen.getByLabelText("业务类型"), {
    target: { value: "salary" },
  });
  expect(screen.getByLabelText("Beancount 原文")).toBeEnabled();
  expect(screen.getByLabelText("业务类型")).toHaveValue("salary");
  fireEvent.change(screen.getByLabelText("Beancount 原文"), {
    target: {
      value: '2026-09-30 * "工资"\n  Assets:Bank 10 CNY\n  Income:Salary\n',
    },
  });
  fireEvent.click(screen.getByText("预览并校验"));
  expect(await screen.findByText("+1")).toBeInTheDocument();
  expect(screen.getByText("-1")).toBeInTheDocument();
  fireEvent.click(screen.getByText("取消预览，继续修改"));
  expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  fireEvent.click(screen.getByLabelText("关闭编辑"));
  expect(onClose).toHaveBeenCalledOnce();
  expect(onSaved).not.toHaveBeenCalled();
});

it("手动切换原文编辑并回填普通字段", async () => {
  setup();
  fireEvent.click(screen.getAllByRole("checkbox")[0]);
  expect(screen.getByLabelText("Beancount 原文")).toHaveValue("");
  fireEvent.click(screen.getAllByRole("checkbox")[0]);
  expect(screen.getByLabelText("金额")).toBeInTheDocument();
});

it("删除只提交交易标识，不携带录入字段", async () => {
  const { requests, onClose } = setup("success", "delete");
  fireEvent.click(screen.getByText("预览删除影响"));
  fireEvent.click(await screen.findByText("确认删除"));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(requests[0].body).toMatchObject({
    operation: "delete",
    transaction_id: "test",
  });
  expect(requests[0].body.entry).toBeUndefined();
});

it("已知失效的预览会被取消，不会当作保存成功", async () => {
  const { onSaved, onClose } = setup();
  fill();
  fireEvent.click(screen.getByText("预览并校验"));
  await screen.findByText("确认保存");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(fail("预览后账本已被修改")),
  );
  fireEvent.click(screen.getByText("确认保存"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "预览后账本已被修改",
  );
  expect(screen.getByRole("alert")).toHaveTextContent("取消旧预览");
  fireEvent.click(screen.getByText("取消预览，继续修改"));
  expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  expect(onSaved).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it("恢复未完成的预览请求并可直接放弃", async () => {
  localStorage.setItem(
    PENDING_KEY,
    JSON.stringify({
      request: {
        request_id: "old",
        revision: journal.revision,
        operation: "create",
        business: "ordinary",
        raw: "invalid",
      },
    }),
  );
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok(journal)));
  const onClose = vi.fn();
  render(
    <Editor
      journal={journal}
      operation="create"
      onClose={onClose}
      onSaved={vi.fn()}
    />,
  );
  expect(screen.getByLabelText("Beancount 原文")).toBeDisabled();
  fireEvent.click(screen.getByText("取消未保存请求"));
  expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  expect(onClose).toHaveBeenCalledOnce();
});

it("恢复已有预览时可以取消并关闭", async () => {
  localStorage.setItem(
    PENDING_KEY,
    JSON.stringify({
      request: {
        request_id: "kept",
        revision: journal.revision,
        operation: "create",
        business: "ordinary",
        entry: {
          date: "2026-09-30",
          payee: "外卖",
          narration: "",
          amount: "9.90",
          currency: "CNY",
          category: "Expenses:Food",
          payment: "Assets:Cash",
          note: "",
        },
      },
      preview: {
        request_id: "kept",
        target: "txs/2026/09.bean",
        diffs: { "txs/2026/09.bean": "+ 9.90 CNY" },
        status: "preview",
        revision: "b".repeat(64),
      },
    }),
  );
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok(journal)));
  const onClose = vi.fn();
  render(
    <Editor
      journal={journal}
      operation="create"
      onClose={onClose}
      onSaved={vi.fn()}
    />,
  );
  expect(screen.getByText(/已恢复原预览请求/)).toBeInTheDocument();
  expect(screen.getByLabelText("金额")).toHaveValue("9.90");
  fireEvent.click(screen.getByText("取消预览，继续修改"));
  expect(onClose).toHaveBeenCalledOnce();
});

it("账户加载失败时禁止预览并给出原因", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(fail("账本读取失败", 503)),
  );
  render(
    <Editor
      journal={journal}
      operation="create"
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  expect(await screen.findByText(/账户加载失败/)).toBeInTheDocument();
  expect(screen.getByText("预览并校验")).toBeDisabled();
});

it("忽略已卸载后的账户响应，损坏的草稿不会阻塞录入", async () => {
  const pending: ((value: Reply) => void)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Reply>((resolve) => pending.push(resolve))),
  );
  const { unmount } = render(
    <Editor
      journal={journal}
      operation="create"
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  unmount();
  act(() => {
    pending[0](ok(journal));
  });
  localStorage.setItem(PENDING_KEY, "{not json");
  render(
    <Editor
      journal={journal}
      operation="create"
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  expect(screen.getByLabelText("金额")).toHaveValue("");
  expect(screen.queryByText("取消未保存请求")).not.toBeInTheDocument();
});

it("币种可自定义，取消对话框时按忙碌状态决定是否关闭", async () => {
  const { onClose } = setup();
  fireEvent.change(screen.getByLabelText("币种"), {
    target: { value: "USD" },
  });
  expect(screen.getByLabelText("币种")).toHaveValue("USD");
  fireEvent(
    screen.getByRole("dialog"),
    new Event("cancel", { cancelable: true }),
  );
  expect(onClose).toHaveBeenCalledOnce();
});

it("本地存储不可用时保留错误提示并允许继续编辑", async () => {
  setup();
  const removeItem = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(() => {
      throw new Error("storage disabled");
    });
  fireEvent.change(screen.getByLabelText("金额"), {
    target: { value: "5" },
  });
  expect(screen.getByRole("alert")).toHaveTextContent("storage disabled");
  removeItem.mockRestore();
  fireEvent.change(screen.getByLabelText("金额"), {
    target: { value: "6" },
  });
  expect(screen.getByLabelText("金额")).toHaveValue("6");
});

it("非字符串的错误详情也会显示", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) =>
      path.includes("/journal")
        ? ok(journal)
        : {
            ok: false,
            status: 422,
            json: async () => ({ detail: { message: "字段错误" } }),
          },
    ),
  );
  render(
    <Editor
      journal={journal}
      operation="create"
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  fill();
  fireEvent.click(screen.getByText("预览并校验"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    '{"message":"字段错误"}',
  );
});
