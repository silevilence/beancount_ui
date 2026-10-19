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
  const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(screen.getByText("人工核实后重发"));
  prompt.mockReturnValue("短");
  fireEvent.click(screen.getByText("人工核实后重发"));
  prompt.mockReturnValue("核对完整日志，确认请求已停止并未产生入库");
  fireEvent.click(screen.getByText("人工核实后重发"));
  expect(fetch).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByText("人工核实后重发"));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(fetch.mock.calls[0]?.[0]).toBe(
    "/api/grocy/operations/operation/retry",
  );
});
it.each([true, false])("人工结论只保存核对结果 applied=%s", async (applied) => {
  const { fetch, changed } = setup();
  vi.spyOn(window, "prompt").mockReturnValue(
    "已经核对远端完整日志与批次并停止原执行",
  );
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(
    screen.getByText(applied ? "记录人工核实成功" : "人工核对后停止"),
  );
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
    applied,
    original_stopped: true,
  });
});
it("人工核对取消不发请求，失败保留核对入口", async () => {
  const { fetch } = setup("undoing", true);
  const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(screen.getByText("人工核对后停止"));
  expect(fetch).not.toHaveBeenCalled();
  prompt.mockReturnValue("核对执行已停止且远端没有产生额外写入");
  fireEvent.click(screen.getByText("人工核对后停止"));
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
