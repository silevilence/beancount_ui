import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
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
        json: async () => ({ layout: defaults, default: defaults }),
      };
    const input = JSON.parse(String(init?.body));
    return {
      ok: true,
      json: async () =>
        url.endsWith("activate")
          ? { enabled: true }
          : {
              token: "preview-token",
              routes: [
                {
                  business: "ordinary",
                  target: input.layout.routes.ordinary.target,
                  chain: [
                    input.layout.entry,
                    ...input.layout.routes.ordinary.indexes,
                    input.layout.routes.ordinary.target,
                  ],
                },
              ],
              diffs: { "index.bean": '+include "new.bean"\n' },
            },
    };
  });
  vi.stubGlobal("fetch", fetcher);
  render(<LayoutDialog onClose={close} onChanged={changed} />);
  return { fetcher, changed, close };
}

it("预览编辑后的业务规则，再明确启用，并刷新账本", async () => {
  const { fetcher, changed, close } = setup();
  const entry = await screen.findByLabelText("账本入口");
  fireEvent.change(entry, { target: { value: "config/book.bean" } });
  fireEvent.change(screen.getByLabelText("日常与转账目标文件"), {
    target: { value: "journal/{year}-{month}.bean" },
  });
  fireEvent.change(screen.getByLabelText("日常与转账索引链"), {
    target: { value: " index.bean\nindexes/{year}.bean\n" },
  });
  fireEvent.change(screen.getByLabelText("话费索引链"), {
    target: { value: "" },
  });
  fireEvent.change(screen.getByLabelText("预览交易日期"), {
    target: { value: "2027-01-02" },
  });
  expect(screen.queryByText("启用此布局")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("检查并预览布局"));
  await screen.findByText("启用此布局");
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
  expect(payload.layout.routes.phone.indexes).toEqual([]);
  expect(payload.day).toBe("2027-01-02");
  fireEvent.click(screen.getByText(/查看 include 示例差异/));
  expect(screen.getByText('+include "new.bean"')).toBeInTheDocument();
  fireEvent.click(screen.getByText("启用此布局"));
  await screen.findByText("布局已启用，历史文件保持原位。");
  expect(changed).toHaveBeenCalledOnce();
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body)).token).toBe(
    "preview-token",
  );
  fireEvent.click(screen.getByText("关闭布局"));
  expect(close).toHaveBeenCalledOnce();
});

it("改动路径、日期或填回默认布局都会使预览失效", async () => {
  setup();
  await screen.findByLabelText("账本入口");
  for (const change of [
    () =>
      fireEvent.change(screen.getByLabelText("工资奖金目标文件"), {
        target: { value: "salary.bean" },
      }),
    () =>
      fireEvent.change(screen.getByLabelText("预览交易日期"), {
        target: { value: "2028-02-03" },
      }),
    () => fireEvent.click(screen.getByText("填入默认 MyBill 布局")),
  ]) {
    fireEvent.click(screen.getByText("检查并预览布局"));
    await screen.findByText("启用此布局");
    change();
    expect(screen.queryByText("启用此布局")).not.toBeInTheDocument();
  }
  expect(screen.getByLabelText("工资奖金目标文件")).toHaveValue(
    defaults.routes.salary.target,
  );
});

it.each(["/api/layout/preview", "/api/layout/activate"])(
  "%s 失败保留输入且不能启用旧预览",
  async (path) => {
    const { changed } = setup(path);
    await screen.findByLabelText("账本入口");
    fireEvent.change(screen.getByLabelText("余额宝收益目标文件"), {
      target: { value: "yield.bean" },
    });
    fireEvent.click(screen.getByText("检查并预览布局"));
    if (path.endsWith("activate"))
      fireEvent.click(await screen.findByText("启用此布局"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "规则冲突，请重新预览",
    );
    expect(screen.getByLabelText("余额宝收益目标文件")).toHaveValue(
      "yield.bean",
    );
    expect(screen.queryByText("启用此布局")).not.toBeInTheDocument();
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
  fireEvent.change(screen.getByLabelText("日常与转账路径日期来源"), {
    target: { value: "write" },
  });
  fireEvent.change(screen.getByLabelText("日常与转账业务名称"), {
    target: { value: "日常" },
  });
  fireEvent.click(screen.getByText("日常记录模板与填写项"));
  fireEvent.click(screen.getByLabelText("日常使用记录模板"));
  fireEvent.change(screen.getByLabelText("新增业务标识"), {
    target: { value: "ordinary" },
  });
  fireEvent.click(screen.getByText("添加业务类型"));
  expect(screen.getByRole("alert")).toHaveTextContent("未使用的业务标识");
  fireEvent.change(screen.getByLabelText("新增业务标识"), {
    target: { value: "lunch" },
  });
  fireEvent.click(screen.getByText("添加业务类型"));
  fireEvent.change(screen.getByLabelText("lunch业务名称"), {
    target: { value: "午餐" },
  });
  fireEvent.change(screen.getByLabelText("lunch记账语义"), {
    target: { value: "phone" },
  });
  fireEvent.change(screen.getByLabelText("午餐目标文件"), {
    target: { value: "meals/{year}/{month}.bean" },
  });
  fireEvent.change(screen.getByLabelText("午餐索引链"), {
    target: { value: "meals/index.bean\nmeals/{year}/index.bean" },
  });
  fireEvent.click(screen.getByText("检查并预览布局"));
  await screen.findByText("启用此布局");
  const input = JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body));
  expect(input.layout.routes.ordinary).toMatchObject({
    date_source: "write",
    label: "日常",
    template: { fields: { amount: { mode: "input" } } },
  });
  expect(input.layout.routes.lunch).toMatchObject({
    kind: "phone",
    target: "meals/{year}/{month}.bean",
  });
  fireEvent.click(screen.getByText("移除 lunch 业务（保留历史记录）"));
  expect(screen.queryByText("启用此布局")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("午餐目标文件")).not.toBeInTheDocument();
});

it("操作进行中阻止关闭和修改，完成后恢复", async () => {
  const { fetcher, close } = setup();
  await screen.findByLabelText("账本入口");
  let release!: (value: unknown) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }) as never,
  );
  fireEvent.click(screen.getByText("检查并预览布局"));
  expect(screen.getByLabelText("账本入口")).toBeDisabled();
  fireEvent(
    screen.getByRole("dialog"),
    new Event("cancel", { bubbles: true, cancelable: true }),
  );
  expect(close).not.toHaveBeenCalled();
  await act(async () =>
    release({ ok: false, json: async () => ({ detail: "请重试" }) }),
  );
  await waitFor(() => expect(screen.getByLabelText("账本入口")).toBeEnabled());
});
