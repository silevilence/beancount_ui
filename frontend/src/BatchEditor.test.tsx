import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import BatchEditor, { draftKey } from "./BatchEditor";
import type { Journal } from "./api";
import { shanghaiToday } from "./format";

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
    { name: "Income:Salary", currencies: [] },
  ],
};
const ok = (data: unknown) => ({ ok: true, json: async () => data });
const bad = (detail: string) => ({
  ok: false,
  status: 409,
  json: async () => ({ detail }),
});
const preview = (requestId: string) => ({
  request_id: requestId,
  revision: journal.revision,
  items: [{ item: 1, target: "txs/2026/09.bean", raw: "预览原文" }],
  diffs: { "txs/2026/09.bean": "+new" },
  warnings: ["第 1 笔含零金额"],
});
interface Recorded {
  url: string;
  body: unknown;
}

/** 从记录下来的请求体读取字符串字段；字段缺失或类型不符时返回空串。 */
function textOf(body: unknown, key: string): string {
  if (body && typeof body === "object" && key in body) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return "";
}
const props = { journal, onClose: vi.fn(), onSaved: vi.fn(async () => {}) };
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

/** 按端点返回合法形状的 fetch stub，避免模板/订单把预览对象当数组。 */
function stubFetch(
  seed: Parameters<typeof setup>[0] = undefined,
  failures: {
    preview?: boolean;
    commit?: boolean;
    offline?: boolean;
    journal?: boolean;
  } = {},
) {
  if (seed) localStorage.setItem(draftKey(journal), JSON.stringify(seed));
  const requests: Recorded[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      const body: unknown = options?.body
        ? JSON.parse(String(options.body))
        : undefined;
      requests.push({ url, body });
      if (url.includes("journal") && failures.journal) return bad("校验失败");
      if (url.includes("orders")) return ok([]);
      if (url.includes("income/days")) return ok([]);
      if (url.includes("templates")) return ok([]);
      if (url.includes("batch/preview")) {
        if (failures.preview) return bad("第 1 笔：校验失败");
        return ok(preview(textOf(body, "request_id")));
      }
      if (url.includes("finance/compose"))
        return ok({ business: "ordinary", raw: "转账 20 CNY" });
      if (url.includes("commit")) {
        if (failures.offline) throw new Error("offline");
        if (failures.commit) return bad("预览后账本已修改");
        return ok({ revision: journal.revision });
      }
      return ok(journal);
    }),
  );
  return requests;
}

function setup(
  seed?: object,
  failures: {
    preview?: boolean;
    commit?: boolean;
    offline?: boolean;
    journal?: boolean;
  } = {},
) {
  const requests = stubFetch(seed, failures);
  return { ...render(<BatchEditor {...props} />), requests };
}

const fillDaily = (amount: string) => {
  fireEvent.change(screen.getByLabelText("支出分类"), {
    target: { value: "Expenses:Food" },
  });
  fireEvent.change(screen.getByLabelText("付款账户"), {
    target: { value: "Assets:Cash" },
  });
  fireEvent.change(screen.getByLabelText("实付金额"), {
    target: { value: amount },
  });
  fireEvent.click(screen.getByText("加入草稿"));
};

/** 草稿单元格：托盘与轨道都会显示笔数，断言统一在托盘内进行。 */
const tray = () =>
  within(screen.getByRole("complementary", { name: "待入账草稿" }));

it("淘宝订单处理默认今天，不沿用零笔草稿中旧的日常录入日期", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T16:01:00Z"));
  localStorage.setItem(
    draftKey(journal),
    JSON.stringify({
      form: { ...base, date: "2026-10-01" },
      items: [],
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("orders"))
        return ok([
          {
            id: "old-order",
            date: "2026-09-27",
            payee: "淘宝",
            narration: "发带",
            mode: "deferred",
            total: "12",
            unpaid: "12",
            refunded: "0",
            currency: "CNY",
            account: "Liabilities:PayAfter",
            categories: { "Expenses:Food": "12" },
          },
        ]);
      if (url.includes("templates")) return ok([]);
      return ok(journal);
    }),
  );
  try {
    expect(shanghaiToday()).toBe("2026-10-02");
    await act(async () => {
      render(<BatchEditor {...props} />);
    });
    fireEvent.click(screen.getByRole("button", { name: /淘宝订单/ }));
    fireEvent.click(await screen.findByText("淘宝 · 发带"));
    expect(screen.getByLabelText("本次处理日期")).toHaveValue("2026-10-02");
    expect(
      screen.queryByText(/当前录入日期为 2026-10-01/),
    ).not.toBeInTheDocument();
    const addOrder = () => {
      fireEvent.change(screen.getByLabelText("实际付款 / 收款账户"), {
        target: { value: "Assets:Cash" },
      });
      fireEvent.click(
        screen.getByLabelText("我已确认关联交易及负债 / 付款语义"),
      );
      fireEvent.click(screen.getByRole("button", { name: "将处理加入草稿" }));
    };
    addOrder();
    expect(
      JSON.parse(localStorage.getItem(draftKey(journal))!).items[0].order.date,
    ).toBe("2026-10-02");
    fireEvent.click(screen.getByText("淘宝 · 发带"));
    vi.setSystemTime(new Date("2026-10-02T16:01:00Z"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByLabelText("本次处理日期")).toHaveValue("2026-10-03");
    expect(fetch).toHaveBeenCalledWith(
      "/api/journal?day=2026-10-03",
      undefined,
    );
    fireEvent.change(screen.getByLabelText("本次处理日期"), {
      target: { value: "2026-09-30" },
    });
    vi.setSystemTime(new Date("2026-10-03T16:01:00Z"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByLabelText("本次处理日期")).toHaveValue("2026-09-30");
    expect(screen.getByText(/当前录入日期为 2026-09-30/)).toBeInTheDocument();
    addOrder();
    expect(
      JSON.parse(localStorage.getItem(draftKey(journal))!).items.map(
        (item: { order: { date: string } }) => item.order.date,
      ),
    ).toEqual(["2026-10-02", "2026-09-30"]);
    fireEvent.click(screen.getByRole("button", { name: "新记录改用今天" }));
    fireEvent.click(screen.getByText("淘宝 · 发带"));
    expect(screen.getByLabelText("本次处理日期")).toHaveValue("2026-10-04");
    fireEvent.click(screen.getByRole("button", { name: /日常消费/ }));
    expect(screen.getByLabelText("补记日期")).toHaveValue("2026-10-01");
  } finally {
    vi.useRealTimers();
  }
});

it("重新打开已清空的补记草稿时采用当前工作台日期", () => {
  setup({
    form: {
      ...base,
      date: "2026-09-28",
      amount: "",
      payee: "",
      narration: "",
      note: "",
    },
    items: [],
  });
  expect(screen.getByLabelText("补记日期")).toHaveValue(journal.date);
});

it("恢复未完成内容和待入账记录时保留原日期并明确提示", () => {
  setup({
    form: { ...base, date: "2026-09-28" },
    items: [{ business: "ordinary", entry: { ...base, date: "2026-09-28" } }],
  });
  expect(screen.getByLabelText("补记日期")).toHaveValue("2026-09-28");
  expect(screen.getByText(/当前录入日期为 2026-09-28/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "新记录改用今天" }));
  expect(screen.getByLabelText("补记日期")).toHaveValue(shanghaiToday());
  const saved = JSON.parse(localStorage.getItem(draftKey(journal))!);
  expect(saved.items[0].entry.date).toBe("2026-09-28");
  expect(saved.form.amount).toBe(base.amount);
});

it("十笔草稿恢复、固定日期、整批请求重试保持身份", async () => {
  vi.stubGlobal("crypto", {
    getRandomValues: crypto.getRandomValues.bind(crypto),
  });
  const requests = stubFetch();
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
  expect(tray().getByText("10 笔")).toBeInTheDocument();
  mounted.unmount();
  const failures = { offline: true };
  const remount = setup(undefined, failures);
  expect(screen.getByLabelText("补记日期")).toHaveValue("2026-09-29");
  expect(tray().getByText("10 笔")).toBeInTheDocument();
  fireEvent.click(screen.getByText("整批预览并校验"));
  expect(await screen.findByText("第 1 笔")).toBeInTheDocument();
  expect(screen.getAllByText("txs/2026/09.bean")).toHaveLength(2);
  expect(screen.getByText("第 1 笔含零金额")).toBeInTheDocument();
  fireEvent.click(screen.getByText("确认整批入账"));
  expect(await screen.findByText(/offline/)).toBeInTheDocument();
  failures.offline = false;
  fireEvent.click(screen.getByText("重试原批次保存"));
  await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
  const commits = remount.requests.filter((call) => call.url === "/api/commit");
  expect(commits).toHaveLength(2);
  expect(commits[0].body).toEqual(commits[1].body);
  expect(
    JSON.parse(localStorage.getItem(draftKey(journal))!).items,
  ).toHaveLength(0);
  expect(screen.getByText(/整批已入账/)).toBeInTheDocument();
  remount.unmount();
});

it("草稿逐笔取回修改、移除、复制与高级原文预览", async () => {
  const { requests, unmount } = setup({
    form: base,
    items: [{ business: "ordinary", entry: base }],
  });
  fireEvent.click(screen.getByText("复制上一条"));
  expect(screen.getByLabelText("实付金额")).toHaveValue("1");
  fireEvent.click(screen.getByText("取回修改"));
  expect(screen.queryByText("取回修改")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("购物付款方式"), {
    target: { value: "deferred" },
  });
  fireEvent.click(screen.getByText("加入草稿"));
  expect(
    JSON.parse(localStorage.getItem(draftKey(journal))!).items[0].order.kind,
  ).toBe("deferred");
  fireEvent.click(screen.getByText("移除"));
  fireEvent.click(screen.getByRole("button", { name: /高级分录/ }));
  fireEvent.change(screen.getByLabelText("高级业务路由"), {
    target: { value: "ordinary" },
  });
  fireEvent.change(screen.getByLabelText("高级 Beancount 原文"), {
    target: { value: '2026-09-29 * "原文"' },
  });
  fireEvent.click(screen.getByText("加入草稿"));
  expect(screen.getByText("日常消费 · 原文")).toBeInTheDocument();
  fireEvent.click(screen.getByText("取回修改"));
  expect(screen.getByLabelText("高级 Beancount 原文")).toHaveValue(
    '2026-09-29 * "原文"',
  );
  fireEvent.click(screen.getByText("加入草稿"));
  fireEvent.click(screen.getByText("整批预览并校验"));
  await screen.findByText("第 1 笔含零金额");
  /** 预览请求体由本测试的 stub 记录，形状即 BatchMutation。 */
  const sent = requests.find((call) => call.url === "/api/batch/preview")!
    .body as {
    items: { raw: string }[];
  };
  expect(sent.items[0].raw).toContain("原文");
  fireEvent.click(screen.getByText("取消预览并修改"));
  fireEvent.click(screen.getByText("关闭补记"));
  expect(props.onClose).toHaveBeenCalled();
  unmount();
});

it("作业分区切换、模板快捷入口与草稿计数", async () => {
  const { requests } = setup();
  expect(screen.getByText(/还没有草稿/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "工资 / 奖金" }));
  expect(screen.getByLabelText("到账金额")).toBeInTheDocument();
  expect(screen.getByLabelText("收入账户")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("到账金额"), {
    target: { value: "9000" },
  });
  fireEvent.change(screen.getByLabelText("收入账户"), {
    target: { value: "Income:Salary" },
  });
  fireEvent.change(screen.getByLabelText("到账账户"), {
    target: { value: "Assets:Cash" },
  });
  fireEvent.click(screen.getByText("加入草稿"));
  expect(tray().getByText("1 笔")).toBeInTheDocument();
  expect(tray().getAllByText("9,000.00 CNY")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: /转账 \/ 还款 \/ 余额/ }));
  expect(screen.getByRole("group", { name: "账户业务" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /余额宝收益/ }));
  expect(await screen.findByText("核对日期")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /淘宝订单/ }));
  expect(await screen.findByText("淘宝确认收货 / 退款")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /模板与推荐/ }));
  expect(screen.getByText("将当前组合固定为模板")).toBeInTheDocument();
  expect(requests.some((call) => call.url.includes("/templates"))).toBe(true);
});

it("预览失败保留草稿，版本冲突允许重新预览，模板日期保持选中值", async () => {
  const failures = { preview: true, commit: false };
  setup(
    {
      form: base,
      items: [{ business: "ordinary", entry: base }],
      task: "daily",
    },
    failures,
  );
  fireEvent.click(screen.getByText("整批预览并校验"));
  expect(await screen.findByText(/校验失败/)).toBeInTheDocument();
  expect(tray().getByText("1 笔")).toBeInTheDocument();
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
  expect(screen.getByLabelText("摘要")).toHaveValue("88VIP每日红包");
});

it("并行页面修改与存储配额失败不会覆盖草稿", () => {
  setup({ form: base, items: [] });
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
  setup();
  expect(screen.getByText(/草稿读取失败/)).toBeInTheDocument();
  expect(screen.getByText("加入草稿")).toBeDisabled();
  expect(localStorage.getItem(draftKey(journal))).toBe("bad json");
});

it("账户加载失败明确显示，取消对话框可返回", async () => {
  const { unmount } = setup(undefined, { journal: true });
  expect(await screen.findByText(/校验失败/)).toBeInTheDocument();
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: true }));
  expect(props.onClose).toHaveBeenCalled();
  unmount();
});

it("业务面板加入的草稿进入托盘并标注待预览", async () => {
  setup({ form: base, items: [] });
  fireEvent.click(screen.getByRole("button", { name: /转账 \/ 还款 \/ 余额/ }));
  fireEvent.change(screen.getByLabelText("转出账户"), {
    target: { value: "Assets:Cash" },
  });
  fireEvent.change(screen.getByLabelText("转入 / 还款账户"), {
    target: { value: "Assets:Cash" },
  });
  fireEvent.change(screen.getByLabelText("转入金额"), {
    target: { value: "20" },
  });
  fireEvent.change(screen.getByLabelText("账户币种"), {
    target: { value: "CNY" },
  });
  fireEvent.click(screen.getByText("生成分录"));
  fireEvent.click(await screen.findByText("将核对结果加入草稿"));
  expect(tray().getByText("1 笔")).toBeInTheDocument();
  expect(tray().getByText("日常消费 · 原文")).toBeInTheDocument();
  expect(tray().getByText(/金额以预览为准/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /高级分录/ }));
  fireEvent.change(screen.getByLabelText("高级业务路由"), {
    target: { value: "phone" },
  });
  fireEvent.change(screen.getByLabelText("高级 Beancount 原文"), {
    target: { value: '2026-09-29 * "话费"' },
  });
  const form = screen.getByLabelText("高级 Beancount 原文").closest("form")!;
  fireEvent.keyDown(form, { key: "Enter", ctrlKey: true });
  expect(tray().getByText("2 笔")).toBeInTheDocument();
  expect(tray().getByText("话费 · 原文")).toBeInTheDocument();
});

it("ctrl 加回车加入草稿，可在托盘追加多笔", async () => {
  setup({ form: base, items: [] });
  fillDaily("2.5");
  expect(tray().getByText("1 笔")).toBeInTheDocument();
  const form = screen.getByLabelText("商户").closest("form")!;
  fireEvent.change(screen.getByLabelText("实付金额"), {
    target: { value: "3" },
  });
  fireEvent.keyDown(form, { key: "Enter", ctrlKey: true });
  expect(tray().getByText("2 笔")).toBeInTheDocument();
  fireEvent.click(screen.getByText("整批预览并校验"));
  expect(await screen.findByText("第 1 笔")).toBeInTheDocument();
});
