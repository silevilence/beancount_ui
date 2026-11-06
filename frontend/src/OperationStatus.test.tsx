import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import OperationStatus, { orderSyncLabel } from "./OperationStatus";

it("订单汇总区分部分失败、全部成功和已撤销历史", () => {
  expect(orderSyncLabel([{ status: "success" }, { status: "unknown" }])).toBe(
    "同步待处理 1/2",
  );
  expect(orderSyncLabel([{ status: "success" }])).toBe("库存同步成功");
  expect(
    orderSyncLabel([{ status: "undone" }, { status: "resolved" }]),
  ).toContain("含撤销或人工处理");
});

function setup(status = "unknown", failure = false) {
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => ({
    ok: !failure,
    status: 503,
    json: async () => (failure ? { detail: "远端不可用" } : {}),
  }));
  vi.stubGlobal("fetch", fetch);
  const changed = vi.fn(async () => {});
  render(
    <OperationStatus
      operations={[
        { id: "operation", status, error: "", evidence: { checked: true } },
      ]}
      onChanged={changed}
    />,
  );
  return { fetch, changed };
}
it("核对只读取，显示错误后仍可重试", async () => {
  const { fetch } = setup("conflict", true);
  fireEvent.click(screen.getByText("核对最新日志与库存"));
  expect(await screen.findByText("远端不可用")).toBeInTheDocument();
  expect(fetch.mock.calls[0]?.[0]).toBe(
    "/api/grocy/operations/operation/check",
  );
});
it("人工重发需要说明与停止确认，沿用原编号", async () => {
  const { fetch, changed } = setup();
  fireEvent.click(screen.getByText("人工核实后重发"));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  fireEvent.click(screen.getByText("人工核实后重发"));
  fireEvent.change(screen.getByLabelText("核对依据"), {
    target: { value: "短" },
  });
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
  expect(screen.getByRole("alert")).toHaveTextContent("至少 10 字");
  await fillReason();
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  fireEvent.click(screen.getByText("人工核实后重发"));
  await fillReason();
  fireEvent.click(screen.getByRole("button", { name: "确认继续" }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(fetch.mock.calls[0]?.[0]).toBe(
    "/api/grocy/operations/operation/retry",
  );
});
it.each([true, false])("人工结论只保存核对结果 applied=%s", async (applied) => {
  const { fetch, changed } = setup();
  fireEvent.click(
    screen.getByText(applied ? "记录人工核实成功" : "人工核对后停止"),
  );
  await fillReason();
  fireEvent.click(screen.getByRole("button", { name: "确认继续" }));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
    applied,
    original_stopped: true,
  });
});
it("人工核对取消不发请求，失败保留核对入口", async () => {
  const { fetch } = setup("undoing", true);
  fireEvent.click(screen.getByText("人工核对后停止"));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("人工核对后停止"));
  await fillReason();
  fireEvent.click(screen.getByRole("button", { name: "确认继续" }));
  expect(await screen.findByText("远端不可用")).toBeInTheDocument();
});
it("成功和远端未知状态可展示，不暴露重发按钮", () => {
  render(
    <OperationStatus
      operations={[
        { id: "ok", status: "success", error: "" },
        { id: "other", status: "new-status", error: "" },
      ]}
    />,
  );
  expect(screen.getByText("同步成功")).toBeInTheDocument();
  expect(screen.getByText("new-status")).toBeInTheDocument();
  expect(screen.queryByText("人工核实后重发")).not.toBeInTheDocument();
});

it.each(["记录人工核实成功", "人工核对后停止", "人工核实后重发"])(
  "%s 输入不足时明确提示，而不是静默退出",
  (button) => {
    const { fetch, changed } = setup();
    fireEvent.click(screen.getByText(button));
    fireEvent.change(screen.getByLabelText("核对依据"), {
      target: { value: "已核实" },
    });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByRole("alert")).toHaveTextContent("至少 10 字");
    expect(fetch).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByLabelText("核对依据")).toHaveValue("已核实");
    expect(
      screen.queryByRole("button", { name: "确认继续" }),
    ).not.toBeInTheDocument();
  },
);

async function fillReason() {
  fireEvent.change(screen.getByLabelText("核对依据"), {
    target: { value: "核对完整日志，确认请求已停止并未产生入库" },
  });
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
  expect(await screen.findByRole("dialog", { name: "确认操作" })).toBeVisible();
}
