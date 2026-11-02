import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import StockLog from "./StockLog";

it("服务端日志可翻页、筛选、刷新并展开完整字段", async () => {
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
  render(<StockLog products={[{ id: 1, name: "牛奶" }]} />);
  await screen.findByText("已撤销");
  expect(screen.getByRole("cell", { name: "0.12345678" })).toBeInTheDocument();
  fireEvent.click(screen.getByText("完整字段 #5"));
  expect(screen.getByText("Grocy 外部入库")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "下一页日志" }));
  await screen.findByText("完整字段 #4");
  expect(fetcher.mock.calls.at(-1)![0]).toContain("before=5");
  expect(screen.getByRole("button", { name: "下一页日志" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "上一页日志" }));
  await screen.findByText("完整字段 #5");
  fireEvent.change(screen.getByLabelText("日志产品"), {
    target: { value: "1" },
  });
  await waitFor(() =>
    expect(fetcher.mock.calls.at(-1)![0]).toContain("product_id=1"),
  );
  await screen.findByText("完整字段 #5");
  fireEvent.click(screen.getByRole("button", { name: "刷新日志" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(5));
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
  render(<StockLog products={[]} />);
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
  expect(screen.getByText("产品 #2")).toBeInTheDocument();
  expect(screen.getByText("撤销记录")).toBeInTheDocument();
});
