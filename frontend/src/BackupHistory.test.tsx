import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import BackupHistory from "./BackupHistory";

it("展开才读取日志，筛选失败并在刷新错误后保留旧记录", async () => {
  let failed = false;
  const fetch = vi.fn(async () => ({
    ok: !failed,
    status: 500,
    json: async () =>
      failed
        ? { detail: "暂不可用" }
        : [
            {
              time: "2026-11-16T02:00:00Z",
              action: "backup",
              source: "automatic",
              outcome: "failed",
              message: "连接失败",
              elapsed: 2,
            },
            {
              time: "2026-11-15T02:00:00Z",
              action: "backup",
              source: "manual",
              outcome: "success",
              message: "同步完成",
              elapsed: 1,
            },
          ],
  }));
  vi.stubGlobal("fetch", fetch);
  render(<BackupHistory />);
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("查看备份日志"));
  await screen.findByText("同步完成");
  fireEvent.change(screen.getByLabelText("日志筛选"), {
    target: { value: "failed" },
  });
  expect(screen.queryByText("同步完成")).not.toBeInTheDocument();
  expect(screen.getByText("连接失败")).toBeInTheDocument();
  failed = true;
  fireEvent.click(screen.getByText("刷新日志"));
  await screen.findByRole("alert");
  expect(screen.getByText("连接失败")).toBeInTheDocument();
  failed = false;
  fireEvent.click(screen.getByText("刷新日志"));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
});

it("没有日志时说明开始记录的时间边界", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => [] })),
  );
  render(<BackupHistory />);
  fireEvent.click(screen.getByText("查看备份日志"));
  expect(await screen.findByText(/暂无备份日志/)).toBeInTheDocument();
  expect(screen.getByText(/升级前的运行记录无法补录/)).toBeInTheDocument();
});
