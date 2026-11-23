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

function setup(history?: (url: URL) => Transaction[]) {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      const body = options?.body ? JSON.parse(String(options.body)) : {};
      requests.push({ url, body });
      let data: unknown = journal;
      if (url.includes("/transactions/search"))
        data = {
          transactions: history?.(new URL(url, "http://localhost")) ?? [],
          has_more: false,
        };
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
          items: [{ item: 1, target: "test.bean", raw: row.raw }],
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

it("搜索旧交易填入当前日期，修改金额后按新记录保存", async () => {
  const postings = [
    { account: "Expenses:Games", amount: "30", currency: "CNY", note: "" },
    { account: "Assets:Cash", amount: "-30", currency: "CNY", note: "" },
  ];
  const source = {
    ...row,
    date: "2026-05-01",
    simple: true,
    postings,
    posting_form: { ...form, postings },
    metadata: { "order-id": "old" },
  };
  const requests = setup((url) =>
    url.searchParams.get("q") === "预算" ? [source] : [],
  );
  render(<Editor {...props} operation="create" />);
  fireEvent.click(await screen.findByText("从历史记录填入"));
  await screen.findByText("没有找到匹配的记录。");
  change("搜索历史记录", "预算");
  fireEvent.click(
    await screen.findByRole("button", { name: /游戏商户 · 预算/ }),
  );
  expect(screen.getByLabelText("交易日期")).toHaveValue(journal.date);
  expect(screen.getByLabelText("金额")).toHaveValue("30");
  expect(screen.getByLabelText("金额")).toHaveFocus();
  change("金额", "42");
  expect(screen.queryByText("撤销填入")).toBeNull();
  fireEvent.click(screen.getByText("预览并校验"));
  fireEvent.click(await screen.findByText("确认保存"));
  const confirm = screen.queryByRole("button", { name: "按这些日期入账" });
  if (confirm) fireEvent.click(confirm);
  await waitFor(() =>
    expect(requests.some((r) => r.url.endsWith("/commit"))).toBe(true),
  );
  const preview = requests.find((r) => r.url.endsWith("/preview"))!.body;
  expect(preview).toMatchObject({
    operation: "create",
    entry: {
      date: journal.date,
      payee: form.payee,
      narration: form.narration,
      note: form.note,
      amount: "42",
      category: "Expenses:Games",
      payment: "Assets:Cash",
    },
  });
  expect(preview).not.toHaveProperty("transaction_id");
  expect(preview).not.toHaveProperty("order");
});

it("Esc 收起历史搜索，选错后可恢复原有商品和手填内容", async () => {
  setup(() => [row]);
  render(<Editor {...props} operation="create" />);
  change("摘要", "手填采购");
  change("金额", "56");
  fireEvent.click(screen.getByText("添加商品明细"));
  change("商品名称", "洗发水");
  const trigger = await screen.findByText("从历史记录填入");
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByLabelText("搜索历史记录"), { key: "Escape" });
  expect(trigger).toHaveFocus();
  expect(screen.queryByLabelText("搜索历史记录")).toBeNull();
  fireEvent.click(trigger);
  fireEvent.click(
    await screen.findByRole("button", { name: /游戏商户 · 预算/ }),
  );
  const amount = screen.getByLabelText("分录金额 1");
  expect(amount).toHaveFocus();
  fireEvent.blur(amount);
  fireEvent.click(screen.getByText("撤销填入"));
  expect(screen.getByLabelText("摘要")).toHaveValue("手填采购");
  expect(screen.getByLabelText("商品名称")).toHaveValue("洗发水");
  expect(screen.getByLabelText("金额")).toHaveValue("56");
  expect(trigger).toHaveFocus();
});

it("多行回填保留逐行备注和价格，重新选择后旧预览失效", async () => {
  const price = { kind: "total" as const, amount: "8", currency: "CNY" };
  const postings = form.postings.map((p, i) => (i === 0 ? { ...p, price } : p));
  const requests = setup(() => [
    { ...row, posting_form: { ...form, postings } },
    {
      ...row,
      id: "cost",
      narration: "证券成本",
      posting_form: null,
      raw: '2026-08-30 * "证券成本"\n  Assets:Shares 1 HOOL {10 USD}\n  Assets:Bank -10 USD',
    },
  ]);
  render(<Editor {...props} operation="create" />);
  fireEvent.click(await screen.findByText("从历史记录填入"));
  fireEvent.click(
    await screen.findByRole("button", { name: /游戏商户 · 预算/ }),
  );
  expect(screen.getByLabelText("分录备注 1")).toHaveValue("备注0");
  fireEvent.click(screen.getByText("预览并校验"));
  await screen.findByText("确认保存");
  const preview = requests.find((r) => r.url.endsWith("/preview"))!.body;
  expect(preview.posting_entry).toEqual({
    ...form,
    postings: postings.map(({ source_index, ...posting }) => posting),
  });
  fireEvent.click(screen.getByText("从历史记录填入"));
  fireEvent.click(await screen.findByRole("button", { name: /证券成本/ }));
  expect(screen.getByLabelText("Beancount 原文")).toHaveFocus();
  expect(screen.queryByText("确认保存")).toBeNull();
  expect(screen.getByLabelText("Beancount 原文")).toHaveValue(
    `${journal.date} * "证券成本"\n  Assets:Shares 1 HOOL {10 USD}\n  Assets:Bank -10 USD`,
  );
});

it.each(["single", "batch"])(
  "%s 商户摘要支持历史候选并可自由填写",
  async (mode) => {
    setup();
    const withHistory = {
      ...journal,
      completions: {
        payees: ["Bitcash"],
        narrations: ["充值"],
        currencies: ["CNY", "JPY"],
        tags: [],
        links: [],
      },
    };
    render(
      mode === "single" ? (
        <Editor {...props} journal={withHistory} operation="create" />
      ) : (
        <BatchEditor {...props} journal={withHistory} />
      ),
    );
    const payee = screen.getByRole("combobox", { name: "商户" });
    fireEvent.change(payee, { target: { value: "bit" } });
    fireEvent.keyDown(payee, { key: "ArrowDown" });
    fireEvent.keyDown(payee, { key: "Enter" });
    expect(payee).toHaveValue("Bitcash");
    const narration = screen.getByRole("combobox", { name: "摘要" });
    fireEvent.focus(narration);
    fireEvent.click(screen.getByRole("option", { name: "充值" }));
    expect(narration).toHaveValue("充值");
    change("商户", "全新商户");
    fireEvent.blur(payee);
    expect(payee).toHaveValue("全新商户");
  },
);

it("原文编辑高亮账户，并在光标处补全账户", async () => {
  setup();
  render(<Editor {...props} operation="create" />);
  fireEvent.click(screen.getByLabelText("原文高级编辑"));
  const raw = screen.getByLabelText("Beancount 原文");
  const text = '2026-10-24 * "Bitcash" "充值"\n  Assets:Ca';
  fireEvent.change(raw, {
    target: { value: text, selectionStart: text.length },
  });
  expect(document.querySelector(".bean-token-account")).toHaveTextContent(
    "Assets:Ca",
  );
  fireEvent.keyDown(raw, { key: "Enter" });
  expect(raw).toHaveValue(text.replace("Assets:Ca", "Assets:Cash"));
});

it("历史汇兑记录可回填修改并以原价格类型提交", async () => {
  const requests = setup();
  const exchange: PostingEntry = {
    ...form,
    postings: [
      {
        account: "Assets:Cash",
        amount: "10000",
        currency: "JPY",
        note: "",
        source_index: 0,
        price: { kind: "total", amount: "430", currency: "CNY" },
      },
      {
        account: "Equity:Opening",
        amount: "-430",
        currency: "CNY",
        note: "",
        source_index: 1,
      },
    ],
  };
  render(
    <Editor
      {...props}
      operation="edit"
      row={{ ...row, posting_form: exchange }}
    />,
  );
  expect(screen.getByLabelText("换算总价 1")).toHaveValue("430");
  change("换算总价 1", "450");
  change("分录金额 2", "-450");
  fireEvent.click(screen.getByText("预览并校验"));
  await waitFor(() =>
    expect(
      requests.find((r) => r.url === "/api/preview")?.body.posting_entry,
    ).toMatchObject({
      postings: [
        {
          source_index: 0,
          amount: "10000",
          currency: "JPY",
          price: { kind: "total", amount: "450", currency: "CNY" },
        },
        { source_index: 1, amount: "-450" },
      ],
    }),
  );
});

it("补记原文使用同一编辑器，并将补全后的完整原文加入草稿", async () => {
  setup();
  render(<BatchEditor {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /高级分录 多分录/ }));
  const raw = screen.getByLabelText("高级 Beancount 原文");
  const text = '2026-10-24 * "Bitcash" "充值"\n  Assets:Ca';
  fireEvent.change(raw, {
    target: { value: text, selectionStart: text.length },
  });
  fireEvent.keyDown(raw, { key: "Tab" });
  const completed = `${text.replace("Assets:Ca", "Assets:Cash")} 10000 JPY @@ 430 CNY\n  Equity:Opening -430 CNY`;
  fireEvent.change(raw, { target: { value: completed } });
  fireEvent.click(screen.getByText("加入草稿"));
  const stored = JSON.parse(localStorage.getItem(draftKey(journal))!);
  expect(stored.items[0].raw).toBe(completed);
});
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
  if (screen.queryByRole("button", { name: "按这些日期入账" }))
    fireEvent.click(screen.getByRole("button", { name: "按这些日期入账" }));
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
