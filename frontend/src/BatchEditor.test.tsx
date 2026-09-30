import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import BatchEditor, { draftKey } from "./BatchEditor";
import type { Journal } from "./api";

const journal: Journal = { date: "2026-09-29", revision: "a".repeat(64), view_revision: "a".repeat(64), stale: false, errors: [], transactions: [], expenses: {}, income: {}, sync: "待提交", accounts: [{ name: "Expenses:Food", currencies: [] }, { name: "Assets:Cash", currencies: [] }] };
it("十笔草稿恢复、固定日期、整批请求重试保持身份", async () => {
  const calls: { url: string; body: any }[] = [];
  let fail = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ url, body });
    if (url === "/api/commit" && fail) { fail = false; throw new Error("offline"); }
    return { ok: true, json: async () => url.includes("/journal") ? journal : { request_id: body.request_id, revision: journal.revision, items: [], diffs: {} } };
  }));
  const props = { journal, onClose: vi.fn(), onSaved: vi.fn(async () => {}) };
  const mounted = render(<BatchEditor {...props} />);
  fireEvent.change(screen.getByLabelText("支出分类"), { target: { value: "Expenses:Food" } });
  fireEvent.change(screen.getByLabelText("付款账户"), { target: { value: "Assets:Cash" } });
  for (let i = 0; i < 10; i++) { fireEvent.change(screen.getByLabelText("实付金额"), { target: { value: "1.20" } }); fireEvent.click(screen.getByText("加入草稿")); }
  expect(JSON.parse(localStorage.getItem(draftKey(journal))!).items).toHaveLength(10);
  mounted.unmount(); render(<BatchEditor {...props} />);
  expect(screen.getByLabelText("补记日期")).toHaveValue("2026-09-29");
  fireEvent.click(screen.getByText("整批预览并校验"));
  fireEvent.click(await screen.findByText("确认整批入账"));
  await screen.findByText(/offline/);
  fireEvent.click(screen.getByText("重试原批次保存"));
  await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
  const commits = calls.filter(c => c.url === "/api/commit");
  expect(commits[0].body).toEqual(commits[1].body);
  expect(JSON.parse(localStorage.getItem(draftKey(journal))!).items).toHaveLength(0);
});
