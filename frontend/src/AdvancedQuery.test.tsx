import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import Statistics from "./Statistics";
import AdvancedQuery from "./AdvancedQuery";

const result = {
  revision: "r1",
  view_revision: "r1",
  available: true,
  stale: false,
  errors: [],
  columns: ["total"],
  rows: [["0.123456789012345678"]],
  truncated: false,
  limit: 1000,
};
it("统计入口提供高级查询，提交精确原文并保留精度，编辑后提示旧结果", async () => {
  const fetcher = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (url.endsWith("/query") ? result : {}),
  }));
  vi.stubGlobal("fetch", fetcher);
  render(<Statistics revision="r1" />);
  fireEvent.click(screen.getByRole("button", { name: "高级查询" }));
  fireEvent.click(screen.getByRole("button", { name: "账户余额" }));
  expect(screen.getByLabelText("BQL 查询")).toHaveValue("BALANCES");
  fireEvent.click(screen.getByRole("button", { name: "运行查询" }));
  await screen.findByText("0.123456789012345678");
  const call = fetcher.mock.calls.find(([url]) => url.endsWith("/query"))!;
  expect(
    new Headers((call as unknown as [string, RequestInit])[1].headers).get(
      "Content-Type",
    ),
  ).toBe("application/json");
  expect(
    JSON.parse((call as unknown as [string, RequestInit])[1].body as string),
  ).toEqual({ query: "BALANCES" });
  fireEvent.click(screen.getByRole("button", { name: "按摘要匹配流水" }));
  expect(screen.getByText(/查询文字已修改/)).toBeInTheDocument();
});

it("查询失败、无结果、截断与旧快照均明确反馈", async () => {
  let response: unknown = { detail: "查询失败：syntax error" };
  let ok = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, json: async () => response })),
  );
  render(<AdvancedQuery revision="r2" />);
  fireEvent.click(screen.getByRole("button", { name: "运行查询" }));
  await screen.findByText(/syntax error/);
  ok = true;
  response = { ...result, rows: [] };
  fireEvent.click(screen.getByRole("button", { name: "运行查询" }));
  await screen.findByText("查询没有返回数据。");
  expect(screen.queryByText(/syntax error/)).not.toBeInTheDocument();
  response = { ...result, rows: [[null]], stale: true, truncated: true };
  fireEvent.click(screen.getByRole("button", { name: "运行查询" }));
  await screen.findByText(/仅显示前 1000 行/);
  expect(screen.getByText(/账本已变化或校验失败/)).toBeInTheDocument();
  expect(screen.getByRole("cell")).toHaveTextContent("—");
});
