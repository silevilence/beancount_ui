import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import Editor from "./Editor";
import BatchEditor, { draftKey } from "./BatchEditor";
import RecordFields from "./RecordFields";
import TemplateSettings, {
  starterTemplate,
  templateWithSource,
} from "./TemplateSettings";
import {
  chainOf,
  changedRoutes,
  fieldIssue,
  inputValues,
  pathIssue,
  renderExample,
  routeIssues,
  routeLabel,
  sourceIssue,
  templateDay,
  templateSummary,
  type BusinessConfig,
  type Layout,
  type RecordTemplate,
} from "./businessConfig";
import type { Journal } from "./api";

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
  accounts: [{ name: "Assets:Cash", currencies: ["CNY"] }],
};
const config: BusinessConfig = {
  version: "config-1",
  write_day: "2026-10-01",
  layout: {
    entry: "main.beancount",
    routes: {
      ordinary: { target: "a.bean", indexes: [], template: starterTemplate },
      lunch: {
        target: "lunch.bean",
        indexes: [],
        label: "午餐",
        template: {
          ...starterTemplate,
          fields: {
            date: { label: "交易日期", type: "date", mode: "today", value: "" },
            amount: {
              label: "午餐金额",
              type: "amount",
              mode: "input",
              value: "",
            },
          },
        },
      },
    },
  },
};
const props = { journal, onClose: vi.fn(), onSaved: vi.fn(async () => {}) };
function mockApi(
  fail = false,
  businessConfig = config,
  view = (_url: string) => journal,
) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const ok = (data: unknown) => ({ ok: true, json: async () => data });
    if (url === "/api/layout")
      return fail
        ? { ok: false, status: 500, json: async () => ({ detail: "暂不可用" }) }
        : ok(businessConfig);
    if (url.includes("/journal")) return ok(view(url));
    if (url === "/api/orders") return ok([]);
    if (url.includes("/templates")) return ok([]);
    if (url.includes("preview"))
      return ok({
        request_id: body.request_id,
        status: "preview",
        revision: journal.revision,
        target: "a.bean",
        diffs: { "a.bean": "+记录" },
        items: [{ item: 1, target: "a.bean", raw: "预览原文" }],
      });
    return ok({ status: "done", revision: journal.revision });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

it.each(["salary", "yuebao"])(
  "自定义 %s 无模板业务使用收入表单并提交收入账户",
  async (kind) => {
    const custom = structuredClone(config);
    custom.layout.routes.bonus = {
      target: "bonus.bean",
      indexes: [],
      kind,
      label: "自定义收入",
    };
    const fetcher = mockApi(false, custom, () => ({
      ...journal,
      accounts: [
        ...journal.accounts,
        { name: "Income:Salary", currencies: ["CNY"] },
      ],
    }));
    render(<BatchEditor {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "自定义收入" }));
    fireEvent.change(screen.getByLabelText("到账金额"), {
      target: { value: "12" },
    });
    fireEvent.change(screen.getByLabelText("收入账户"), {
      target: { value: "Income:Salary" },
    });
    fireEvent.change(screen.getByLabelText("到账账户"), {
      target: { value: "Assets:Cash" },
    });
    fireEvent.click(screen.getByRole("button", { name: "加入草稿" }));
    fireEvent.click(screen.getByRole("button", { name: /整批预览/ }));
    await screen.findByText("预览原文");
    const request = fetcher.mock.calls.find(
      ([url]) => url === "/api/batch/preview",
    )!;
    expect(JSON.parse(String(request[1]?.body)).items).toEqual([
      expect.objectContaining({
        business: "bonus",
        entry: expect.objectContaining({
          category: "Income:Salary",
          payment: "Assets:Cash",
        }),
      }),
    ]);
  },
);

it("单笔自定义余额业务无模板时自动使用原文", async () => {
  const custom = structuredClone(config);
  custom.layout.routes.custom = {
    target: "custom.bean",
    indexes: [],
    kind: "balance",
    label: "自定义业务",
  };
  const fetcher = mockApi(false, custom);
  render(<Editor {...props} operation="create" />);
  await screen.findByRole("option", { name: "自定义业务" });
  fireEvent.change(screen.getByLabelText("业务类型"), {
    target: { value: "custom" },
  });
  expect(screen.getByLabelText("原文高级编辑")).toBeChecked();
  expect(screen.getByLabelText("原文高级编辑")).toBeDisabled();
  const raw = "2026-09-30 balance Assets:Cash 12 CNY";
  fireEvent.change(screen.getByLabelText("Beancount 原文"), {
    target: { value: raw },
  });
  fireEvent.click(screen.getByText("预览并校验"));
  await screen.findByText("确认保存");
  const request = fetcher.mock.calls.find(([url]) => url === "/api/preview")!;
  expect(JSON.parse(String(request[1]?.body))).toMatchObject({
    business: "custom",
    raw,
  });
});

it.each([
  ["salary", "salary"],
  ["yuebao", "yuebao"],
  ["custom", "salary"],
  ["custom", "yuebao"],
])("单笔 %s（%s）使用收入表单并提交到账金额", async (business, kind) => {
  const custom = structuredClone(config);
  custom.layout.routes[business] = {
    target: "income.bean",
    indexes: [],
    kind,
    label: "收入业务",
  };
  const fetcher = mockApi(false, custom, () => ({
    ...journal,
    accounts: [
      ...journal.accounts,
      { name: "Income:Salary", currencies: ["CNY"] },
      { name: "Expenses:Food", currencies: ["CNY"] },
      { name: "Liabilities:Card", currencies: ["CNY"] },
    ],
  }));
  render(<Editor {...props} operation="create" />);
  await screen.findByRole("option", { name: "收入业务" });
  fireEvent.change(screen.getByLabelText("业务类型"), {
    target: { value: business },
  });
  expect(screen.getByLabelText("原文高级编辑")).not.toBeChecked();
  expect(screen.getByLabelText("原文高级编辑")).toBeEnabled();
  fireEvent.change(screen.getByLabelText("到账金额"), {
    target: { value: "12.30" },
  });
  fireEvent.focus(screen.getByLabelText("收入账户"));
  expect(
    screen.getByRole("option", { name: "Income:Salary" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: /Expenses:Food/ }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("收入账户"), {
    target: { value: "Income:Salary" },
  });
  fireEvent.focus(screen.getByLabelText("到账账户"));
  expect(
    screen.queryByRole("option", { name: /Liabilities:Card/ }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("到账账户"), {
    target: { value: "Assets:Cash" },
  });
  fireEvent.click(screen.getByText("预览并校验"));
  await screen.findByText("确认保存");
  const request = fetcher.mock.calls.find(([url]) => url === "/api/preview")!;
  expect(JSON.parse(String(request[1]?.body))).toMatchObject({
    business,
    entry: {
      amount: "12.30",
      category: "Income:Salary",
      payment: "Assets:Cash",
    },
  });
  fireEvent.click(screen.getByText("取消预览，继续修改"));
  fireEvent.click(screen.getByLabelText("原文高级编辑"));
  expect(screen.getByLabelText("Beancount 原文")).toBeEnabled();
  fireEvent.click(screen.getByLabelText("原文高级编辑"));
  expect(screen.getByLabelText("到账金额")).toHaveValue("12.30");
});

it("自定义余额业务可录入原文并从草稿取回", async () => {
  const custom = structuredClone(config);
  custom.layout.routes.check = {
    target: "check.bean",
    indexes: [],
    kind: "balance",
    label: "自定义核对",
  };
  mockApi(false, custom);
  render(<BatchEditor {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "自定义核对" }));
  const raw = "2026-09-30 balance Assets:Cash 12 CNY";
  fireEvent.change(screen.getByLabelText("Beancount 原文"), {
    target: { value: raw },
  });
  fireEvent.click(screen.getByRole("button", { name: "加入草稿" }));
  expect(JSON.parse(localStorage.getItem(draftKey(journal))!).items).toEqual([
    { business: "check", raw },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "取回修改" }));
  expect(screen.getByLabelText("Beancount 原文")).toHaveValue(raw);
  fireEvent.click(screen.getByRole("button", { name: /高级分录 多分录/ }));
  expect(screen.getByLabelText("高级业务路由")).toHaveValue("check");
  expect(screen.getByLabelText("高级 Beancount 原文")).toHaveValue(raw);
});

it("切换到转账作业按补记日期重新加载账户，回到模板恢复模板日期", async () => {
  const fetcher = mockApi(false, config, (url) => ({
    ...journal,
    accounts: [
      {
        name: url.endsWith("2026-09-30") ? "Assets:Old" : "Assets:New",
        currencies: ["CNY"],
      },
    ],
  }));
  render(<BatchEditor {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "午餐" }));
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      "/api/journal?day=2026-10-01",
      undefined,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: /转账 \/ 还款 \/ 余额/ }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls
        .filter(([url]) => url.includes("/journal"))
        .at(-1)?.[0],
    ).toBe("/api/journal?day=2026-09-30"),
  );
  fireEvent.focus(screen.getByLabelText("转出账户"));
  expect(
    await screen.findByRole("option", { name: "Assets:Old" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: "Assets:New" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /日常消费 支出/ }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls
        .filter(([url]) => url.includes("/journal"))
        .at(-1)?.[0],
    ).toBe("/api/journal?day=2026-10-01"),
  );
});

it("单笔只呈现开放字段，提交模板值及配置版本，并支持当天日期和自定义业务", async () => {
  const fetcher = mockApi();
  render(<Editor {...props} operation="create" />);
  await waitFor(() =>
    expect(screen.queryByLabelText("支出分类")).not.toBeInTheDocument(),
  );
  expect(screen.queryByLabelText("原文高级编辑")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("金额"), {
    target: { value: "12.30" },
  });
  fireEvent.change(screen.getByLabelText("交易日期"), {
    target: { value: "2026-09-29" },
  });
  fireEvent.click(screen.getByText("预览并校验"));
  await screen.findByText("确认保存");
  const sent = JSON.parse(
    String(
      fetcher.mock.calls.find(([url]) => url === "/api/preview")?.[1]?.body,
    ),
  );
  expect(sent).toMatchObject({
    business: "ordinary",
    values: { date: "2026-09-29", amount: "12.30" },
    layout_version: "config-1",
  });
  expect(sent.raw).toBeUndefined();
  expect(sent.entry).toBeUndefined();
  fireEvent.click(screen.getByText("确认保存"));
  await screen.findByText("已保存到本地账本，可以继续记下一笔。");
  expect(screen.getByText("已按模板保存")).toBeInTheDocument();
  expect(screen.getByLabelText("交易日期")).toHaveValue("2026-09-29");
  fireEvent.change(screen.getByLabelText("业务类型"), {
    target: { value: "lunch" },
  });
  expect(screen.queryByLabelText("交易日期")).not.toBeInTheDocument();
  expect(screen.getByText(/交易日期=保存当天/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("午餐金额"), {
    target: { value: "15" },
  });
  fireEvent.click(screen.getByText("预览并校验"));
  await screen.findByText("确认保存");
  const last = JSON.parse(
    String(
      fetcher.mock.calls.filter(([url]) => url === "/api/preview").at(-1)?.[1]
        ?.body,
    ),
  );
  expect(last.values).toEqual({ amount: "15" });
  expect(
    fetcher.mock.calls.some(([url]) => url === "/api/journal?day=2026-10-01"),
  ).toBe(true);
});

it("批量模板草稿可恢复、改回表单，并将同一字段约束提交给后端", async () => {
  const fetcher = mockApi();
  render(<BatchEditor {...props} />);
  await screen.findByRole("button", { name: "午餐" });
  fireEvent.click(screen.getByRole("button", { name: "午餐" }));
  fireEvent.change(screen.getByLabelText("午餐金额"), {
    target: { value: "15" },
  });
  fireEvent.click(screen.getByRole("button", { name: "加入草稿" }));
  let draft = JSON.parse(localStorage.getItem(draftKey(journal))!);
  expect(draft.templateVersion).toBe("config-1");
  expect(draft.items).toEqual([
    { business: "lunch", values: { amount: "15" }, layout_version: "config-1" },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "取回修改" }));
  expect(screen.getByLabelText("午餐金额")).toHaveValue("15");
  fireEvent.click(screen.getByRole("button", { name: "加入草稿" }));
  fireEvent.click(screen.getByRole("button", { name: /整批预览/ }));
  await screen.findByText("预览原文");
  const sent = JSON.parse(
    String(
      fetcher.mock.calls.find(([url]) => url === "/api/batch/preview")?.[1]
        ?.body,
    ),
  );
  draft = JSON.parse(localStorage.getItem(draftKey(journal))!);
  expect(sent.items).toEqual(draft.items);
});

it("恢复旧配置的草稿保留输入，要求显式重新填写", async () => {
  mockApi();
  localStorage.setItem(
    draftKey(journal),
    JSON.stringify({
      form: { date: journal.date },
      items: [],
      business: "lunch",
      templateVersion: "old",
      templateValues: { amount: "15" },
    }),
  );
  render(<BatchEditor {...props} />);
  const reset = await screen.findByText("按新配置重新填写");
  expect(screen.getByLabelText("午餐金额")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "加入草稿" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("业务配置已变化");
  expect(JSON.parse(localStorage.getItem(draftKey(journal))!).items).toEqual(
    [],
  );
  fireEvent.click(reset);
  expect(screen.getByLabelText("午餐金额")).toBeEnabled();
  expect(screen.getByLabelText("午餐金额")).toHaveValue("");
});

it.each(["single", "batch"])("%s 配置读取失败提示重试", async (mode) => {
  mockApi(true);
  render(
    mode === "single" ? (
      <Editor {...props} operation="create" />
    ) : (
      <BatchEditor {...props} />
    ),
  );
  expect(await screen.findByText(/业务配置读取失败/)).toHaveTextContent(
    "暂不可用",
  );
});

it("模板设置支持示例、占位符插入、重命名、字段类型和三种填写方式", () => {
  function Harness() {
    const [value, setValue] = useState<RecordTemplate | null>(null);
    return (
      <>
        <TemplateSettings value={value} onChange={setValue} name="午餐" />
        <output data-testid="value">{JSON.stringify(value)}</output>
      </>
    );
  }
  const read = () =>
    JSON.parse(
      screen.getByTestId("value").textContent!,
    ) as RecordTemplate | null;
  render(<Harness />);
  expect(screen.getByText(/未启用时使用内置表单/)).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("午餐使用记录模板"));
  expect(screen.getByLabelText("午餐原文模板")).toBeInTheDocument();
  expect(screen.getByLabelText("午餐填写示意")).toHaveTextContent(
    "〈交易日期〉",
  );
  fireEvent.click(screen.getByText("填入完整消费表单示例"));
  expect(screen.getByLabelText("payee显示名称")).toHaveValue("商户");
  expect(screen.getByLabelText("午餐填写示意")).toHaveTextContent("〈商户〉");
  fireEvent.click(screen.getByTitle("插入 {{narration}} 到光标处"));
  expect(read()!.source).toContain("{{narration}}");

  fireEvent.click(screen.getByLabelText("category重命名"));
  fireEvent.change(screen.getByLabelText("category字段名"), {
    target: { value: "bucket" },
  });
  fireEvent.keyDown(screen.getByLabelText("category字段名"), { key: "Enter" });
  expect(read()!.source).toContain("{{bucket}}");
  expect(read()!.fields.bucket).toMatchObject({ label: "分类账户" });
  expect(read()!.fields.category).toBeUndefined();

  fireEvent.click(screen.getByLabelText("bucket重命名"));
  fireEvent.change(screen.getByLabelText("bucket字段名"), {
    target: { value: "Bad" },
  });
  fireEvent.keyDown(screen.getByLabelText("bucket字段名"), { key: "Enter" });
  expect(
    screen.getByText("字段名需小写字母开头，可含数字和下划线"),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("bucket重命名"));
  fireEvent.change(screen.getByLabelText("bucket字段名"), {
    target: { value: "payee" },
  });
  fireEvent.keyDown(screen.getByLabelText("bucket字段名"), { key: "Enter" });
  expect(screen.getByText("字段 payee 已存在")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("bucket重命名"));
  fireEvent.keyDown(screen.getByLabelText("bucket字段名"), { key: "Escape" });
  expect(screen.getByLabelText("bucket重命名")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("date填写方式"), {
    target: { value: "today" },
  });
  expect(screen.queryByLabelText("date默认值")).not.toBeInTheDocument();
  expect(screen.getByLabelText("午餐填写示意")).toHaveTextContent("2026-");
  fireEvent.change(screen.getByLabelText("date显示名称"), {
    target: { value: "" },
  });
  expect(screen.getByText("显示名称不能为空")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("date显示名称"), {
    target: { value: "交易日期" },
  });
  fireEvent.change(screen.getByLabelText("date字段类型"), {
    target: { value: "text" },
  });
  expect(screen.getByLabelText("date填写方式")).toHaveValue("input");
  fireEvent.change(screen.getByLabelText("date字段类型"), {
    target: { value: "date" },
  });
  fireEvent.change(screen.getByLabelText("currency填写方式"), {
    target: { value: "input" },
  });
  fireEvent.change(screen.getByLabelText("currency默认值"), {
    target: { value: "USD" },
  });
  fireEvent.change(screen.getByLabelText("currency显示名称"), {
    target: { value: "交易币种" },
  });
  fireEvent.change(screen.getByLabelText("payee填写方式"), {
    target: { value: "fixed" },
  });
  fireEvent.change(screen.getByLabelText("payee固定值"), {
    target: { value: "食堂" },
  });
  expect(read()!.fields.payee).toMatchObject({ mode: "fixed", value: "食堂" });
  expect(read()!.fields.currency).toMatchObject({
    label: "交易币种",
    mode: "input",
    value: "USD",
  });
  fireEvent.change(screen.getByLabelText("午餐原文模板"), {
    target: {
      value:
        "{{date}} * {{custom}}\n  Assets:Cash {{amount}} CNY\n  Expenses:Food {{-amount}} CNY",
    },
  });
  expect(screen.getByLabelText("custom字段类型")).toHaveValue("text");
  expect(screen.queryByLabelText("payee显示名称")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("仅日期与金额"));
  expect(read()!.fields.amount).toMatchObject({ mode: "input" });
  fireEvent.click(screen.getByText("清除模板"));
  expect(read()).toBeNull();
  expect(screen.getByText(/未启用时使用内置表单/)).toBeInTheDocument();
  fireEvent.click(screen.getByText("恢复上次模板"));
  expect(read()!.fields.amount).toMatchObject({ mode: "input" });
  fireEvent.click(screen.getByLabelText("午餐使用记录模板"));
  expect(read()).toBeNull();
  expect(screen.getByText("恢复上次模板")).toBeInTheDocument();
});

it("动态字段提供账户选择与币种候选，并说明模板生成的内容", () => {
  const template = templateWithSource(
    "{{date}} * {{payee}} {{note}}\n  {{payment}} {{amount}} {{currency}}",
    starterTemplate,
  );
  template.fields.payee = {
    label: "商户",
    type: "text",
    mode: "fixed",
    value: "食堂",
  };
  template.fields.note = {
    label: "空备注",
    type: "text",
    mode: "fixed",
    value: "",
  };
  template.fields.currency = {
    label: "币种",
    type: "currency",
    mode: "input",
    value: "",
  };
  const change = vi.fn();
  render(
    <RecordFields
      template={template}
      values={{}}
      day={journal.date}
      accounts={[
        { name: "Assets:Cash", currencies: ["CNY"] },
        { name: "Assets:Bank", currencies: ["USD"] },
      ]}
      onChange={change}
    />,
  );
  expect(
    screen.getByText(/由模板生成：商户=食堂、空备注=空文本/),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("商户")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("付款账户"), {
    target: { value: "Assets:Cash" },
  });
  expect(change).toHaveBeenCalledWith(
    expect.objectContaining({ payment: "Assets:Cash" }),
  );
  const list = document.querySelector("datalist")!;
  expect(screen.getByLabelText("币种")).toHaveAttribute("list", list.id);
  expect(list.querySelectorAll("option")).toHaveLength(2);
  expect(
    inputValues(template, { payee: "伪造" }, journal.date),
  ).not.toHaveProperty("payee");
  expect(templateDay(null, {}, "fallback", "today")).toBe("fallback");
  expect(
    templateDay({ ...template, source: "invalid" }, {}, "fallback", "today"),
  ).toBe("fallback");
  expect(
    templateDay(
      { ...template, source: '2020-01-01 * "x"' },
      {},
      "fallback",
      "today",
    ),
  ).toBe("2020-01-01");
  expect(templateDay(template, { date: "" }, "fallback", "today")).toBe(
    "fallback",
  );
  template.fields.date.mode = "fixed";
  template.fields.date.value = "2021-02-03";
  expect(templateDay(template, {}, "fallback", "today")).toBe("2021-02-03");
});

it("模板字段覆盖日期、金额与标记输入，全部固定时无需填写", () => {
  const template = templateWithSource(
    '{{date}} * "午餐" {{tag}}\n  Assets:Cash {{amount}} CNY\n',
    starterTemplate,
  );
  template.fields.tag = {
    label: "标签",
    type: "token",
    mode: "input",
    value: "",
  };
  template.fields.amount = {
    label: "金额",
    type: "amount",
    mode: "input",
    value: "12.30",
  };
  const change = vi.fn();
  const { unmount } = render(
    <RecordFields
      template={template}
      values={{}}
      day={journal.date}
      accounts={[{ name: "Assets:Cash", currencies: ["CNY"] }]}
      onChange={change}
    />,
  );
  expect(screen.getByLabelText("金额")).toHaveAttribute("inputmode", "decimal");
  expect(screen.getByText("默认 12.30")).toBeInTheDocument();
  expect(screen.getByLabelText("标签")).toHaveAttribute(
    "placeholder",
    "*、!、#tag 或 ^link",
  );
  expect(screen.getByLabelText("交易日期")).toHaveValue(journal.date);
  fireEvent.change(screen.getByLabelText("标签"), {
    target: { value: "#lunch" },
  });
  expect(change).toHaveBeenCalledWith(
    expect.objectContaining({ tag: "#lunch" }),
  );
  unmount();
  render(
    <RecordFields
      template={{
        source: '2026-01-01 * "午餐"\n  Assets:Cash 12 CNY\n',
        fields: {},
      }}
      values={{}}
      day={journal.date}
      accounts={[]}
      onChange={change}
    />,
  );
  expect(screen.getByText(/无需填写字段/)).toBeInTheDocument();
});

it("业务配置辅助函数解析包含链、路径规则、填写示意与冲突", () => {
  const layout: Layout = {
    entry: "main.beancount",
    routes: {
      ordinary: { target: "a/{year}/{month}.bean", indexes: ["a/index.bean"] },
      lunch: { target: "b.bean", indexes: [], kind: "phone", label: "午餐" },
    },
  };
  expect(
    chainOf(layout.entry, layout.routes.ordinary, "2026-09-30", "2026-10-01"),
  ).toEqual(["main.beancount", "a/index.bean", "a/2026/09.bean"]);
  expect(
    chainOf(
      layout.entry,
      { ...layout.routes.ordinary, date_source: "write" },
      "2026-09-30",
      "2026-10-01",
    ).at(-1),
  ).toBe("a/2026/10.bean");
  expect(chainOf(layout.entry, layout.routes.lunch, "", "").at(-1)).toBe(
    "b.bean",
  );
  expect(pathIssue("a/{year}/{month}.bean")).toBe("");
  expect(pathIssue("a/{month}/{month}.bean")).toContain("最多出现一次");
  expect(pathIssue("a/{week}.bean")).toContain("仅支持");
  expect(pathIssue("../a.bean")).toContain("上级目录");
  expect(pathIssue("a.txt")).toContain("扩展名");
  expect(pathIssue("a/..b.bean")).toContain("空路径段");
  expect(pathIssue("gnucash/a.bean")).toContain("只读");
  expect(pathIssue("a/{year}.bean", false)).toContain(
    "入口路径不支持日期占位符",
  );
  expect(pathIssue("")).toContain("不能为空");
  expect(
    fieldIssue({ label: "", type: "text", mode: "input", value: "" }),
  ).toBe("显示名称不能为空");
  expect(
    fieldIssue({ label: "金额", type: "amount", mode: "fixed", value: "abc" }),
  ).toContain("金额");
  expect(
    fieldIssue({ label: "标签", type: "token", mode: "input", value: "" }),
  ).toContain("默认值");
  expect(
    fieldIssue({
      label: "币种",
      type: "currency",
      mode: "input",
      value: "cny",
    }),
  ).toContain("币种");
  expect(
    fieldIssue({ label: "账户", type: "account", mode: "input", value: "" }),
  ).toBe("");
  const template = templateWithSource(
    '{{date}} * "午餐"\n  Expenses:Food {{amount}} CNY\n',
    starterTemplate,
  );
  expect(sourceIssue(template)).toBe("");
  expect(
    sourceIssue({
      ...template,
      source: '{{date}} * "午餐{{amount}}"\n',
    }),
  ).toContain("独立放置");
  expect(
    sourceIssue({
      ...template,
      source: '{{date}} * "午餐"\n  Expenses:Food {{-amount}} CNY\n',
      fields: {
        ...template.fields,
        amount: { ...template.fields.amount, type: "text" },
      },
    }),
  ).toContain("只有金额字段");
  expect(
    sourceIssue({ ...template, source: '{{date}} * "午餐" {{amount}\n' }),
  ).toContain("格式");
  expect(renderExample(template, "2026-10-01")).toContain(
    '〈交易日期〉 * "午餐"',
  );
  expect(renderExample(template, "2026-10-01")).toContain("〈金额〉");
  expect(
    renderExample(
      {
        ...template,
        fields: {
          ...template.fields,
          date: { ...template.fields.date, mode: "today" },
        },
      },
      "2026-10-01",
    ),
  ).toContain('2026-10-01 * "午餐"');
  expect(templateSummary(template).input.map(({ key }) => key)).toEqual([
    "date",
    "amount",
  ]);
  expect(routeIssues(layout, "lunch", "2026-09-30", "2026-10-01")).toEqual([]);
  const clash: Layout = {
    ...layout,
    routes: {
      ...layout.routes,
      lunch: { ...layout.routes.lunch, target: "a/index.bean" },
    },
  };
  expect(
    routeIssues(clash, "lunch", "2026-09-30", "2026-10-01").join(),
  ).toContain("使用同一文件");
  expect(
    changedRoutes(layout, {
      ...layout,
      routes: {
        ...layout.routes,
        lunch: { ...layout.routes.lunch, label: "午餐2" },
      },
    }),
  ).toEqual(["lunch"]);
  expect(routeLabel("lunch", "午餐")).toBe("午餐");
  expect(routeLabel("lunch")).toBe("lunch");
  expect(routeLabel("ordinary")).toBe("日常与转账");
  expect(pathIssue("con.bean")).toContain("保留名称");
  expect(pathIssue(`a/${"x".repeat(240)}.bean`)).toContain("过长");
  expect(
    fieldIssue({ label: "日期", type: "date", mode: "today", value: "" }),
  ).toBe("");
  expect(
    fieldIssue({ label: "日期", type: "text", mode: "today", value: "" }),
  ).toContain("自动当天");
  expect(
    fieldIssue({
      label: "账户",
      type: "account",
      mode: "fixed",
      value: "Cash",
    }),
  ).toContain("账户");
  expect(
    fieldIssue({
      label: "标签",
      type: "token",
      mode: "input",
      value: "#lunch",
    }),
  ).toBe("");
  expect(
    fieldIssue({
      label: "金额",
      type: "amount",
      mode: "input",
      value: "12.30",
    }),
  ).toBe("");
  expect(sourceIssue({ ...template, source: "   " })).toContain("不能为空");
  expect(
    renderExample({ ...template, source: "{{missing}}" }, "2026-10-01"),
  ).toContain("{{missing}}");
  expect(
    changedRoutes(layout, {
      ...layout,
      routes: { ordinary: layout.routes.ordinary },
    }),
  ).toEqual(["lunch"]);
  const clashIndex: Layout = {
    ...layout,
    routes: {
      ...layout.routes,
      lunch: {
        ...layout.routes.lunch,
        target: "c.bean",
        indexes: ["a/{year}/{month}.bean"],
      },
    },
  };
  expect(
    routeIssues(clashIndex, "lunch", "2026-09-30", "2026-10-01").join(),
  ).toContain("使用同一文件");
  expect(
    routeIssues(
      { ...layout, entry: "b.bean" },
      "lunch",
      "2026-09-30",
      "2026-10-01",
    ).join(),
  ).toContain("账本入口");
  expect(
    routeIssues(
      {
        ...layout,
        routes: {
          ...layout.routes,
          lunch: { target: "c.bean", indexes: ["c.bean"], label: "午餐" },
        },
      },
      "lunch",
      "2026-09-30",
      "2026-10-01",
    ).join(),
  ).toContain("自身索引");
  expect(routeIssues(layout, "unknown", "2026-09-30", "2026-10-01")).toEqual(
    [],
  );
});
