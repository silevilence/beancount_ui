import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import OrderCorrections from "./OrderCorrections";
import type { ManagedOrder } from "./OrderPage";

it("取消剩余只提交显式更正，不触发退款", async () => {
  const fetch = vi.fn(async (_path: string) => ({
    ok: true,
    json: async () => ({ message: "更正已记录" }),
  }));
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const order = {
    id: "cancel-test",
    source: { currency: "CNY" },
    items: [{ id: "item", name: "牛奶", remaining: "2", unit: "瓶" }],
    receipts: [],
  } as unknown as ManagedOrder;
  render(<OrderCorrections order={order} onChanged={async () => {}} />);
  fireEvent.change(screen.getByLabelText("商品"), {
    target: { value: "item" },
  });
  fireEvent.change(screen.getByLabelText("更正／核对依据"), {
    target: { value: "未发货取消剩余" },
  });
  fireEvent.click(screen.getByText("确认所选更正"));
  expect(await screen.findByText("更正已记录")).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/fulfillment/corrections");
});

it("作废实收前必须核对，失败保留原请求与历史", async () => {
  let fail = true;
  const fetch = vi.fn(async (path: string, _init?: RequestInit) => ({
    ok: !fail || path.includes("inspect"),
    status: 503,
    json: async () =>
      path.includes("inspect")
        ? { operations: [], guidance: "批次已有消耗，需要人工核对" }
        : fail
          ? { detail: "撤销结果待确认" }
          : { message: "已记录更正" },
  }));
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const order = {
    id: "void-test",
    source: { currency: "CNY" },
    items: [],
    receipts: [
      { request_id: "receipt", received_date: "2026-10-19" },
      { request_id: "voided", received_date: "2026-10-18", voided: true },
    ],
    corrections: [{ action: "return_note", reason: "仅记录实物退货说明" }],
  } as unknown as ManagedOrder;
  render(<OrderCorrections order={order} onChanged={async () => {}} />);
  fireEvent.change(screen.getByLabelText("更正类型"), {
    target: { value: "void_receipt" },
  });
  fireEvent.change(screen.getByLabelText("收货批次"), {
    target: { value: "receipt" },
  });
  fireEvent.change(screen.getByLabelText("更正／核对依据"), {
    target: { value: "误录收货需要更正" },
  });
  expect(screen.getByText("确认所选更正")).toBeDisabled();
  fireEvent.click(screen.getByText("先核对关联批次与后续操作"));
  await screen.findByText("批次已有消耗，需要人工核对");
  fireEvent.click(screen.getByText("确认所选更正"));
  await screen.findByText("撤销结果待确认");
  expect(screen.getByText("恢复原更正")).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByText("恢复原更正"));
  await screen.findByText("已记录更正");
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual(
    JSON.parse(String(fetch.mock.calls[2]?.[1]?.body)),
  );
});
it("检查失败不允许作废；取消确认和关闭旧请求不写入", async () => {
  localStorage.setItem(
    "beancount-ui.correction.close-test",
    JSON.stringify({ request_id: "old", action: "release" }),
  );
  const fetch = vi.fn(async () => ({
    ok: false,
    status: 503,
    json: async () => ({ detail: "日志不可用" }),
  }));
  vi.stubGlobal("fetch", fetch);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(
    <OrderCorrections
      order={
        {
          id: "close-test",
          source: { currency: "CNY" },
          items: [],
          receipts: [{ request_id: "r", received_date: "2026-10-19" }],
        } as unknown as ManagedOrder
      }
      onChanged={async () => {}}
    />,
  );
  fireEvent.click(screen.getByText("恢复原更正"));
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("核对后关闭"));
  expect(screen.getByText("恢复原更正")).toBeInTheDocument();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByText("核对后关闭"));
  fireEvent.change(screen.getByLabelText("更正类型"), {
    target: { value: "return_note" },
  });
  fireEvent.change(screen.getByLabelText("收货批次"), {
    target: { value: "r" },
  });
  fireEvent.click(screen.getByText("先核对关联批次与后续操作"));
  await waitFor(() =>
    expect(screen.getByText("日志不可用")).toBeInTheDocument(),
  );
  expect(screen.getByText("确认所选更正")).toBeDisabled();
});
