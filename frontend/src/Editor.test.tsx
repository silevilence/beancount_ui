import {
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import Editor, { PENDING_KEY } from "./Editor";
import type { Journal, Transaction } from "./api";

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
    { name: "Assets:Cash", currencies: ["CNY"] },
  ],
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
function setup(mode: "success" | "timeout" | "invalid" = "success") {
  let failures = mode === "timeout" ? 1 : 0;
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const fetcher = vi
    .fn()
    .mockImplementation(async (path: string, options?: RequestInit) => {
      if (path.includes("/journal"))
        return { ok: true, json: async () => journal };
      const body = JSON.parse(String(options?.body));
      requests.push({ path, body });
      if (path.endsWith("/preview") && mode === "invalid")
        return {
          ok: false,
          status: 409,
          json: async () => ({ detail: "候选账本校验失败" }),
        };
      if (path.endsWith("/commit") && failures-- > 0)
        throw new Error("network timeout");
      return {
        ok: true,
        json: async () => ({
          request_id: body.request_id,
          target: "txs/2026/09.bean",
          diffs: { "txs/2026/09.bean": "+ 12.30 CNY" },
          status: "preview",
          revision: "b".repeat(64),
        }),
      };
    });
  vi.stubGlobal("fetch", fetcher);
  const onSaved = vi.fn().mockResolvedValue(undefined),
    onClose = vi.fn();
  render(
    <Editor
      journal={journal}
      operation="create"
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  return { requests, onSaved, onClose };
}

it("previews exact decimal values, prevents duplicate clicks and continues with the new revision", async () => {
  const { requests, onSaved } = setup();
  fill();
  fireEvent.click(screen.getByText("预览并校验"));
  fireEvent.click(await screen.findByText("确认保存"));
  fireEvent.click(screen.getByText("正在保存…"));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(requests.filter((r) => r.path.endsWith("/commit"))).toHaveLength(1);
  expect(screen.getByLabelText("金额")).toHaveValue("");
  expect(screen.getByLabelText("交易日期")).toHaveValue("2026-09-30");
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

it("retries a timed-out save with the same persisted request", async () => {
  const { requests, onSaved } = setup("timeout");
  fill();
  fireEvent.click(screen.getByText("预览并校验"));
  fireEvent.click(await screen.findByText("确认保存"));
  expect(await screen.findByRole("alert")).toHaveTextContent("不要重新录入");
  expect(screen.getByLabelText("金额")).toBeDisabled();
  const pending = JSON.parse(localStorage.getItem(PENDING_KEY)!);
  expect(pending.uncertain).toBe(true);
  fireEvent.click(screen.getByText("使用原请求重试保存"));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  const commits = requests.filter((r) => r.path.endsWith("/commit"));
  expect(commits[0].body.request_id).toBe(commits[1].body.request_id);
  expect(localStorage.getItem(PENDING_KEY)).toBeNull();
});

it("retains invalid input for correction", async () => {
  setup("invalid");
  fill();
  fireEvent.click(screen.getByText("预览并校验"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "候选账本校验失败",
  );
  expect(screen.getByLabelText("金额")).toHaveValue("12.30");
  expect(screen.queryByText("确认保存")).not.toBeInTheDocument();
});

it("opens complex records as raw text and previews deletion", async () => {
  const row = {
    id: "test",
    date: "2026-09-30",
    raw: '2026-09-30 * "股票"\n  Assets:Shares 1 HOOL {10 USD}\n  Assets:Bank -10 USD\n',
    simple: false,
    postings: [],
  } as unknown as Transaction;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => journal }),
  );
  const { unmount } = render(
    <Editor
      journal={journal}
      row={row}
      operation="edit"
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  expect(screen.getByLabelText("Beancount 原文")).toHaveValue(row.raw);
  expect(screen.getByRole("checkbox")).toBeDisabled();
  unmount();
  render(
    <Editor
      journal={journal}
      row={row}
      operation="delete"
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  expect(screen.getByText("预览删除影响")).toBeInTheDocument();
});

it("restores and completes an uncertain request after remounting", async () => {
  setup("timeout");
  fill();
  fireEvent.click(screen.getByText("预览并校验"));
  fireEvent.click(await screen.findByText("确认保存"));
  await screen.findByRole("alert");
  cleanup();
  const saved = vi.fn(),
    close = vi.fn();
  render(
    <Editor
      journal={journal}
      operation="create"
      onClose={close}
      onSaved={saved}
    />,
  );
  fireEvent.click(screen.getByLabelText("保存后继续录入（保留日期和账户）"));
  fireEvent.click(screen.getByText("使用原请求重试保存"));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(saved).toHaveBeenCalledOnce();
});

it("changes raw business input, cancels preview and closes without saving", async () => {
  const { onClose } = setup();
  fireEvent.change(screen.getByLabelText("业务类型"), {
    target: { value: "salary" },
  });
  fireEvent.change(screen.getByLabelText("Beancount 原文"), {
    target: {
      value: '2026-09-30 * "工资"\n  Assets:Bank 10 CNY\n  Income:Salary\n',
    },
  });
  fireEvent.click(screen.getByText("预览并校验"));
  await screen.findByText("确认保存");
  fireEvent.click(screen.getByText("取消预览，继续修改"));
  expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  fireEvent.click(screen.getByLabelText("关闭编辑"));
  expect(onClose).toHaveBeenCalledOnce();
});

it("previews and commits a delete with no entry payload", async () => {
  const { requests } = setup();
  cleanup();
  const close = vi.fn();
  render(
    <Editor
      journal={journal}
      operation="delete"
      row={
        {
          id: "delete-me",
          raw: "original",
          postings: [],
        } as unknown as Transaction
      }
      onClose={close}
      onSaved={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText("预览删除影响"));
  fireEvent.click(await screen.findByText("确认删除"));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(requests[0].body).toMatchObject({
    operation: "delete",
    transaction_id: "delete-me",
  });
  expect(requests[0].body.entry).toBeUndefined();
});

it("lets a known stale preview be cancelled without treating it as a successful save", async () => {
  const { onSaved } = setup();
  fill();
  fireEvent.click(screen.getByText("预览并校验"));
  await screen.findByText("确认保存");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ detail: "预览后账本已被修改" }),
    }),
  );
  fireEvent.click(screen.getByText("确认保存"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "预览后账本已被修改",
  );
  fireEvent.click(screen.getByText("取消预览，继续修改"));
  expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  expect(onSaved).not.toHaveBeenCalled();
});

it("can abandon a restored request whose preview never completed", async () => {
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
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => journal }),
  );
  const close = vi.fn();
  render(
    <Editor
      journal={journal}
      operation="create"
      onClose={close}
      onSaved={vi.fn()}
    />,
  );
  expect(screen.getByLabelText("Beancount 原文")).toBeDisabled();
  fireEvent.click(screen.getByText("取消未保存请求"));
  expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  expect(close).toHaveBeenCalledOnce();
});
