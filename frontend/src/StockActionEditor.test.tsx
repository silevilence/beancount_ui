import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import StockActionEditor from "./StockActionEditor";
import type { InventoryData, Product, StockEntry } from "./Inventory";

it("手动库存操作先预览再确认，未知结果保留核对入口", async () => {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      paths.push(path);
      return {
        ok: true,
        json: async () => ({
          id: "request",
          status: path.endsWith("preview") ? "draft" : "unknown",
          error: "响应丢失",
          payload: { amount: "1" },
        }),
      };
    }),
  );
  render(
    <StockActionEditor
      product={
        { id: 1, name: "牛奶", location_id: 1, qu_id_stock: 1 } as Product
      }
      data={
        {
          instance_id: "one",
          currency: "CNY",
          units: [{ id: 1, name: "瓶" }],
          locations: [{ id: 1, name: "冰箱" }],
        } as InventoryData
      }
      entries={[
        {
          id: 1,
          stock_id: "batch",
          amount: "1",
          location_id: 1,
          open: 0,
        } as StockEntry,
      ]}
      onChanged={async () => {}}
    />,
  );
  fireEvent.click(screen.getByText("预览库存动作"));
  fireEvent.click(await screen.findByText("确认库存操作"));
  expect(await screen.findByText("结果待确认")).toBeInTheDocument();
  expect(paths).toEqual([
    "/api/grocy/manual/preview",
    "/api/grocy/manual/commit",
  ]);
});

const product = {
  id: 1,
  name: "水",
  location_id: 1,
  qu_id_stock: 1,
} as Product;
const data = {
  instance_id: "manual-test",
  currency: "CNY",
  units: [{ id: 1, name: "瓶" }],
  locations: [
    { id: 1, name: "厨房" },
    { id: 2, name: "冰箱" },
  ],
} as InventoryData;
it.each([true, false])(
  "人工核对保存后更新当前操作结果 applied=%s",
  async (applied) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => ({
        ok: true,
        json: async () => ({
          id: "request",
          status: path.endsWith("preview")
            ? "draft"
            : path.endsWith("resolve")
              ? applied
                ? "resolved"
                : "cancelled"
              : "unknown",
          error: "",
          payload: { amount: "1" },
        }),
      })),
    );
    vi.spyOn(window, "prompt").mockReturnValue(
      "已经核对远端完整日志与批次并停止原执行",
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <StockActionEditor
        product={product}
        data={data}
        entries={[
          {
            id: 1,
            stock_id: "batch",
            amount: "2",
            location_id: 1,
            open: 0,
          } as StockEntry,
        ]}
        onChanged={async () => {}}
      />,
    );
    fireEvent.click(screen.getByText("预览库存动作"));
    fireEvent.click(await screen.findByText("确认库存操作"));
    await screen.findByText("结果待确认");
    fireEvent.click(
      screen.getByText(applied ? "记录人工核实成功" : "人工核对后停止"),
    );
    expect(
      await screen.findByText(applied ? "已人工核实" : "已停止操作"),
    ).toBeInTheDocument();
    expect(screen.queryByText("结果待确认")).not.toBeInTheDocument();
  },
);
it("来源位置仅显示有库存的位置，并将实际选中的位置提交预览", async () => {
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => ({
    ok: true,
    json: async () => ({
      id: "filtered",
      status: "draft",
      payload: { amount: "1" },
    }),
  }));
  vi.stubGlobal("fetch", fetch);
  render(
    <StockActionEditor
      product={product}
      data={data}
      entries={[
        {
          id: 1,
          stock_id: "batch",
          amount: "2",
          location_id: 2,
          open: 0,
        } as StockEntry,
      ]}
      onChanged={async () => {}}
    />,
  );
  const location = screen.getByLabelText("来源位置");
  expect(
    within(location).queryByRole("option", { name: "厨房" }),
  ).not.toBeInTheDocument();
  expect(location).toHaveValue("2");
  fireEvent.click(screen.getByText("预览库存动作"));
  await screen.findByText("确认库存操作");
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
    location_id: 2,
  });
});

it("开封仅列未开封库存，切换动作清除批次并保留完整入库及目标位置", async () => {
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => ({
    ok: true,
    json: async () => ({
      id: "opened",
      status: "draft",
      open_target_location_id: 1,
    }),
  }));
  vi.stubGlobal("fetch", fetch);
  const entries = [
    { id: 1, stock_id: "opened", amount: "2", location_id: 1, open: 1 },
    { id: 2, stock_id: "unopened", amount: "3", location_id: 2, open: 0 },
    { id: 3, stock_id: "empty", amount: "0", location_id: 2, open: 0 },
  ] as StockEntry[];
  render(
    <StockActionEditor
      product={product}
      data={data}
      entries={entries}
      onChanged={async () => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("批次（开封必须选择）"), {
    target: { value: "opened" },
  });
  fireEvent.change(screen.getByLabelText("库存动作"), {
    target: { value: "open" },
  });
  expect(screen.getByLabelText("来源位置")).toHaveValue("2");
  expect(
    within(screen.getByLabelText("来源位置")).getAllByRole("option"),
  ).toHaveLength(1);
  const batches = screen.getByLabelText("批次（开封必须选择）");
  expect(batches).toHaveValue("");
  expect(within(batches).getAllByRole("option")).toHaveLength(2);
  expect(screen.getByText("预览库存动作")).toBeDisabled();
  fireEvent.change(batches, { target: { value: "unopened" } });
  fireEvent.click(screen.getByText("预览库存动作"));
  expect(await screen.findByText("开封后自动转移至：厨房")).toBeInTheDocument();
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
    action: "open",
    location_id: 2,
    stock_id: "unopened",
  });
  fireEvent.click(screen.getByText("取消库存预览"));
  fireEvent.change(screen.getByLabelText("库存动作"), {
    target: { value: "transfer" },
  });
  expect(screen.getByLabelText("批次（开封必须选择）")).toHaveValue("");
  expect(
    within(screen.getByLabelText("目标位置")).getAllByRole("option"),
  ).toHaveLength(3);
  fireEvent.change(screen.getByLabelText("库存动作"), {
    target: { value: "add" },
  });
  expect(
    within(screen.getByLabelText("入库位置")).getAllByRole("option"),
  ).toHaveLength(2);
});

it("库存刷新后回退到剩余位置，无库存时禁止预览但允许手动入库", () => {
  const entries = [
    { id: 1, stock_id: "first", amount: "1", location_id: 1, open: 0 },
    { id: 2, stock_id: "second", amount: "1", location_id: 2, open: 0 },
  ] as StockEntry[];
  const props = { product, data, onChanged: async () => {} };
  const { rerender } = render(
    <StockActionEditor {...props} entries={entries} />,
  );
  fireEvent.change(screen.getByLabelText("批次（开封必须选择）"), {
    target: { value: "first" },
  });
  rerender(<StockActionEditor {...props} entries={entries.slice(1)} />);
  expect(screen.getByLabelText("来源位置")).toHaveValue("2");
  expect(screen.getByLabelText("批次（开封必须选择）")).toHaveValue("");
  rerender(<StockActionEditor {...props} entries={[]} />);
  expect(screen.getByText("无可操作库存位置")).toBeInTheDocument();
  expect(screen.getByText("预览库存动作")).toBeDisabled();
  fireEvent.change(screen.getByLabelText("库存动作"), {
    target: { value: "add" },
  });
  expect(screen.getByText("预览库存动作")).toBeEnabled();
});

it("按产品默认数量预填消耗和开封，仍可手改", async () => {
  const configured = {
    ...product,
    quick_consume_amount: "0.5",
    quick_open_amount: "24",
  };
  const { rerender } = render(
    <StockActionEditor
      product={configured}
      data={data}
      entries={[]}
      onChanged={async () => {}}
    />,
  );
  expect(screen.getByLabelText("数量（瓶）")).toHaveValue("0.5");
  fireEvent.change(screen.getByLabelText("库存动作"), {
    target: { value: "open" },
  });
  expect(screen.getByLabelText("数量（瓶）")).toHaveValue("24");
  fireEvent.change(screen.getByLabelText("数量（瓶）"), {
    target: { value: "12" },
  });
  expect(screen.getByLabelText("数量（瓶）")).toHaveValue("12");
  rerender(
    <StockActionEditor
      product={{ ...configured, quick_open_amount: "48" }}
      data={data}
      entries={[]}
      onChanged={async () => {}}
    />,
  );
  expect(screen.getByLabelText("数量（瓶）")).toHaveValue("12");
  fireEvent.change(screen.getByLabelText("库存动作"), {
    target: { value: "transfer" },
  });
  expect(screen.getByLabelText("数量（瓶）")).toHaveValue("1");
  fireEvent.change(screen.getByLabelText("库存动作"), {
    target: { value: "consume" },
  });
  expect(screen.getByLabelText("数量（瓶）")).toHaveValue("0.5");
});

it.each([undefined, "bad", "0", "-2", "Infinity"])(
  "无效或缺失默认数量 %s 回退为 1",
  (value) => {
    render(
      <StockActionEditor
        product={{
          ...product,
          quick_consume_amount: value,
          quick_open_amount: value,
        }}
        data={data}
        entries={[]}
        onChanged={async () => {}}
      />,
    );
    expect(screen.getByLabelText("数量（瓶）")).toHaveValue("1");
    fireEvent.change(screen.getByLabelText("库存动作"), {
      target: { value: "open" },
    });
    expect(screen.getByLabelText("数量（瓶）")).toHaveValue("1");
  },
);

it("手动入库预览显示数量价格日期，取消不发送库存写入", async () => {
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => ({
    ok: true,
    json: async () => ({
      id: "manual",
      status: "draft",
      payload: { amount: "2" },
    }),
  }));
  vi.stubGlobal("fetch", fetch);
  render(
    <StockActionEditor
      product={product}
      data={data}
      entries={[]}
      onChanged={async () => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("库存动作"), {
    target: { value: "add" },
  });
  fireEvent.change(screen.getByLabelText("数量（瓶）"), {
    target: { value: "2" },
  });
  fireEvent.change(screen.getByLabelText("入库位置"), {
    target: { value: "2" },
  });
  fireEvent.change(screen.getByLabelText("购买日期"), {
    target: { value: "2026-10-19" },
  });
  fireEvent.change(screen.getByLabelText("保质期日期"), {
    target: { value: "2027-01-01" },
  });
  fireEvent.change(screen.getByLabelText("每库存单位价格（CNY）"), {
    target: { value: "5" },
  });
  fireEvent.click(screen.getByLabelText(/本次入库与订单收货无关/));
  fireEvent.click(screen.getByText("预览库存动作"));
  await screen.findByText("确认库存操作");
  expect(screen.getByText(/手动入库 2 瓶/)).toBeInTheDocument();
  expect(screen.getByText(/每库存单位 5 CNY/)).toBeInTheDocument();
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
    independent_purchase: true,
    location_id: 2,
    amount: "2",
  });
  fireEvent.click(screen.getByText("取消库存预览"));
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("跨位置转移保留原批次，提交超时后恢复同一操作", async () => {
  let fail = true;
  const fetch = vi.fn(async (path: string, _init?: RequestInit) => ({
    ok: !path.endsWith("commit") || !fail,
    status: 503,
    json: async () =>
      path.endsWith("commit") && fail
        ? { detail: "响应丢失" }
        : {
            id: "transfer-original",
            status: "draft",
            payload: { amount: "1" },
          },
  }));
  vi.stubGlobal("fetch", fetch);
  render(
    <StockActionEditor
      product={product}
      data={data}
      entries={[
        {
          id: 1,
          stock_id: "batch",
          amount: "2",
          best_before_date: "2027-01-01",
          location_id: 1,
          open: 0,
        },
        {
          id: 2,
          stock_id: "opened",
          amount: "1",
          best_before_date: "2027-01-01",
          location_id: 1,
          open: 1,
        },
      ]}
      onChanged={async () => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("库存动作"), {
    target: { value: "transfer" },
  });
  fireEvent.change(screen.getByLabelText("目标位置"), {
    target: { value: "2" },
  });
  fireEvent.change(screen.getByLabelText("批次（开封必须选择）"), {
    target: { value: "batch" },
  });
  fireEvent.click(screen.getByText("预览库存动作"));
  fireEvent.click(await screen.findByText("确认库存操作"));
  await screen.findByText("响应丢失");
  expect(screen.queryByText("取消库存预览")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("恢复原预览"));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(screen.queryByText("取消库存预览")).not.toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByText("确认库存操作"));
  await screen.findByText("日常库存操作");
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
  const commits = fetch.mock.calls.filter((c) => c[0].endsWith("commit"));
  expect(commits.map((c) => JSON.parse(String(c[1]?.body)))).toEqual([
    { request_id: "transfer-original" },
    { request_id: "transfer-original" },
  ]);
});
