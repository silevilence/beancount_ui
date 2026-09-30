import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import BatchEditor, { draftKey } from "./BatchEditor";
import type { Journal } from "./api";

const journal: Journal = {
  date: "2026-09-29",
  revision: "a".repeat(64),
  view_revision: "a".repeat(64),
  stale: false,
  errors: [],
  transactions: [],
  expenses: {},
  income: {},
  sync: "待提交",
  accounts: [
    { name: "Expenses:Food", currencies: [] },
    { name: "Assets:Cash", currencies: [] },
  ],
};
it("十笔草稿恢复、固定日期、整批请求重试保持身份", async () => {
  const calls: { url: string; body: any }[] = [];
  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      calls.push({ url, body });
      if (url === "/api/commit" && fail) {
        fail = false;
        throw new Error("offline");
      }
      return {
        ok: true,
        json: async () =>
          url.includes("/journal")
            ? journal
            : {
                request_id: body.request_id,
                revision: journal.revision,
                items: [],
                diffs: {},
              },
      };
    }),
  );
  const props = { journal, onClose: vi.fn(), onSaved: vi.fn(async () => {}) };
  const mounted = render(<BatchEditor {...props} />);
  fireEvent.change(screen.getByLabelText("支出分类"), {
    target: { value: "Expenses:Food" },
  });
  fireEvent.change(screen.getByLabelText("付款账户"), {
    target: { value: "Assets:Cash" },
  });
  for (let i = 0; i < 10; i++) {
    fireEvent.change(screen.getByLabelText("实付金额"), {
      target: { value: "1.20" },
    });
    fireEvent.click(screen.getByText("加入草稿"));
  }
  expect(
    JSON.parse(localStorage.getItem(draftKey(journal))!).items,
  ).toHaveLength(10);
  mounted.unmount();
  render(<BatchEditor {...props} />);
  expect(screen.getByLabelText("补记日期")).toHaveValue("2026-09-29");
  fireEvent.click(screen.getByText("整批预览并校验"));
  fireEvent.click(await screen.findByText("确认整批入账"));
  await screen.findByText(/offline/);
  fireEvent.click(screen.getByText("重试原批次保存"));
  await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
  const commits = calls.filter((c) => c.url === "/api/commit");
  expect(commits[0].body).toEqual(commits[1].body);
  expect(
    JSON.parse(localStorage.getItem(draftKey(journal))!).items,
  ).toHaveLength(0);
});

function setupDraft(
  seed?: object,
  failures: { preview?: boolean; commit?: boolean; journal?: boolean } = {},
) {
  if (seed) localStorage.setItem(draftKey(journal), JSON.stringify(seed));
  const requests: { url: string; body: any }[] = [];
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    requests.push({ url, body });
    if (
      (url.includes("journal") && failures.journal) ||
      (url.includes("batch/preview") && failures.preview) ||
      (url.includes("commit") && failures.commit)
    )
      return {
        ok: false,
        status: 409,
        json: async () => ({
          detail: url.includes("commit")
            ? "预览后账本已修改"
            : "第 1 笔：校验失败",
        }),
      };
    return {
      ok: true,
      json: async () =>
        url.includes("journal")
          ? journal
          : url.includes("templates") || url.includes("orders")
            ? []
            : {
                request_id: body.request_id,
                revision: journal.revision,
                items: [
                  { item: 1, target: "txs/2026/09.bean", raw: "预览原文" },
                ],
                diffs: { "txs/2026/09.bean": "+new" },
                warnings: ["第 1 笔含零金额"],
              },
    };
  });
  vi.stubGlobal("fetch", fetcher);
  const props = { journal, onClose: vi.fn(), onSaved: vi.fn(async () => {}) };
  return { ...render(<BatchEditor {...props} />), requests, props, fetcher };
}
const base = {
  date: "2026-09-29",
  amount: "1",
  payee: "店",
  narration: "消费",
  currency: "CNY",
  category: "Expenses:Food",
  payment: "Assets:Cash",
  note: "备注",
};

it("草稿逐笔取回修改、移除、复制和高级原文预览", async () => {
  const { requests, props } = setupDraft({
    form: base,
    items: [{ business: "ordinary", entry: base }],
  });
  fireEvent.click(screen.getByText("复制上一条"));
  expect(screen.getByLabelText("实付金额")).toHaveValue("1");
  fireEvent.click(screen.getByText("取回修改"));
  expect(screen.getByText("待入账草稿 · 0 笔")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("购物付款方式"), {
    target: { value: "deferred" },
  });
  fireEvent.click(screen.getByText("加入草稿"));
  expect(
    JSON.parse(localStorage.getItem(draftKey(journal))!).items[0].order.kind,
  ).toBe("deferred");
  fireEvent.click(screen.getByText("移除"));
  fireEvent.click(screen.getByLabelText("高级分录录入"));
  fireEvent.change(screen.getByLabelText("高级业务路由"), {
    target: { value: "ordinary" },
  });
  fireEvent.change(screen.getByLabelText("高级 Beancount 原文"), {
    target: { value: '2026-09-29 * "原文"' },
  });
  fireEvent.click(screen.getByText("加入草稿"));
  fireEvent.click(screen.getByText("取回修改"));
  expect(screen.getByLabelText("高级 Beancount 原文")).toHaveValue(
    '2026-09-29 * "原文"',
  );
  fireEvent.click(screen.getByText("加入草稿"));
  fireEvent.click(screen.getByText("整批预览并校验"));
  await screen.findByText("第 1 笔含零金额");
  expect(
    requests.find((r) => r.url === "/api/batch/preview")!.body.items[0].raw,
  ).toContain("原文");
  fireEvent.click(screen.getByText("取消预览并修改"));
  fireEvent.click(screen.getByText("关闭补记"));
  expect(props.onClose).toHaveBeenCalled();
});

it("预览失败保留草稿，版本冲突允许重新预览，模板不带历史金额", async () => {
  const failures = { preview: true, commit: false };
  setupDraft(
    { form: base, items: [{ business: "ordinary", entry: base }] },
    failures,
  );
  fireEvent.click(screen.getByText("整批预览并校验"));
  await screen.findByText(/校验失败/);
  fireEvent.click(screen.getByText("取消预览并修改"));
  failures.preview = false;
  fireEvent.click(screen.getByText("整批预览并校验"));
  await screen.findByText("确认整批入账");
  failures.commit = true;
  fireEvent.click(screen.getByText("确认整批入账"));
  await screen.findByText(/预览后账本已修改/);
  fireEvent.click(screen.getByText("取消预览并修改"));
  fireEvent.click(screen.getByRole("button", { name: "工资 / 奖金" }));
  expect(screen.getByLabelText("到账金额")).toHaveValue("");
  expect(screen.getByLabelText("工资 / 奖金备注")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("补记日期"), {
    target: { value: "2026-10-01" },
  });
  fireEvent.click(screen.getByRole("button", { name: "淘宝 / 88VIP" }));
  expect(screen.getByLabelText("补记日期")).toHaveValue("2026-10-01");
});

it("并行页面修改与存储配额失败不会覆盖草稿", async () => {
  setupDraft({ form: base, items: [] });
  const key = draftKey(journal);
  const original = localStorage.getItem(key)!;
  localStorage.setItem(key, "other");
  fireEvent.change(screen.getByLabelText("商户"), {
    target: { value: "新店" },
  });
  expect(screen.getByText(/另一页面/)).toBeInTheDocument();
  expect(localStorage.getItem(key)).toBe("other");
  localStorage.setItem(key, original);
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  fireEvent.click(screen.getByText("加入草稿"));
  expect(screen.getByText(/quota/)).toBeInTheDocument();
  spy.mockRestore();
});

it("损坏的草稿明确报告并锁定，不能静默覆盖", () => {
  localStorage.setItem(draftKey(journal), "bad json");
  setupDraft();
  expect(screen.getByText(/草稿读取失败/)).toBeInTheDocument();
  expect(screen.getByText("加入草稿")).toBeDisabled();
  expect(localStorage.getItem(draftKey(journal))).toBe("bad json");
});

it("账户加载失败明确显示，取消对话框可返回", async () => {
  const { props } = setupDraft(undefined, { journal: true });
  await screen.findByText(/校验失败/);
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: true }));
  expect(props.onClose).toHaveBeenCalled();
});
