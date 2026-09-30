import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import Finance from "./Finance";
import type { Journal } from "./api";

type Reply = { ok: boolean; status?: number; json: () => Promise<unknown> };

const ok = (data: unknown): Reply => ({ ok: true, json: async () => data });

const fail = (detail: string, status = 409): Reply => ({
  ok: false,
  status,
  json: async () => ({ detail }),
});

const accounts: Journal["accounts"] = [
  { name: "Assets:Bank", currencies: ["CNY"] },
  { name: "Assets:Cash", currencies: ["CNY", "USD"] },
  { name: "Liabilities:Card", currencies: ["CNY"] },
  { name: "Expenses:Fee", currencies: ["CNY"] },
  { name: "Income:Salary", currencies: ["CNY"] },
];

const rawOf = (kind: string) =>
  `2026-09-30 * "${kind}"\n  Assets:Cash 100.00 CNY\n`;

function fillTransfer() {
  fireEvent.change(screen.getByLabelText("转出账户"), {
    target: { value: "Assets:Bank" },
  });
  fireEvent.change(screen.getByLabelText("转入 / 还款账户"), {
    target: { value: "Assets:Cash" },
  });
  fireEvent.change(screen.getByLabelText("转入金额"), {
    target: { value: "100" },
  });
  fireEvent.change(screen.getByLabelText("手续费"), {
    target: { value: "2" },
  });
  fireEvent.change(screen.getByLabelText("手续费分类"), {
    target: { value: "Expenses:Fee" },
  });
  fireEvent.change(screen.getByLabelText("账户备注"), {
    target: { value: "备用金" },
  });
}

function fillBalance() {
  fireEvent.change(screen.getByLabelText("核对账户"), {
    target: { value: "Assets:Bank" },
  });
  fireEvent.change(screen.getByLabelText("预期余额"), {
    target: { value: "100" },
  });
}

/** Facts 的值取自 dt 之后的 dd；表单标签可能同名，因此只认 dt。 */
function factValue(label: string): string {
  const term = screen
    .getAllByText(label)
    .find((node) => node.tagName === "DT");
  return term?.parentElement?.querySelector("dd")?.textContent ?? "";
}

it("转账提交完整请求并把原文交给草稿", async () => {
  const raw = rawOf("转账");
  const fetchMock = vi.fn(async (_path: string, _options?: RequestInit) =>
    ok({ business: "ordinary", raw }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const onAdd = vi.fn(() => true);
  const { container } = render(
    <Finance date="2026-09-30" accounts={accounts} onAdd={onAdd} />,
  );

  expect(screen.getByRole("group", { name: "账户业务" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "转账" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getAllByText("待填写").length).toBeGreaterThan(0);
  fillTransfer();
  expect(factValue("转出账户合计（转入金额 + 手续费）")).toBe("102.00 CNY");
  fireEvent.click(screen.getByRole("button", { name: "生成分录" }));

  expect(await screen.findByText(/Assets:Cash 100\.00 CNY/)).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/finance/compose",
    expect.objectContaining({ method: "POST" }),
  );
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body ?? ""))).toEqual({
    kind: "transfer",
    account: "Assets:Bank",
    target: "Assets:Cash",
    amount: "100",
    currency: "CNY",
    fee: "2",
    fee_account: "Expenses:Fee",
    note: "备用金",
    date: "2026-09-30",
  });
  expect(screen.getByText("日常消费")).toBeInTheDocument();

  fireEvent.click(
    screen.getByRole("button", { name: "将核对结果加入草稿" }),
  );
  expect(onAdd).toHaveBeenCalledWith({ business: "ordinary", raw });
  await waitFor(() =>
    expect(container.querySelector(".result-card")).toBeNull(),
  );
});

it("金额按十进制字符串预览合计，无法解析时提示待填写", () => {
  render(<Finance date="2026-09-30" accounts={accounts} onAdd={() => {}} />);
  expect(factValue("转出账户合计（转入金额 + 手续费）")).toBe("待填写");
  fireEvent.change(screen.getByLabelText("转入金额"), {
    target: { value: "一百" },
  });
  expect(factValue("转出账户合计（转入金额 + 手续费）")).toBe("待填写");
  fireEvent.change(screen.getByLabelText("转入金额"), {
    target: { value: "10.005" },
  });
  expect(factValue("转出账户合计（转入金额 + 手续费）")).toBe("10.005 CNY");
  fireEvent.change(screen.getByLabelText("手续费"), { target: { value: "" } });
  expect(factValue("手续费")).toBe("0.00 CNY");
  expect(factValue("转出账户合计（转入金额 + 手续费）")).toBe("10.005 CNY");
  fireEvent.change(screen.getByLabelText("账户币种"), {
    target: { value: "USD" },
  });
  expect(factValue("转入金额")).toBe("10.005 USD");
  expect(factValue("转出账户合计（转入金额 + 手续费）")).toBe("10.005 USD");
});

it("还款只允许负债作为对侧账户", () => {
  render(<Finance date="2026-09-30" accounts={accounts} onAdd={() => {}} />);
  fireEvent.change(screen.getByLabelText("转入 / 还款账户"), {
    target: { value: "Assets:Cash" },
  });

  fireEvent.click(screen.getByRole("button", { name: "信用账户还款" }));
  expect(screen.getByRole("button", { name: "信用账户还款" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const target = screen.getByLabelText("转入 / 还款账户") as HTMLSelectElement;
  expect(Array.from(target.options).map((o) => o.textContent)).toEqual([
    "请选择",
    "Liabilities:Card",
  ]);
  expect(target.value).toBe("");

  const source = screen.getByLabelText("转出账户") as HTMLSelectElement;
  expect(Array.from(source.options).map((o) => o.textContent)).toEqual([
    "请选择",
    "Assets:Bank",
    "Assets:Cash",
    "Liabilities:Card",
  ]);
  expect(screen.getByLabelText("手续费")).toHaveValue("0");

  // 负债账户对转账同样合法，切回转账时保留选择。
  fireEvent.change(target, { target: { value: "Liabilities:Card" } });
  fireEvent.click(screen.getByRole("button", { name: "转账" }));
  expect(
    (screen.getByLabelText("转入 / 还款账户") as HTMLSelectElement).value,
  ).toBe("Liabilities:Card");
});

it("余额断言列出账面、预期与负差额，切换业务后作废", async () => {
  const raw = "2026-09-30 balance Assets:Bank 100.00 CNY\n";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      ok({
        business: "balance",
        raw,
        expected: "100.00",
        actual: "88.50",
        difference: "-11.50",
      }),
    ),
  );
  const { container } = render(
    <Finance date="2026-09-30" accounts={accounts} onAdd={() => {}} />,
  );

  fireEvent.click(screen.getByRole("button", { name: "余额断言" }));
  expect(screen.queryByLabelText("转入金额")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("手续费")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("手续费分类")).not.toBeInTheDocument();
  expect(screen.getByLabelText("核对账户")).toBeInTheDocument();
  expect(screen.queryByLabelText("转出账户")).not.toBeInTheDocument();
  expect(screen.getByText(/不生成交易/)).toBeInTheDocument();

  fillBalance();
  fireEvent.click(screen.getByRole("button", { name: "核对差额" }));

  const difference = await screen.findByText("-11.50 CNY");
  expect(difference).toHaveClass("difference", "neg");
  expect(screen.getByText("88.50 CNY")).toBeInTheDocument();
  expect(
    container.querySelector(".result-head"),
  ).toHaveTextContent("余额断言");
  expect(
    container.querySelector(".result-head"),
  ).toHaveTextContent("Assets:Bank · 2026-09-30 开始时");

  fireEvent.click(screen.getByRole("button", { name: "转账" }));
  expect(container.querySelector(".result-card")).toBeNull();
  expect(screen.getByText(/填写账户与金额后点/)).toBeInTheDocument();
});

it("日期变化后隐藏上一个日期的结果", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      ok({
        business: "balance",
        raw: "2026-09-30 balance Assets:Bank 100.00 CNY\n",
        expected: "100.00",
        actual: "88.50",
        difference: "-11.50",
      }),
    ),
  );
  const onAdd = vi.fn(() => {});
  const { container, rerender } = render(
    <Finance date="2026-09-30" accounts={accounts} onAdd={onAdd} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "余额断言" }));
  fillBalance();
  fireEvent.click(screen.getByRole("button", { name: "核对差额" }));
  await screen.findByText("-11.50 CNY");

  rerender(<Finance date="2026-10-01" accounts={accounts} onAdd={onAdd} />);
  expect(container.querySelector(".result-card")).toBeNull();
  expect(screen.queryByText("-11.50 CNY")).not.toBeInTheDocument();
});

it("compose 失败时显示错误提示", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => fail("账本有错误，请先修复后核对")),
  );
  render(<Finance date="2026-09-30" accounts={accounts} onAdd={() => {}} />);
  fillTransfer();
  fireEvent.click(screen.getByRole("button", { name: "生成分录" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "账本有错误，请先修复后核对",
  );
  expect(screen.queryByText(/Assets:Cash 100\.00 CNY/)).not.toBeInTheDocument();
});

it("草稿写入失败时保留结果", async () => {
  const raw = rawOf("转账");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ok({ business: "ordinary", raw })),
  );
  const onAdd = vi.fn(() => false);
  const { container } = render(
    <Finance date="2026-09-30" accounts={accounts} onAdd={onAdd} />,
  );
  fillTransfer();
  fireEvent.click(screen.getByRole("button", { name: "生成分录" }));
  await screen.findByText(/Assets:Cash 100\.00 CNY/);

  fireEvent.click(screen.getByRole("button", { name: "将核对结果加入草稿" }));
  expect(onAdd).toHaveBeenCalledWith({ business: "ordinary", raw });
  expect(container.querySelector(".result-card")).not.toBeNull();
  expect(screen.getByText(/Assets:Cash 100\.00 CNY/)).toBeInTheDocument();
});

it("差额为零时不加正负色，缺少账面字段用破折号", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      ok({
        business: "balance",
        raw: "2026-09-30 balance Assets:Bank 100.00 CNY\n",
        difference: "0",
      }),
    ),
  );
  render(<Finance date="2026-09-30" accounts={accounts} onAdd={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "余额断言" }));
  fillBalance();
  fireEvent.click(screen.getByRole("button", { name: "核对差额" }));

  const difference = await screen.findByText("0.00 CNY");
  expect(difference.className).toBe("difference");
  expect(factValue("预期")).toBe("—");
  expect(factValue("账面实际")).toBe("—");
  expect(screen.getByText(/不会自动补差或增加 pad/)).toBeInTheDocument();
});

it("网络异常时也显示错误提示", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }),
  );
  render(<Finance date="2026-09-30" accounts={accounts} onAdd={() => {}} />);
  fillTransfer();
  fireEvent.click(screen.getByRole("button", { name: "生成分录" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "TypeError: Failed to fetch",
  );
});

it("未选账户时结果说明使用占位文案", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ok({ business: "ordinary", raw: rawOf("转账") })),
  );
  const { container } = render(
    <Finance date="2026-09-30" accounts={accounts} onAdd={() => {}} />,
  );
  fireEvent.submit(container.querySelector("form") as HTMLFormElement);
  await screen.findByText(/Assets:Cash 100\.00 CNY/);
  expect(container.querySelector(".result-head")).toHaveTextContent(
    "转出账户 → 对侧账户",
  );

  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      ok({
        business: "balance",
        raw: "2026-09-30 balance 100.00 CNY\n",
        expected: "100.00",
        actual: "100.00",
        difference: "0",
      }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "余额断言" }));
  fireEvent.submit(container.querySelector("form") as HTMLFormElement);
  await waitFor(() =>
    expect(container.querySelector(".result-head")).toHaveTextContent(
      "所选账户 · 2026-09-30 开始时",
    ),
  );
});

it("生成期间禁用全部字段", async () => {
  let release: (reply: Reply) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Reply>((resolve) => (release = resolve))),
  );
  render(<Finance date="2026-09-30" accounts={accounts} onAdd={() => {}} />);
  fillTransfer();
  fireEvent.click(screen.getByRole("button", { name: "生成分录" }));

  expect(screen.getByLabelText("转入金额")).toBeDisabled();
  expect(screen.getByLabelText("转入 / 还款账户")).toBeDisabled();
  expect(screen.getByRole("button", { name: "生成分录" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "余额断言" })).toBeDisabled();

  await act(async () => {
    release(ok({ business: "ordinary", raw: rawOf("转账") }));
  });
  await waitFor(() =>
    expect(screen.getByLabelText("转入金额")).not.toBeDisabled(),
  );
});
