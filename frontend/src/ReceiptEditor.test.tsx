import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import ReceiptEditor from "./ReceiptEditor";
import type { ManagedOrder } from "./OrderPage";
import type { Journal } from "./api";
import { expiryDate } from "./receiptDraft";

it("产品默认到期日随到货日期重算，手填日期保留，位置显示名称", async () => {
  const onStage = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        instance_id: "grocy",
        default_best_before_days: 90,
        default_location_id: 1,
        products: [{ id: 1, location_id: 2, default_best_before_days: 7 }],
        locations: [
          { id: 1, name: "厨房" },
          { id: 2, name: "储物间" },
        ],
      }),
    })),
  );
  render(
    <ReceiptEditor
      order={
        {
          id: "defaults",
          source: { mode: "paid", unpaid: "0" },
          items: [
            {
              id: "water",
              name: "水",
              remaining: "2",
              unit: "箱",
              product_id: 1,
              instance_id: "grocy",
              default_best_before_days: 3,
              default_location_id: 1,
              stock_unit: "瓶",
              factor: "12",
              unit_price: "5",
              currency: "CNY",
            },
          ],
        } as unknown as ManagedOrder
      }
      journal={{ identity: "defaults", accounts: [] } as unknown as Journal}
      onChanged={async () => {}}
      onStage={onStage}
    />,
  );
  await screen.findByRole("option", { name: "储物间" });
  await waitFor(() =>
    expect(screen.getByLabelText("入库位置")).toHaveValue("2"),
  );
  fireEvent.change(screen.getByLabelText("实际到货日期"), {
    target: { value: "2026-10-25" },
  });
  expect(screen.getByLabelText("保质期日期")).toHaveValue("2026-11-01");
  fireEvent.change(screen.getByLabelText("实际到货日期"), {
    target: { value: "2026-10-26" },
  });
  expect(screen.getByLabelText("保质期日期")).toHaveValue("2026-11-02");
  fireEvent.change(screen.getByLabelText("保质期日期"), {
    target: { value: "2027-01-01" },
  });
  fireEvent.change(screen.getByLabelText("实际到货日期"), {
    target: { value: "2026-10-27" },
  });
  expect(screen.getByLabelText("保质期日期")).toHaveValue("2027-01-01");
  fireEvent.click(screen.getByText("加入批量收货"));
  await waitFor(() => expect(onStage).toHaveBeenCalledOnce());
  expect(onStage.mock.calls[0][0].body.lines[0]).toMatchObject({
    location_id: 2,
    best_before_date: "2027-01-01",
  });
  expect(expiryDate("2026-10-25", 0)).toBe("2026-10-25");
  expect(expiryDate("2026-10-25", -1)).toBe("2999-12-31");
});

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
    operations: [{ id: "receipt-op", status: "unknown", error: "" }],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      calls.push(path);
      return {
        ok: true,
        json: async () =>
          path.endsWith("/resolve")
            ? {
                id: "receipt-op",
                status: "resolved",
                error: "",
              }
            : {
                ...result,
                receipt_saved: path.endsWith("commit"),
              },
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
  fireEvent.click(screen.getByText("预览收货与入库"));
  expect(
    await screen.findByText("本次不新增 Beancount 账务记录。"),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByText("取消收货预览"));
  expect(calls.some((p) => p.endsWith("commit"))).toBe(false);
  fireEvent.click(screen.getByText("预览收货与入库"));
  fireEvent.click(
    await screen.findByRole("button", { name: "确认收货并入库" }),
  );
  expect(await screen.findByText(/实物收货已保存/)).toBeInTheDocument();
  expect(calls.filter((p) => p.endsWith("commit"))).toEqual([
    "/api/fulfillment/receipt/commit",
  ]);
  vi.spyOn(window, "prompt").mockReturnValue(
    "已人工核实收货日志与批次并确认原执行停止",
  );
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(screen.getByText("记录人工核实成功"));
  expect(await screen.findByText("已人工核实")).toBeInTheDocument();
  expect(screen.queryByText("结果待确认")).not.toBeInTheDocument();
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
        instance_id: "grocy",
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
            receipt_saved: commits > 0,
            settlement_status: ++commits === 1 ? "needs_review" : "done",
            settlement_error: "账本发生变化",
          }
        : path.endsWith("/options")
          ? {
              instance_id: "grocy",
              locations: [
                { id: 1, name: "厨房" },
                { id: 2, name: "储物间" },
              ],
              products: [
                { id: 1, location_id: 1, default_best_before_days: 7 },
              ],
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
  await screen.findByRole("option", { name: "储物间" });
  fireEvent.change(screen.getByLabelText("入库位置"), {
    target: { value: "2" },
  });
  fireEvent.change(screen.getByLabelText("保质期日期"), {
    target: { value: "2027-01-01" },
  });
  fireEvent.change(screen.getByLabelText("每瓶价格（CNY）"), {
    target: { value: "5" },
  });
  expect(screen.queryByLabelText("同时结算待付款金额")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("账单日期"), {
    target: { value: "2026-10-19" },
  });
  fireEvent.change(screen.getByLabelText("账单金额"), {
    target: { value: "60" },
  });
  fireEvent.change(screen.getByLabelText("账单账户"), {
    target: { value: "Assets:Cash" },
  });
  fireEvent.click(screen.getByText("预览收货与入库"));
  fireEvent.click(await screen.findByText("确认收货：记账并入库"));
  await screen.findByText(/账单未保存，已暂停入库：账本发生变化/);
  expect(
    JSON.parse(
      String(
        fetch.mock.calls.find((c) => c[0].endsWith("/preview"))?.[1]?.body,
      ),
    ),
  ).toMatchObject({
    lines: [{ item_id: "a", quantity: "1", location_id: 2 }],
    settlement: { amount: "60", account: "Assets:Cash" },
  });
  expect(screen.queryByText("取消收货预览")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("恢复收货预览"));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
  fireEvent.click(screen.getByText("恢复原收货请求"));
  expect(await screen.findByText(/账单已保存/)).toBeInTheDocument();
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
  fireEvent.click(screen.getByText("预览收货与入库"));
  await screen.findByText("预览暂不可用");
  fireEvent.click(screen.getByText("恢复收货预览"));
  await screen.findByText("预览暂不可用");
  fireEvent.click(screen.getByText("取消收货预览"));
  expect(screen.getByText("预览收货与入库")).toBeInTheDocument();
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
  fireEvent.click(screen.getByText("核对并重新填写账单"));
  expect(fetch).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.getByText("核对并重新填写账单")).toBeEnabled(),
  );
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByText("核对并重新填写账单"));
  expect(await screen.findByText(/原账单请求已结束/)).toBeInTheDocument();
  expect(localStorage.getItem(key)).toBeNull();
  expect(screen.getByText("预览收货与入库")).toBeInTheDocument();
});
