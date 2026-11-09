import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import StockLog from "./StockLog";

it("产品日志可翻页、刷新并展开完整字段，切换产品从首页读取", async () => {
  const fetcher = vi.fn(async (input: string) => {
    const params = new URL(input, "http://local").searchParams;
    return {
      ok: true,
      json: async () => ({
        updated_at: "2026-11-02T03:00:00Z",
        next_before: params.has("before") ? null : 5,
        entries: [
          {
            id: params.has("before") ? 4 : 5,
            product_id: 1,
            amount: "0.12345678",
            transaction_type: "purchase",
            undone: "1",
            note: "Grocy 外部入库",
            transaction_date: "2026-11-01 12:00:00",
          },
        ],
      }),
    };
  });
  vi.stubGlobal("fetch", fetcher);
  const view = render(<StockLog product={{ id: 1, name: "牛奶" }} />);
  await screen.findByText("已撤销");
  expect(fetcher.mock.calls.at(-1)![0]).toContain("product_id=1");
  expect(screen.getByRole("cell", { name: "0.12345678" })).toBeInTheDocument();
  fireEvent.click(screen.getByText("完整字段 #5"));
  expect(screen.getByText("Grocy 外部入库")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "下一页日志" }));
  await screen.findByText("完整字段 #4");
  expect(fetcher.mock.calls.at(-1)![0]).toContain("before=5");
  expect(screen.getByRole("button", { name: "下一页日志" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "上一页日志" }));
  await screen.findByText("完整字段 #5");
  fireEvent.click(screen.getByRole("button", { name: "下一页日志" }));
  await screen.findByText("完整字段 #4");
  fireEvent.click(screen.getByRole("button", { name: "刷新日志" }));
  await screen.findByText("完整字段 #5");
  fireEvent.click(screen.getByRole("button", { name: "下一页日志" }));
  await screen.findByText("完整字段 #4");
  view.rerender(<StockLog product={{ id: 2, name: "面包" }} />);
  await waitFor(() =>
    expect(fetcher.mock.calls.at(-1)![0]).toContain("product_id=2"),
  );
  expect(fetcher.mock.calls.at(-1)![0]).not.toContain("before=");
  expect(screen.getByRole("button", { name: "上一页日志" })).toBeDisabled();
  await screen.findByText("完整字段 #5");
  const calls = fetcher.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "刷新日志" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(calls + 1));
});

it("日志错误可重试，空结果与未知动作仍可查看", async () => {
  let ok = false;
  let entries: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      json: async () =>
        ok
          ? { entries, next_before: null, updated_at: "2026-11-02T03:00:00Z" }
          : { detail: "服务端无法连接" },
    })),
  );
  render(<StockLog product={{ id: 2, name: "面包" }} />);
  await screen.findByText("服务端无法连接");
  ok = true;
  fireEvent.click(screen.getByRole("button", { name: "刷新日志" }));
  await screen.findByText("没有符合条件的库存日志。");
  entries = [
    {
      id: 1,
      product_id: 2,
      transaction_type: "custom-action",
      undo_stock_id: "4",
      extra: { a: "b" },
    },
  ];
  fireEvent.click(screen.getByRole("button", { name: "刷新日志" }));
  await screen.findByRole("cell", { name: "custom-action" });
  expect(
    screen.getByRole("heading", { name: "面包 · 库存日志" }),
  ).toBeInTheDocument();
  expect(screen.getByText("撤销记录")).toBeInTheDocument();
});
