import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import Editor, { PENDING_KEY } from "./Editor";
import BatchEditor from "./BatchEditor";
import QuickFill from "./QuickFill";
import { captureFill, quickFillKey, readFills } from "./fillTemplates";
import type { Journal, PostingEntry } from "./api";
import type { RecordTemplate } from "./businessConfig";

const journal: Journal = {
  identity: "ledger-a",
  date: "2026-10-05",
  revision: "a".repeat(64),
  view_revision: "a".repeat(64),
  stale: false,
  errors: [],
  transactions: [],
  expenses: {},
  income: {},
  sync: "待提交",
  accounts: ["Expenses:Games", "Assets:Cash"].map((name) => ({
    name,
    currencies: ["JPY"],
  })),
};
const props = { journal, onClose: vi.fn(), onSaved: vi.fn(async () => {}) };
const fields = {
  date: journal.date,
  payee: "DLsite",
  narration: "",
  note: "",
  amount: "12",
  currency: "JPY",
  category: "",
  payment: "",
};
const lines = Array.from({ length: 6 }, (_, i) => ({
  account: i === 5 ? "Expenses:Games" : "Assets:Cash",
  amount: i === 5 ? null : "-100",
  currency: i === 5 ? "" : "JPY",
  note: `项目${i + 1}`,
}));

function setup(template?: RecordTemplate) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      const body = options?.body ? JSON.parse(String(options.body)) : {};
      calls.push({ url, body });
      const data = url.includes("/layout")
        ? { version: "v1", layout: { routes: { ordinary: { template } } } }
        : url.includes("preview")
          ? {
              request_id: body.request_id,
              revision: journal.revision,
              diffs: {},
              items: [],
              status: "preview",
            }
          : url.includes("/templates") || url.includes("/orders")
            ? []
            : journal;
      return { ok: true, json: async () => data };
    }),
  );
  return calls;
}
function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function seed() {
  localStorage.setItem(
    quickFillKey(journal.identity),
    JSON.stringify([
      {
        business: "ordinary",
        name: "六行购物",
        schema: "form:expense",
        data: captureFill(fields, lines, null, {}, true),
      },
      {
        business: "salary",
        name: "发薪",
        schema: "form:income",
        data: captureFill(fields, undefined, null, {}, false),
      },
    ]),
  );
}
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("saves incomplete six-line forms, reloads and submits without carrying the old date", async () => {
  const calls = setup();
  const view = render(<Editor {...props} operation="create" />);
  await screen.findByLabelText("快速填充模板");
  fireEvent.click(screen.getByLabelText("多行分录表单（含预算权益）"));
  for (let i = 0; i < 4; i++) fireEvent.click(screen.getByText("增加分录"));
  lines.forEach((line, i) => {
    change(`分录账户 ${i + 1}`, line.account);
    change(`分录币种 ${i + 1}`, "JPY");
    if (line.amount === null)
      fireEvent.click(screen.getByLabelText(`自动推导 ${i + 1}`));
  });
  change("交易日期", "2026-09-01");
  change("商户", "DLsite");
  change("快速模板名称", "六行购物");
  fireEvent.click(screen.getByText("保存为快速模板"));
  expect(await screen.findByText(/已保存「六行购物」/)).toBeInTheDocument();
  view.unmount();
  render(<Editor {...props} operation="create" />);
  await screen.findByLabelText("快速填充模板");
  change("快速填充模板", "六行购物");
  fireEvent.click(screen.getByText("应用模板"));
  expect(screen.getByLabelText("多行分录表单（含预算权益）")).toBeChecked();
  expect(screen.getByLabelText("交易日期")).toHaveValue(journal.date);
  expect(screen.getByLabelText("分录账户 6")).toHaveValue("Expenses:Games");
  expect(screen.getByLabelText("自动推导 6")).toBeChecked();
  expect(screen.getByLabelText("分录金额 1")).toHaveValue("");
  for (let i = 1; i <= 5; i++) change(`分录金额 ${i}`, "-100");
  fireEvent.click(screen.getByText("预览并校验"));
  await waitFor(() =>
    expect(calls.some((c) => c.url === "/api/preview")).toBe(true),
  );
  const entry = calls.find((c) => c.url === "/api/preview")!.body
    .posting_entry as PostingEntry;
  expect(entry.postings).toHaveLength(6);
  expect(entry.date).toBe(journal.date);
  expect(entry.postings[5].source_index).toBeUndefined();
});

it("shares templates with backfill and switches to six posting rows before adding the draft", async () => {
  const calls = setup();
  seed();
  render(<BatchEditor {...props} />);
  await screen.findByLabelText("快速填充模板");
  change("补记日期", "2026-09-15");
  change("快速填充模板", "六行购物");
  fireEvent.click(screen.getByText("应用模板"));
  expect(screen.getByLabelText("分录交易日期")).toHaveValue("2026-09-15");
  expect(screen.getByLabelText("分录金额 5")).toHaveValue("-100");
  fireEvent.click(screen.getByText("加入草稿"));
  fireEvent.click(screen.getByText("整批预览并校验"));
  await waitFor(() =>
    expect(calls.some((c) => c.url === "/api/batch/preview")).toBe(true),
  );
  const items = calls.find((c) => c.url === "/api/batch/preview")!.body
    .items as { posting_entry: PostingEntry }[];
  expect(items[0].posting_entry.postings).toHaveLength(6);
  expect(items[0].posting_entry.date).toBe("2026-09-15");
});

it("isolates businesses and ledgers, updates a selection and deletes it", async () => {
  setup();
  seed();
  const view = render(<Editor {...props} operation="create" />);
  await screen.findByLabelText("快速填充模板");
  expect(
    within(screen.getByLabelText("快速填充模板")).queryByText("发薪"),
  ).toBeNull();
  change("业务类型", "salary");
  expect(
    within(screen.getByLabelText("快速填充模板")).queryByText("六行购物"),
  ).toBeNull();
  change("快速填充模板", "发薪");
  change("商户", "公司");
  fireEvent.click(screen.getByText("更新所选模板"));
  change("商户", "");
  fireEvent.click(screen.getByText("应用模板"));
  expect(screen.getByLabelText("商户")).toHaveValue("公司");
  fireEvent.click(screen.getByText("删除所选模板"));
  expect(
    within(screen.getByLabelText("快速填充模板")).queryByText("发薪"),
  ).toBeNull();
  expect(
    readFills(localStorage.getItem(quickFillKey(journal.identity))),
  ).toHaveLength(1);
  view.unmount();
  render(
    <Editor
      {...props}
      journal={{ ...journal, identity: "other" }}
      operation="create"
    />,
  );
  await screen.findByLabelText("快速填充模板");
  expect(
    within(screen.getByLabelText("快速填充模板")).queryByText("六行购物"),
  ).toBeNull();
});

it("captures only editable record fields and preserves fixed/today/date semantics", () => {
  const template: RecordTemplate = {
    source: "",
    fields: {
      date: { label: "日期", type: "date", mode: "input", value: "" },
      today: { label: "今天", type: "date", mode: "today", value: "" },
      fixed: { label: "固定", type: "text", mode: "fixed", value: "fixed" },
      payee: { label: "商户", type: "text", mode: "input", value: "" },
      amount: { label: "金额", type: "amount", mode: "input", value: "" },
    },
  };
  const values = {
    date: "2020-01-01",
    fixed: "bad",
    payee: "shop",
    amount: "10",
  };
  expect(captureFill(fields, undefined, template, values, false)).toEqual({
    mode: "record",
    values: { payee: "shop" },
  });
  expect(captureFill(fields, undefined, template, values, true)).toEqual({
    mode: "record",
    values: { payee: "shop", amount: "10" },
  });
});

it("protects corrupt storage, concurrent changes, quota errors and stale schemas", () => {
  const renderPanel = () =>
    render(
      <QuickFill
        identity="ledger-a"
        business="ordinary"
        schema="changed"
        capture={() => captureFill(fields, undefined, null, {}, false)}
        onApply={vi.fn()}
      />,
    );
  seed();
  let view = renderPanel();
  change("快速填充模板", "六行购物");
  expect(screen.getByText("应用模板")).toBeDisabled();
  localStorage.setItem(quickFillKey(journal.identity), "[]");
  fireEvent.click(screen.getByText("更新所选模板"));
  expect(screen.getByText(/另一页面已修改模板/)).toBeInTheDocument();
  view.unmount();
  localStorage.setItem(quickFillKey(journal.identity), "broken");
  view = renderPanel();
  change("快速模板名称", "test");
  fireEvent.click(screen.getByText("保存为快速模板"));
  expect(localStorage.getItem(quickFillKey(journal.identity))).toBe("broken");
  view.unmount();
  localStorage.clear();
  renderPanel();
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  change("快速模板名称", "test");
  fireEvent.click(screen.getByText("保存为快速模板"));
  expect(screen.getByText(/quota/)).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "test" })).toBeNull();
  spy.mockRestore();
});

it("applies a custom business template only to editable fields and invalidates its old preview", async () => {
  const template: RecordTemplate = {
    source: "{{day}} * {{merchant}}\n",
    fields: {
      day: { label: "业务日期", type: "date", mode: "input", value: "" },
      merchant: { label: "业务商户", type: "text", mode: "input", value: "" },
      fixed: {
        label: "固定摘要",
        type: "text",
        mode: "fixed",
        value: "固定内容",
      },
    },
  };
  const calls = setup(template);
  localStorage.setItem(
    quickFillKey(journal.identity),
    JSON.stringify([
      {
        name: "业务快捷",
        business: "ordinary",
        schema: JSON.stringify(template),
        data: {
          mode: "record",
          values: { merchant: "shop", fixed: "bad", day: "2020-01-01" },
        },
      },
    ]),
  );
  render(<Editor {...props} operation="create" />);
  await screen.findByLabelText("快速填充模板");
  change("业务日期", "2026-09-20");
  fireEvent.click(screen.getByText("预览并校验"));
  await screen.findByText("确认保存");
  change("快速填充模板", "业务快捷");
  fireEvent.click(screen.getByText("应用模板"));
  expect(screen.queryByText("确认保存")).toBeNull();
  expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  expect(screen.getByLabelText("业务日期")).toHaveValue("2026-09-20");
  expect(screen.getByLabelText("业务商户")).toHaveValue("shop");
  expect(screen.getByText(/固定摘要=固定内容/)).toBeInTheDocument();
  fireEvent.click(screen.getByText("预览并校验"));
  await waitFor(() =>
    expect(calls.filter((c) => c.url === "/api/preview")).toHaveLength(2),
  );
  expect(calls.filter((c) => c.url === "/api/preview")[1].body.values).toEqual({
    day: "2026-09-20",
    merchant: "shop",
  });
});

it("keeps template actions locked while restoring an unconfirmed save", async () => {
  setup();
  seed();
  localStorage.setItem(
    PENDING_KEY,
    JSON.stringify({
      request: {
        request_id: "pending",
        revision: journal.revision,
        operation: "create",
        business: "ordinary",
        entry: fields,
      },
      uncertain: true,
    }),
  );
  render(<Editor {...props} operation="create" />);
  expect(await screen.findByLabelText("快速填充模板")).toBeDisabled();
  expect(screen.getByText("保存为快速模板")).toBeDisabled();
  expect(screen.getByText("应用模板")).toBeDisabled();
});
