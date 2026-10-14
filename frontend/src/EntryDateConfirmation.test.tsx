import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Editor, { PENDING_KEY } from "./Editor";
import BatchEditor, { draftKey } from "./BatchEditor";
import type { Journal } from "./api";

const today = "2026-10-14";
const journal: Journal = {
  date: today,
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
const form = {
  date: today,
  amount: "12",
  currency: "CNY",
  payee: "店",
  narration: "午餐",
  category: "Expenses:Food",
  payment: "Assets:Cash",
  note: "保留备注",
};
const entry = (day: string) => ({
  raw: `${day} * "消费"\n  Expenses:Food 12 CNY\n  Assets:Cash -12 CNY\n`,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T15:59:59Z"));
  vi.stubGlobal(
    "confirm",
    vi.fn(() => false),
  );
});
afterEach(() => vi.useRealTimers());

function setup(mode: "single" | "batch", days: string[], timeout = false) {
  const items = days.map((day, i) => ({
    ...entry(day),
    item: i + 1,
    target: "test.bean",
  }));
  const preview = {
    request_id: "saved-preview",
    revision: journal.revision,
    items,
    target: "test.bean",
    diffs: { "test.bean": "+内容" },
    status: "preview",
  };
  const request = {
    request_id: preview.request_id,
    revision: journal.revision,
    operation: "create",
    business: "ordinary",
    entry: form,
  };
  const key = mode === "single" ? PENDING_KEY : draftKey(journal);
  localStorage.setItem(
    key,
    JSON.stringify(
      mode === "single"
        ? { request, preview }
        : {
            form,
            items: items.map(({ raw }) => ({ business: "ordinary", raw })),
            pending: { ...request, items, preview },
          },
    ),
  );
  const commits: string[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/commit")) {
      commits.push(String(init?.body));
      if (timeout && commits.length === 1) throw new Error("network timeout");
      return { ok: true, json: async () => ({ revision: journal.revision }) };
    }
    const data = url.includes("/layout")
      ? { version: "v1", write_day: today, layout: { routes: {} } }
      : url.includes("/templates")
        ? []
        : journal;
    return { ok: true, json: async () => data };
  });
  vi.stubGlobal("fetch", fetcher);
  const onSaved = vi.fn(async () => {});
  const props = { journal, onSaved, onClose: vi.fn() };
  const mount = () =>
    render(
      mode === "single" ? (
        <Editor {...props} operation="create" />
      ) : (
        <BatchEditor {...props} />
      ),
    );
  mount();
  const save = () =>
    fireEvent.click(
      screen.getByRole("button", {
        name: mode === "single" ? "确认保存" : "确认整批入账",
      }),
    );
  return { key, commits, onSaved, save, mount };
}

it.each(["single", "batch"] as const)(
  "%s 取消保留完整预览与内容，确认后只发送一个保存请求",
  async (mode) => {
    const { key, commits, onSaved, save } = setup(mode, ["2026-10-13"]);
    const before = localStorage.getItem(key);
    save();
    expect(window.confirm).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("2026-10-13：1 笔"),
    );
    expect(commits).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe(before);
    expect(
      screen.getByLabelText(mode === "single" ? "金额" : "实付金额"),
    ).toHaveValue("12");
    vi.mocked(window.confirm).mockReturnValue(true);
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(commits).toEqual([JSON.stringify({ request_id: "saved-preview" })]);
    expect(window.confirm).toHaveBeenCalledTimes(2);
  },
);

it.each(["single", "batch"] as const)(
  "%s 所有实际条目均为今日时直接保存",
  async (mode) => {
    const { save, onSaved } = setup(
      mode,
      mode === "single" ? [today] : [today, today],
    );
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(window.confirm).not.toHaveBeenCalled();
  },
);

it.each(["single", "batch"] as const)(
  "%s 恢复预览后跨午夜，保存按新的上海今日确认",
  (mode) => {
    const { save, commits } = setup(mode, [today]);
    vi.setSystemTime(new Date("2026-10-14T16:00:00Z"));
    save();
    expect(window.confirm).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("今日（2026-10-15，上海时间）"),
    );
    expect(commits).toEqual([]);
  },
);

it("单笔的未来日期原文与表单今日不同时，以实际预览日期确认", () => {
  const { save, commits } = setup("single", ["2026-10-16"]);
  expect(screen.getByLabelText("交易日期")).toHaveValue(today);
  save();
  expect(window.confirm).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("2026-10-16：1 笔"),
  );
  expect(commits).toEqual([]);
});

it.each(["single", "batch"] as const)(
  "%s 缺失日期的预览阻止保存且不标记为结果未知",
  async (mode) => {
    const { save, key, commits } = setup(mode, []);
    const before = localStorage.getItem(key);
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "预览缺少条目日期",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("重试原请求");
    expect(localStorage.getItem(key)).toBe(before);
    expect(commits).toEqual([]);
  },
);

it("整批混合日期统一弹一次，按各日期统计笔数", () => {
  const { save, commits } = setup("batch", [
    today,
    "2026-10-13",
    "2026-10-13",
    "2026-10-16",
  ]);
  save();
  expect(window.confirm).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("2026-10-13：2 笔\n2026-10-16：1 笔"),
  );
  expect(commits).toEqual([]);
});

it.each(["single", "batch"] as const)(
  "%s 确认后超时，刷新并重试原请求不重复确认",
  async (mode) => {
    const { save, mount, commits, onSaved } = setup(mode, ["2026-10-13"], true);
    vi.mocked(window.confirm).mockReturnValue(true);
    save();
    await screen.findByText(/network timeout/);
    cleanup();
    mount();
    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(
      screen.getByRole("button", {
        name: mode === "single" ? "使用原请求重试保存" : "重试原批次保存",
      }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(commits).toHaveLength(2);
    expect(commits[0]).toBe(commits[1]);
    expect(window.confirm).toHaveBeenCalledOnce();
  },
);
