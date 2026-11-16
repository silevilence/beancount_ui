import { act, fireEvent, render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
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
  fireEvent.click(await screen.findByRole("button", { name: "账户余额" }));
  expect(screen.getByRole("textbox", { name: "BQL 查询" })).toHaveTextContent(
    "BALANCES",
  );
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

function editorView() {
  return EditorView.findFromDOM(
    screen.getByRole("textbox", { name: "BQL 查询" }),
  )!;
}

it("速查搜索、光标插入和撤销保留编辑内容，不自动执行", () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(<AdvancedQuery revision="r1" />);
  const view = editorView();
  act(() =>
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "SELECT " },
      selection: { anchor: 7 },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "手册速查" }));
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "商家" },
  });
  expect(screen.getByRole("button", { name: "插入 payee" })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "插入 sum" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "插入 payee" }));
  expect(view.state.doc.toString()).toBe("SELECT payee");
  expect(fetcher).not.toHaveBeenCalled();
  act(() => {
    undo(view);
  });
  expect(view.state.doc.toString()).toBe("SELECT ");
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "没有这个字段" },
  });
  expect(screen.getByText(/没有匹配条目/)).toBeVisible();
});

it("快捷键提交当前编辑内容，空查询和超长查询不提交", async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => result }));
  vi.stubGlobal("fetch", fetcher);
  render(<AdvancedQuery revision="r1" />);
  const view = editorView();
  function replace(text: string) {
    act(() =>
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      }),
    );
  }
  replace("SELECT number LIMIT 1");
  fireEvent.keyDown(view.contentDOM, { key: "Enter", ctrlKey: true });
  await screen.findByText("0.123456789012345678");
  expect(
    JSON.parse(
      (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    ),
  ).toEqual({ query: "SELECT number LIMIT 1" });
  replace(" ");
  expect(screen.getByRole("button", { name: "运行查询" })).toBeDisabled();
  fireEvent.keyDown(view.contentDOM, { key: "Enter", ctrlKey: true });
  replace("x".repeat(20001));
  expect(screen.getByText(/查询超过 20,000/)).toBeVisible();
  fireEvent.keyDown(view.contentDOM, { key: "Enter", ctrlKey: true });
  expect(fetcher).toHaveBeenCalledTimes(1);
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
