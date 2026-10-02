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
import BatchEditor, { draftKey } from "./BatchEditor";
import type { Journal, PostingEntry, Transaction } from "./api";

const journal: Journal = {
  date: "2026-10-01",
  revision: "a".repeat(64),
  view_revision: "a".repeat(64),
  stale: false,
  errors: [],
  transactions: [],
  expenses: {},
  income: {},
  sync: "待提交",
  accounts: [
    "Expenses:Games",
    "Assets:Cash",
    "Equity:Budget:Game",
    "Equity:Opening",
  ].map((name) => ({ name, currencies: ["CNY", "JPY"] })),
};
const props = { journal, onClose: vi.fn(), onSaved: vi.fn(async () => {}) };
const form: PostingEntry = {
  date: journal.date,
  payee: "游戏商户",
  narration: "预算",
  note: "交易备注",
  postings: journal.accounts.map((a, index) => ({
    account: a.name,
    amount: ["166", "-166", "-166", "166"][index],
    currency: "CNY",
    note: `备注${index}`,
    source_index: index,
  })),
};
const row: Transaction = {
  ...form,
  id: "record",
  simple: false,
  readonly: false,
  tags: ["game"],
  kind: "消费",
  file: "test.bean",
  line: 1,
  postings: [],
  posting_form: form,
  raw: '2026-10-01 * "游戏商户" "预算" #game\n',
};

function setup() {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      const body = options?.body ? JSON.parse(String(options.body)) : {};
      requests.push({ url, body });
      let data: unknown = journal;
      if (url.includes("/layout"))
        data = {
          version: "v1",
          write_day: journal.date,
          layout: { routes: {} },
        };
      if (url.includes("/templates") || url.includes("/orders")) data = [];
      if (url.includes("preview"))
        data = {
          request_id: body.request_id,
          revision: journal.revision,
          diffs: { "test.bean": "+new" },
          items: [],
          status: "preview",
        };
      if (url.includes("commit"))
        data = {
          request_id: body.request_id,
          revision: journal.revision,
          status: "done",
        };
      return { ok: true, json: async () => data };
    }),
  );
  return requests;
}
function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("creates four budget postings, previews and clears fields after saving", async () => {
  const requests = setup();
  render(<Editor {...props} operation="create" />);
  fireEvent.click(screen.getByLabelText("多行分录表单（含预算权益）"));
  fireEvent.click(screen.getByText("增加分录"));
  fireEvent.click(screen.getByText("增加分录"));
  form.postings.forEach((p, i) => {
    change(`分录账户 ${i + 1}`, p.account);
    change(`分录金额 ${i + 1}`, p.amount!);
    change(`分录备注 ${i + 1}`, p.note);
  });
  expect(screen.getByText(/CNY 合计.*已平衡/)).toBeInTheDocument();
  fireEvent.click(screen.getByText("预览并校验"));
  await waitFor(() =>
    expect(requests.some((r) => r.url === "/api/preview")).toBe(true),
  );
  const body = requests.find((r) => r.url === "/api/preview")!.body;
  expect(body.entry).toBeUndefined();
  expect((body.posting_entry as PostingEntry).postings).toEqual(
    form.postings.map(({ source_index: _index, ...p }) => p),
  );
  fireEvent.click(await screen.findByText("确认保存"));
  await screen.findByText("已保存 4 行分录");
  expect(screen.getByLabelText("分录金额 1")).toHaveValue("");
  expect(screen.queryByLabelText("分录金额 3")).not.toBeInTheDocument();
});

it("refills historical postings, keeps source identity when removing rows and adding inference", async () => {
  const requests = setup();
  render(<Editor {...props} operation="edit" row={row} />);
  expect(screen.getByLabelText("分录备注 3")).toHaveValue("备注2");
  change("分录备注 3", "Steam");
  fireEvent.click(screen.getByText("移除分录 1"));
  fireEvent.click(screen.getByText("增加分录"));
  change("分录账户 4", "Expenses:Games");
  fireEvent.click(screen.getByLabelText("自动推导 4"));
  expect(screen.getByLabelText("分录金额 4")).toBeDisabled();
  fireEvent.click(screen.getByText("预览并校验"));
  await waitFor(() =>
    expect(requests.some((r) => r.url === "/api/preview")).toBe(true),
  );
  const submitted = requests.find((r) => r.url === "/api/preview")!.body
    .posting_entry as PostingEntry;
  expect(submitted.postings.map((p) => p.source_index)).toEqual([
    1,
    2,
    3,
    undefined,
  ]);
  expect(submitted.postings[1].note).toBe("Steam");
  expect(submitted.postings[3]).toMatchObject({ amount: null, currency: "" });
});

it("restores a pending multi-posting request and submits the same identity", async () => {
  localStorage.setItem(
    PENDING_KEY,
    JSON.stringify({
      request: {
        request_id: "pending",
        revision: journal.revision,
        operation: "create",
        business: "ordinary",
        posting_entry: form,
      },
    }),
  );
  const requests = setup();
  render(<Editor {...props} operation="create" />);
  expect(screen.getByLabelText("分录备注 3")).toHaveValue("备注2");
  expect(screen.getByLabelText("分录金额 3")).toBeDisabled();
  fireEvent.click(screen.getByText("预览并校验"));
  await waitFor(() =>
    expect(
      requests.find((r) => r.url === "/api/preview")?.body.request_id,
    ).toBe("pending"),
  );
});

it("single-entry shopping splits submit negative discounts and per-line notes", async () => {
  const requests = setup();
  render(<Editor {...props} operation="create" />);
  change("金额", "5331");
  change("币种", "JPY");
  change("支出分类", "Expenses:Games");
  change("付款账户", "Assets:Cash");
  fireEvent.click(screen.getByText("展开商品与折扣明细"));
  ["1430", "1430", "1320", "2090", "-939"].forEach((amount, index) => {
    if (index) fireEvent.click(screen.getByText("增加商品 / 折扣项"));
    change(`明细金额 ${index + 1}`, amount);
    change(
      `商品备注 ${index + 1}`,
      index === 4 ? "优惠券" : `商品${index + 1}`,
    );
  });
  expect(screen.getByText("合计与实付一致")).toBeInTheDocument();
  fireEvent.click(screen.getByText("预览并校验"));
  await waitFor(() =>
    expect(
      requests.find((r) => r.url === "/api/preview")?.body.entry,
    ).toMatchObject({
      amount: "5331",
      currency: "JPY",
      splits: expect.arrayContaining([
        { category: "Expenses:Games", amount: "-939", note: "优惠券" },
      ]),
    }),
  );
});

it("persists, recalls and submits batch posting forms with their original date", async () => {
  const requests = setup();
  localStorage.setItem(
    draftKey(journal),
    JSON.stringify({
      task: "advanced",
      business: "ordinary",
      form: {
        date: "2026-09-15",
        payee: "",
        narration: "",
        note: "",
        amount: "",
        category: "",
        payment: "",
        currency: "CNY",
      },
      items: [],
      postingMode: true,
      postingLines: form.postings.map(({ source_index: _index, ...p }) => p),
    }),
  );
  const view = render(<BatchEditor {...props} />);
  expect(screen.getByLabelText("分录交易日期")).toHaveValue("2026-09-15");
  fireEvent.click(screen.getByText("加入草稿"));
  const tray = screen.getByLabelText("待入账草稿");
  expect(within(tray).getByText("2026-09-15")).toBeInTheDocument();
  view.unmount();
  render(<BatchEditor {...props} />);
  fireEvent.click(screen.getByText("取回修改"));
  expect(screen.getByLabelText("分录金额 3")).toHaveValue("-166");
  change("分录备注 3", "budget edit");
  fireEvent.click(screen.getByText("加入草稿"));
  fireEvent.click(screen.getByText("整批预览并校验"));
  await waitFor(() =>
    expect(requests.some((r) => r.url.includes("batch/preview"))).toBe(true),
  );
  const items = requests.find((r) => r.url.includes("batch/preview"))!.body
    .items as { posting_entry: PostingEntry }[];
  expect(items[0].posting_entry.date).toBe("2026-09-15");
  expect(items[0].posting_entry.postings[2].note).toBe("budget edit");
});
