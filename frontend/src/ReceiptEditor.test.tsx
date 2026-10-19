import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import ReceiptEditor from "./ReceiptEditor";
import type { ManagedOrder } from "./OrderPage";
import type { Journal } from "./api";

it("已付款商品收货先预览，取消不写入，确认不调用账务提交", async () => {
  const order = {
    id: "one",
    source: { mode: "paid", unpaid: "0" },
    items: [
      {
        id: "item",
        name: "食品",
        remaining: "2",
        unit: "件",
        product_id: null,
      },
    ],
    source_changed: false,
  } as unknown as ManagedOrder;
  const calls: string[] = [];
  const result = {
    request_id: "r",
    received_date: "2026-10-19",
    receipt_saved: false,
    financial: null,
    settlement_status: "none",
    actions: [{ name: "食品", quantity: "2", unit: "件", product_id: null }],
    operations: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      calls.push(path);
      return {
        ok: true,
        json: async () => ({
          ...result,
          receipt_saved: path.endsWith("commit"),
        }),
      };
    }),
  );
  render(
    <ReceiptEditor
      order={order}
      journal={{ identity: "test", accounts: [] } as unknown as Journal}
      onChanged={async () => {}}
    />,
  );
  fireEvent.click(screen.getByText("预览本次收货"));
  expect(
    await screen.findByText("本次不新增 Beancount 账务记录。"),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByText("取消收货预览"));
  expect(calls.some((p) => p.endsWith("commit"))).toBe(false);
  fireEvent.click(screen.getByText("预览本次收货"));
  fireEvent.click(await screen.findByText("确认收货并执行预览动作"));
  expect(await screen.findByText(/实物收货已保存/)).toBeInTheDocument();
  expect(calls.filter((p) => p.endsWith("commit"))).toEqual([
    "/api/fulfillment/receipt/commit",
  ]);
});

it("分批收货过滤未到货商品，结算失败保留原请求，恢复不重复创建", async () => {
  const order = {
    id: "deferred",
    source: { mode: "deferred", unpaid: "120" },
    items: [
      {
        id: "a",
        name: "水",
        remaining: "2",
        unit: "箱",
        product_id: 1,
        factor: "12",
        stock_unit: "瓶",
        currency: "CNY",
        unit_price: "5",
        default_location_id: 1,
      },
      { id: "b", name: "茶", remaining: "1", unit: "袋", product_id: null },
    ],
    source_changed: false,
  } as unknown as ManagedOrder;
  const preview = {
    request_id: "original",
    received_date: "2026-10-19",
    receipt_saved: false,
    settlement_status: "pending",
    actions: [
      {
        name: "水",
        quantity: "1",
        unit: "箱",
        product_id: 1,
        stock_amount: "12",
        unit_price: "5",
        currency: "CNY",
        location_id: 2,
        best_before_date: "2027-01-01",
      },
    ],
    financial: {
      items: [{ raw: '2026-10-19 * "付款"\n' }],
      diffs: { "test.bean": "+付款" },
    },
    operations: [],
  };
  let commits = 0;
  const fetch = vi.fn(async (path: string, init?: RequestInit) => ({
    ok: true,
    json: async () =>
      path.endsWith("commit")
        ? {
            ...preview,
            receipt_saved: true,
            settlement_status: ++commits === 1 ? "needs_review" : "done",
            settlement_error: "账本发生变化",
          }
        : preview,
  }));
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(
    <ReceiptEditor
      order={order}
      journal={
        {
          identity: "receipt-test",
          accounts: [{ name: "Assets:Cash" }, { name: "Expenses:Food" }],
        } as unknown as Journal
      }
      onChanged={async () => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("实际到货日期"), {
    target: { value: "2026-10-19" },
  });
  fireEvent.change(screen.getByLabelText("水 · 本次实收（箱）"), {
    target: { value: "1" },
  });
  fireEvent.change(screen.getByLabelText("茶 · 本次实收（袋）"), {
    target: { value: "0" },
  });
  fireEvent.change(screen.getByLabelText("入库位置 ID"), {
    target: { value: "2" },
  });
  fireEvent.change(screen.getByLabelText("保质期日期"), {
    target: { value: "2027-01-01" },
  });
  fireEvent.change(screen.getByLabelText("每瓶价格（CNY）"), {
    target: { value: "5" },
  });
  fireEvent.click(screen.getByLabelText("同时结算待付款金额"));
  fireEvent.change(screen.getByLabelText("结算日期"), {
    target: { value: "2026-10-19" },
  });
  fireEvent.change(screen.getByLabelText("结算金额"), {
    target: { value: "60" },
  });
  fireEvent.change(screen.getByLabelText("结算付款账户"), {
    target: { value: "Assets:Cash" },
  });
  fireEvent.click(screen.getByText("预览本次收货"));
  fireEvent.click(await screen.findByText("确认收货并执行预览动作"));
  await screen.findByText(/结算需要核对：账本发生变化/);
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
    lines: [{ item_id: "a", quantity: "1", location_id: 2 }],
    settlement: { amount: "60", account: "Assets:Cash" },
  });
  expect(screen.queryByText("取消收货预览")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("恢复收货预览"));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  fireEvent.click(screen.getByText("恢复原收货请求"));
  expect(await screen.findByText(/结算已保存/)).toBeInTheDocument();
  expect(
    fetch.mock.calls
      .filter((c) => c[0].endsWith("commit"))
      .map((c) => JSON.parse(String(c[1]?.body))),
  ).toEqual([{ request_id: "original" }, { request_id: "original" }]);
});
it("预览超时可恢复或取消，损坏的浏览器缓存不阻止重新录入", async () => {
  localStorage.setItem("beancount-ui.receipt.test.invalid", "{");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ detail: "预览暂不可用" }),
    })),
  );
  render(
    <ReceiptEditor
      order={
        {
          id: "invalid",
          source: { mode: "paid", unpaid: "0" },
          items: [{ id: "a", name: "食品", remaining: "1", unit: "份" }],
        } as unknown as ManagedOrder
      }
      journal={{ identity: "test", accounts: [] } as unknown as Journal}
      onChanged={async () => {}}
    />,
  );
  fireEvent.click(screen.getByText("预览本次收货"));
  await screen.findByText("预览暂不可用");
  fireEvent.click(screen.getByText("恢复收货预览"));
  await screen.findByText("预览暂不可用");
  fireEvent.click(screen.getByText("取消收货预览"));
  expect(screen.getByText("预览本次收货")).toBeInTheDocument();
});

it("保留实收并结束旧结算后恢复剩余收货表单", async () => {
  const key = "beancount-ui.receipt.close-finance.order";
  const preview = {
    request_id: "receipt",
    financial: { items: [], diffs: {} },
    actions: [],
    operations: [],
    receipt_saved: true,
    settlement_status: "needs_review",
  };
  localStorage.setItem(
    key,
    JSON.stringify({ body: {}, preview, uncertain: true }),
  );
  const fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ ...preview, settlement_status: "abandoned" }),
  }));
  vi.stubGlobal("fetch", fetch);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(
    <ReceiptEditor
      order={
        {
          id: "order",
          source: { mode: "deferred", unpaid: "10" },
          items: [{ id: "i", name: "水", remaining: "1", unit: "瓶" }],
        } as unknown as ManagedOrder
      }
      journal={
        { identity: "close-finance", accounts: [] } as unknown as Journal
      }
      onChanged={async () => {}}
    />,
  );
  fireEvent.click(screen.getByText("保留收货并结束原结算请求"));
  expect(fetch).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.getByText("保留收货并结束原结算请求")).toBeEnabled(),
  );
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByText("保留收货并结束原结算请求"));
  expect(await screen.findByText(/已停止原结算重试/)).toBeInTheDocument();
  expect(localStorage.getItem(key)).toBeNull();
  expect(screen.getByText("预览本次收货")).toBeInTheDocument();
});
