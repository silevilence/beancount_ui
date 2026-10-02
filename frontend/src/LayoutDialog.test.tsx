import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import LayoutDialog, { type Layout } from "./LayoutDialog";

const defaults: Layout = {
  entry: "main.beancount",
  routes: {
    ordinary: { target: "txs/{year}/{month}.bean", indexes: ["index.bean"] },
    yuebao: { target: "txs/category/yuebao.bean", indexes: ["index.bean"] },
    salary: { target: "txs/category/salary.bean", indexes: ["index.bean"] },
    phone: { target: "txs/category/phone.bean", indexes: ["index.bean"] },
    balance: { target: "txs/category/balance.bean", indexes: ["index.bean"] },
  },
};
const ledgerFiles = ["main.beancount", "index.bean", "txs/2026/09.bean"];

function setup(fail = "") {
  const changed = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === fail)
      return {
        ok: false,
        status: 409,
        json: async () => ({ detail: "规则冲突，请重新预览" }),
      };
    if (url === "/api/layout")
      return {
        ok: true,
        json: async () => ({
          layout: defaults,
          default: defaults,
          version: "config-1",
          write_day: "2026-10-01",
        }),
      };
    if (url === "/api/ledger")
      return {
        ok: true,
        json: async () => ({ files: ledgerFiles, include_graph: {} }),
      };
    const input = JSON.parse(String(init?.body));
    return {
      ok: true,
      json: async () =>
        url.endsWith("activate")
          ? { enabled: true }
          : {
              token: "preview-token",
              write_day: "2026-10-01",
              files: [...ledgerFiles, "journal/2027-01.bean"],
              routes: Object.keys(input.layout.routes).map((business) => ({
                business,
                target: input.layout.routes[business].target,
                chain: [
                  input.layout.entry,
                  ...input.layout.routes[business].indexes,
                  input.layout.routes[business].target,
                ],
              })),
              diffs: { "journal/2027-01.bean": '+include "new.bean"\n' },
            },
    };
  });
  vi.stubGlobal("fetch", fetcher);
  render(<LayoutDialog onClose={close} onChanged={changed} />);
  return { fetcher, changed, close };
}

const rail = () => within(screen.getByRole("navigation", { name: "业务列表" }));
const detail = () => within(screen.getByRole("region", { name: "业务配置" }));

it("无模板业务展示收入表单或余额原文的实际录入方式", async () => {
  setup();
  await screen.findByLabelText("账本入口");
  expect(screen.getAllByText("收入表单")).toHaveLength(2);
  expect(screen.getByText("原文输入")).toBeInTheDocument();
  fireEvent.click(rail().getByRole("button", { name: /余额宝收益/ }));
  expect(detail().getByText("收入表单")).toBeInTheDocument();
  expect(screen.getByText(/未启用时使用收入表单/)).toBeInTheDocument();
  fireEvent.click(rail().getByRole("button", { name: /余额断言/ }));
  expect(detail().getByText("原文输入")).toBeInTheDocument();
  expect(screen.getByText(/未启用时使用原文输入/)).toBeInTheDocument();
});

it("overview 业务可编辑模板并移除，与概览页相互独立", async () => {
  setup();
  await screen.findByLabelText("账本入口");
  fireEvent.change(screen.getByLabelText("新增业务标识"), {
    target: { value: "overview" },
  });
  fireEvent.click(screen.getByRole("button", { name: "添加业务" }));
  expect(screen.getByLabelText("目标文件")).toHaveValue(
    "business/overview.bean",
  );
  fireEvent.click(screen.getByLabelText("overview使用记录模板"));
  expect(screen.getByLabelText("overview原文模板")).toBeInTheDocument();
  fireEvent.click(rail().getByRole("button", { name: /概览与入口/ }));
  expect(screen.getByLabelText("账本入口")).toBeInTheDocument();
  fireEvent.click(rail().getByRole("button", { name: /overview/ }));
  expect(screen.getByLabelText("overview原文模板")).toBeInTheDocument();
  fireEvent.click(detail().getByRole("button", { name: /移除「overview」/ }));
  fireEvent.click(detail().getByRole("button", { name: "确认移除" }));
  expect(
    rail().queryByRole("button", { name: /overview/ }),
  ).not.toBeInTheDocument();
  expect(screen.getByLabelText("账本入口")).toBeInTheDocument();
});

it("在业务列表中选择业务，预览编辑后的规则，再明确启用并刷新账本", async () => {
  const { fetcher, changed, close } = setup();
  await screen.findByLabelText("账本入口");
  expect(
    rail().getByRole("button", { name: /日常与转账/ }),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("账本入口"), {
    target: { value: "config/book.bean" },
  });
  fireEvent.click(rail().getByRole("button", { name: /日常与转账/ }));
  fireEvent.change(screen.getByLabelText("目标文件"), {
    target: { value: "journal/{year}-{month}.bean" },
  });
  fireEvent.change(screen.getByLabelText("索引链"), {
    target: { value: " index.bean\nindexes/{year}.bean\n" },
  });
  fireEvent.change(screen.getByLabelText("预览交易日期"), {
    target: { value: "2027-01-02" },
  });
  expect(screen.getByText("有未预览的修改")).toBeInTheDocument();
  fireEvent.click(screen.getByText("启用此布局"));
  expect(changed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("检查并预览布局"));
  await screen.findByText("布局预览 · 已校验");
  expect(screen.getByText("预览有效 · ", { exact: false })).toBeInTheDocument();
  expect(detail().getByText("config/book.bean")).toBeInTheDocument();
  expect(
    screen.getByText(
      "config/book.bean → index.bean → indexes/{year}.bean → journal/{year}-{month}.bean",
    ),
  ).toBeInTheDocument();
  const payload = JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body));
  expect(payload.layout.routes.ordinary.indexes).toEqual([
    "index.bean",
    "indexes/{year}.bean",
  ]);
  expect(payload.day).toBe("2027-01-02");
  fireEvent.click(screen.getByText(/查看 include 示例差异/));
  expect(screen.getByText('+include "new.bean"')).toBeInTheDocument();
  expect(screen.getByText(/journal\/2027-01.bean（新建）/)).toBeInTheDocument();
  fireEvent.click(screen.getByText("启用此布局"));
  await screen.findByText("布局已启用，历史文件保持原位。");
  expect(screen.getByText("已启用，可继续调整后重新预览")).toBeInTheDocument();
  expect(changed).toHaveBeenCalledOnce();
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body)).token).toBe(
    "preview-token",
  );
  fireEvent.click(screen.getByText("关闭布局"));
  expect(close).toHaveBeenCalledOnce();
});

it("业务列表标记已有/新建文件、写入日期与待修正项", async () => {
  setup();
  await screen.findByLabelText("账本入口");
  fireEvent.change(screen.getByLabelText("预览交易日期"), {
    target: { value: "2026-10-01" },
  });
  fireEvent.click(rail().getByRole("button", { name: /日常与转账/ }));
  const chain = detail().getByRole("group", { name: "包含链预览" });
  expect(within(chain).getByText("main.beancount")).toBeInTheDocument();
  expect(within(chain).getAllByText("已有")).toHaveLength(2);
  expect(within(chain).getByText("新建")).toBeInTheDocument();
  fireEvent.click(detail().getByRole("button", { name: "实际写入日期" }));
  expect(
    detail().getByText(/补记历史日期时写入服务器当天 2026-10-01/),
  ).toBeInTheDocument();
  expect(rail().getAllByText("写入日期").length).toBeGreaterThan(0);
  fireEvent.change(screen.getByLabelText("索引链"), {
    target: { value: "index.bean\n" },
  });
  expect(detail().queryByText(/待修正/)).not.toBeInTheDocument();
  const steps = within(
    detail().getByRole("group", { name: "包含链预览" }),
  ).getAllByRole("code");
  expect(steps).toHaveLength(3);
  expect(steps.map((step) => step.textContent)).toEqual([
    "main.beancount",
    "index.bean",
    "txs/2026/10.bean",
  ]);
  fireEvent.click(rail().getByRole("button", { name: /工资奖金/ }));
  expect(detail().getByText("工资奖金", { selector: ".chip" })).toBeVisible();
  fireEvent.click(rail().getByRole("button", { name: /日常与转账/ }));
  fireEvent.change(screen.getByLabelText("目标文件"), {
    target: { value: "txs/category/yuebao.bean" },
  });
  expect(
    detail().getByText(/目标文件与「余额宝收益」使用同一文件/),
  ).toBeInTheDocument();
  expect(rail().getAllByText("1 项待修正")).toHaveLength(2);
});

it("改动路径或预览日期都会使预览失效，启用按钮保持可见但不可用", async () => {
  setup();
  await screen.findByLabelText("账本入口");
  fireEvent.click(rail().getByRole("button", { name: /工资奖金/ }));
  fireEvent.change(screen.getByLabelText("目标文件"), {
    target: { value: "salary.bean" },
  });
  fireEvent.click(screen.getByText("检查并预览布局"));
  await screen.findByText("布局预览 · 已校验");
  expect(screen.getByText("启用此布局")).toBeEnabled();
  fireEvent.change(screen.getByLabelText("预览交易日期"), {
    target: { value: "2028-02-03" },
  });
  expect(screen.getByText("启用此布局")).toBeDisabled();
  expect(screen.queryByText("布局预览 · 已校验")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("检查并预览布局"));
  await screen.findByText("布局预览 · 已校验");
  const previewPanel = within(screen.getByRole("region", { name: "布局预览" }));
  fireEvent.click(previewPanel.getByRole("button", { name: /工资奖金/ }));
  expect(screen.getByLabelText("目标文件")).toHaveValue("salary.bean");
  fireEvent.click(screen.getByText("取消预览"));
  expect(screen.queryByText("布局预览 · 已校验")).not.toBeInTheDocument();
  expect(screen.getByText("有未预览的修改")).toBeInTheDocument();
  fireEvent.click(screen.getByText("检查并预览布局"));
  await screen.findByText("布局预览 · 已校验");
  fireEvent.click(rail().getByRole("button", { name: /概览与入口/ }));
  fireEvent.click(screen.getByText("还原为当前生效配置"));
  fireEvent.click(screen.getByText("确认还原"));
  expect(screen.getByText("启用此布局")).toBeDisabled();
  fireEvent.click(rail().getByRole("button", { name: /工资奖金/ }));
  expect(screen.getByLabelText("目标文件")).toHaveValue(
    defaults.routes.salary.target,
  );
});

it.each(["/api/layout/preview", "/api/layout/activate"])(
  "%s 失败保留输入且不能启用旧预览",
  async (path) => {
    const { changed } = setup(path);
    await screen.findByLabelText("账本入口");
    fireEvent.click(rail().getByRole("button", { name: /余额宝收益/ }));
    fireEvent.change(screen.getByLabelText("目标文件"), {
      target: { value: "yield.bean" },
    });
    fireEvent.click(screen.getByText("检查并预览布局"));
    if (path.endsWith("activate")) {
      await screen.findByText("布局预览 · 已校验");
      fireEvent.click(screen.getByText("启用此布局"));
    }
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "规则冲突，请重新预览",
    );
    expect(screen.getByLabelText("目标文件")).toHaveValue("yield.bean");
    expect(screen.getByText("启用此布局")).toBeDisabled();
    expect(changed).not.toHaveBeenCalled();
  },
);

it("读取配置失败仍可关闭对话框", async () => {
  const { close } = setup("/api/layout");
  expect(await screen.findByRole("alert")).toHaveTextContent("规则冲突");
  fireEvent(
    screen.getByRole("dialog"),
    new Event("cancel", { bubbles: true, cancelable: true }),
  );
  expect(close).toHaveBeenCalledOnce();
});

it("配置写入日期、模板字段和自定义业务，再预览完整配置", async () => {
  const { fetcher } = setup();
  await screen.findByLabelText("账本入口");
  fireEvent.click(rail().getByRole("button", { name: /日常与转账/ }));
  fireEvent.change(screen.getByLabelText("业务名称"), {
    target: { value: "日常" },
  });
  fireEvent.click(detail().getByRole("button", { name: "实际写入日期" }));
  fireEvent.click(screen.getByLabelText("日常使用记录模板"));
  fireEvent.change(screen.getByLabelText("日常原文模板"), {
    target: { value: '{{date}} * "午餐"\n  Expenses:Food {{amount}} CNY\n' },
  });
  expect(screen.getByLabelText("日常填写示意")).toHaveTextContent(
    "〈交易日期〉",
  );
  fireEvent.click(screen.getByText("清除模板"));
  expect(screen.getByText("恢复上次模板")).toBeInTheDocument();
  fireEvent.click(rail().getByRole("button", { name: /话费/ }));
  expect(screen.queryByText("恢复上次模板")).not.toBeInTheDocument();
  fireEvent.click(rail().getByRole("button", { name: /日常/ }));
  fireEvent.click(screen.getByLabelText("日常使用记录模板"));
  expect(screen.getByLabelText("日常原文模板")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("新增业务标识"), {
    target: { value: "ordinary" },
  });
  fireEvent.click(screen.getByText("添加业务"));
  expect(rail().getByText(/请输入未使用的业务标识/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("新增业务标识"), {
    target: { value: "lunch" },
  });
  fireEvent.click(screen.getByText("添加业务"));
  expect(screen.getByLabelText("业务名称")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("业务名称"), {
    target: { value: "午餐" },
  });
  fireEvent.change(screen.getByLabelText("记账语义"), {
    target: { value: "phone" },
  });
  fireEvent.change(screen.getByLabelText("目标文件"), {
    target: { value: "meals/{year}/{month}.bean" },
  });
  fireEvent.change(screen.getByLabelText("索引链"), {
    target: { value: "meals/index.bean\nmeals/{year}/index.bean" },
  });
  fireEvent.click(screen.getByText("检查并预览布局"));
  await screen.findByText("布局预览 · 已校验");
  const input = JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body));
  expect(input.layout.routes.ordinary).toMatchObject({
    date_source: "write",
    label: "日常",
    template: { fields: { amount: { mode: "input" } } },
  });
  expect(input.layout.routes.lunch).toMatchObject({
    kind: "phone",
    target: "meals/{year}/{month}.bean",
    indexes: ["meals/index.bean", "meals/{year}/index.bean"],
  });
  fireEvent.click(detail().getByRole("button", { name: /移除「午餐」/ }));
  expect(detail().getByText(/历史记录与旧文件保持原位/)).toBeInTheDocument();
  fireEvent.click(detail().getByRole("button", { name: "保留" }));
  expect(screen.getByLabelText("业务名称")).toHaveValue("午餐");
  fireEvent.click(detail().getByRole("button", { name: /移除「午餐」/ }));
  fireEvent.click(detail().getByRole("button", { name: "确认移除" }));
  expect(screen.queryByLabelText("目标文件")).not.toBeInTheDocument();
  expect(screen.queryByText("布局预览 · 已校验")).not.toBeInTheDocument();
  const last = JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body));
  expect(last.day).toBeTruthy();
  fireEvent.click(screen.getByText("检查并预览布局"));
  await screen.findByText("布局预览 · 已校验");
  const final = JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body));
  expect(final.layout.routes.lunch).toBeUndefined();
});

it("未启用的修改在关闭前需要确认", async () => {
  const { close } = setup();
  await screen.findByLabelText("账本入口");
  fireEvent.click(screen.getByText("关闭布局"));
  expect(close).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByLabelText("账本入口"), {
    target: { value: "config/book.bean" },
  });
  expect(screen.getByText("入口 项修改待启用")).toBeInTheDocument();
  fireEvent.click(screen.getByText("关闭布局"));
  expect(close).toHaveBeenCalledOnce();
  expect(
    screen.getByText("有 1 项未启用的修改，关闭后会被丢弃。"),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByText("继续编辑"));
  expect(screen.getByLabelText("账本入口")).toHaveValue("config/book.bean");
  fireEvent.click(screen.getByText("关闭布局"));
  fireEvent.click(screen.getByText("放弃修改并关闭"));
  expect(close).toHaveBeenCalledTimes(2);
});

it("概览可以改入口、填入默认布局并标记待修正业务", async () => {
  setup();
  await screen.findByLabelText("账本入口");
  fireEvent.change(screen.getByLabelText("账本入口"), {
    target: { value: "config/book.bean" },
  });
  const table = detail().getByRole("table");
  expect(
    within(table).getByRole("button", { name: "日常与转账" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByText("填入默认 MyBill 布局"));
  expect(
    screen.getByText(/默认 MyBill 布局会替换当前编辑内容/),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByText("确认填入"));
  expect(screen.getByLabelText("账本入口")).toHaveValue("main.beancount");
  expect(screen.getByText("当前编辑与生效配置一致")).toBeInTheDocument();
  fireEvent.click(rail().getByRole("button", { name: /话费/ }));
  fireEvent.change(screen.getByLabelText("目标文件"), {
    target: { value: "" },
  });
  fireEvent.click(rail().getByRole("button", { name: /概览与入口/ }));
  expect(screen.getByText(/以下业务需要修正/)).toBeInTheDocument();
  expect(screen.getByLabelText("账本入口")).toHaveValue(defaults.entry);
  const listed = screen.getAllByRole("button", { name: "话费" });
  fireEvent.click(listed.at(-1)!);
  expect(screen.getByLabelText("目标文件")).toHaveValue("");
});

it("自定义业务使用内置表单，且已启用业务的记账语义不可更改", async () => {
  const layout: Layout = {
    ...defaults,
    routes: {
      ...defaults.routes,
      lunch: {
        target: "business/lunch.bean",
        indexes: [],
        kind: "phone",
        label: "午餐",
      },
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/ledger"
        ? { ok: true, json: async () => ({ files: ledgerFiles }) }
        : {
            ok: true,
            json: async () => ({
              layout,
              default: defaults,
              write_day: "2026-10-01",
            }),
          },
    ),
  );
  render(<LayoutDialog onClose={vi.fn()} onChanged={vi.fn(async () => {})} />);
  await screen.findByLabelText("账本入口");
  fireEvent.click(rail().getByRole("button", { name: /午餐/ }));
  expect(screen.getByLabelText("记账语义")).toBeDisabled();
  expect(detail().getByText(/需要新语义请另建业务标识/)).toBeInTheDocument();
  expect(
    detail().getByText("记录模板", { selector: ".template-head h4" }),
  ).toBeInTheDocument();
});

it("操作进行中阻止关闭和修改，完成后恢复", async () => {
  const { fetcher, close } = setup();
  await screen.findByLabelText("账本入口");
  const pending = Promise.withResolvers<unknown>();
  fetcher.mockImplementationOnce(() => pending.promise as never);
  fireEvent.click(screen.getByText("检查并预览布局"));
  expect(screen.getByText("正在与服务器核对…")).toBeInTheDocument();
  expect(screen.getByText("关闭布局")).toBeDisabled();
  expect(screen.getByText("检查并预览布局")).toBeDisabled();
  expect(screen.getByLabelText("账本入口")).toBeDisabled();
  expect(rail().getByRole("button", { name: /余额宝收益/ })).toBeDisabled();
  fireEvent(
    screen.getByRole("dialog"),
    new Event("cancel", { bubbles: true, cancelable: true }),
  );
  expect(close).not.toHaveBeenCalled();
  await act(async () => {
    pending.resolve({ ok: false, json: async () => ({ detail: "请重试" }) });
  });
  await waitFor(() => expect(screen.getByText("检查并预览布局")).toBeEnabled());
  expect(screen.getByLabelText("账本入口")).toBeEnabled();
});

it("请求期间改动预览日期会丢弃过期结果", async () => {
  const { fetcher } = setup();
  await screen.findByLabelText("账本入口");
  const pending = Promise.withResolvers<unknown>();
  fetcher.mockImplementationOnce(() => pending.promise as never);
  fireEvent.click(screen.getByText("检查并预览布局"));
  fireEvent.change(screen.getByLabelText("预览交易日期"), {
    target: { value: "2027-03-04" },
  });
  await act(async () => {
    pending.resolve({
      ok: true,
      json: async () => ({
        token: "preview-token",
        routes: [],
        diffs: { "index.bean": '+include "old.bean"\n' },
      }),
    });
  });
  expect(screen.queryByText("布局预览 · 已校验")).not.toBeInTheDocument();
  expect(
    await screen.findByText("预览期间有新的修改，请重新预览。"),
  ).toBeInTheDocument();
  expect(screen.getByText("启用此布局")).toBeDisabled();
});
