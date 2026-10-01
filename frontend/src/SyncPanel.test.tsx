import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import SyncDialog from "./SyncDialog";
import SyncPanel from "./SyncPanel";
import { refreshSync } from "./syncStatus";

type Reply = { ok: boolean; status?: number; json: () => Promise<unknown> };
type Body = Record<string, unknown> | undefined;
const ok = (data: unknown): Reply => ({ ok: true, json: async () => data });
const fail = (detail: string, status = 409): Reply => ({
  ok: false,
  status,
  json: async () => ({ detail }),
});

function status(over: Record<string, unknown> = {}) {
  return {
    connected: true,
    enabled: false,
    remote: "https://example.invalid/ledger.git",
    branch: "master-1",
    sync: "已同步",
    ahead: 0,
    last_success: new Date(Date.now() - 120_000).toISOString(),
    changes: [],
    ...over,
  };
}

/** 按路径应答，并记录每次请求的 JSON body，便于断言真正提交的内容。 */
function serve(handler: (path: string, body: Body) => Reply) {
  const calls: { path: string; body: Body }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, options?: RequestInit) => {
      const url = new URL(String(input), "http://local");
      const path =
        url.pathname === "/api/sync"
          ? "/status"
          : url.pathname.replace("/api/sync/", "");
      const body = options?.body
        ? (JSON.parse(String(options.body)) as Record<string, unknown>)
        : undefined;
      calls.push({ path, body });
      return handler(path, body);
    }),
  );
  return calls;
}

const changed = vi.fn(async () => {});

it("未接入时可以保存代理，轮询不覆盖输入，失败保留输入并可重试或切回直连", async () => {
  let saved = { proxy_mode: "system", proxy_url: "" };
  let reject = true;
  const calls = serve((path, body) => {
    if (path === "proxy") {
      if (reject) return fail("代理地址无效", 422);
      saved = { proxy_mode: String(body?.mode), proxy_url: String(body?.url) };
      return ok(saved);
    }
    return ok(status({ connected: false, ...saved }));
  });
  render(<Harness />);
  fireEvent.click(await screen.findByText("备份中心"));
  fireEvent.change(await screen.findByLabelText("代理模式"), {
    target: { value: "custom" },
  });
  fireEvent.change(screen.getByLabelText("代理服务器地址"), {
    target: { value: "socks5h://192.168.1.10:7890" },
  });
  await refreshSync();
  expect(screen.getByLabelText("代理服务器地址")).toHaveValue(
    "socks5h://192.168.1.10:7890",
  );
  fireEvent.click(screen.getByText("保存代理设置"));
  expect(
    await screen.findByText(/备份操作失败：代理地址无效/),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("代理服务器地址")).toHaveValue(
    "socks5h://192.168.1.10:7890",
  );
  reject = false;
  fireEvent.click(screen.getByText("保存代理设置"));
  expect(await screen.findByText(/代理设置已保存/)).toBeInTheDocument();
  expect(calls.filter((c) => c.path === "proxy").at(-1)?.body).toEqual({
    mode: "custom",
    url: "socks5h://192.168.1.10:7890",
  });
  fireEvent.change(screen.getByLabelText("代理模式"), {
    target: { value: "direct" },
  });
  fireEvent.click(screen.getByText("保存代理设置"));
  await waitFor(() => expect(saved.proxy_mode).toBe("direct"));
  expect(saved.proxy_url).toBe("");
  fireEvent.click(screen.getByLabelText("关闭备份"));
  fireEvent.click(screen.getByText("备份中心"));
  expect(await screen.findByLabelText("代理模式")).toHaveValue("direct");
});

/** 卡片与对话框的接线方式与 App 一致。 */
function Harness() {
  const [open, setOpen] = useState<{ auto: boolean } | null>(null);
  return (
    <>
      <SyncPanel onOpen={(auto) => setOpen({ auto: !!auto })} />
      {open && (
        <SyncDialog
          auto={open.auto}
          onChanged={changed}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

it("卡片显示状态、远端、待提交与未推送，并可直接打开备份中心", async () => {
  const opened: boolean[] = [];
  serve((path) =>
    path === "/status"
      ? ok(
          status({
            sync: "已保存 · 待提交",
            ahead: 2,
            enabled: true,
            next_check: Date.now() / 1000 + 300,
            changes: [{ status: " M", file: "txs/2026/09.bean" }],
          }),
        )
      : ok({}),
  );
  render(<SyncPanel onOpen={(auto) => opened.push(!!auto)} />);
  expect(await screen.findByText("已保存 · 待提交")).toBeInTheDocument();
  expect(
    screen.getByText("https://example.invalid/ledger.git"),
  ).toBeInTheDocument();
  expect(screen.getByText("1 个文件")).toBeInTheDocument();
  expect(screen.getByText("2 个提交")).toBeInTheDocument();
  expect(screen.getByText("5 分钟后")).toBeInTheDocument();
  fireEvent.click(screen.getByText("立即同步"));
  expect(opened).toEqual([true]);
  fireEvent.click(screen.getByText("备份中心"));
  expect(opened).toEqual([true, false]);
});

it("未接入时给出接入入口与服务端提示", async () => {
  const opened: boolean[] = [];
  serve((path) =>
    path === "/status"
      ? ok(
          status({
            connected: false,
            sync: "已保存 · 尚未接入",
            remote: undefined,
            error: "请在服务端配置账本远端",
          }),
        )
      : ok({}),
  );
  render(<SyncPanel onOpen={(auto) => opened.push(!!auto)} />);
  expect(await screen.findByText("已保存 · 尚未接入")).toBeInTheDocument();
  expect(
    screen.getByText("服务端提示：请在服务端配置账本远端"),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByText("接入 GitHub 仓库"));
  expect(opened).toEqual([false]);
});

it("打开备份中心自动预览，确认后完成推送", async () => {
  changed.mockClear();
  serve((path) => {
    if (path === "/status") return ok(status({ sync: "已保存 · 待提交" }));
    if (path === "backup-preview")
      return ok({
        revision: "r",
        head: "h",
        files: ["txs/2026/09.bean"],
        excluded: ["secret.log"],
        message: "账本备份：1 个文件（2026-09-30）",
        diff: "--- a/txs/2026/09.bean\n+++ b/txs/2026/09.bean\n+saved\n",
        outgoing_files: ["txs/2026/09.bean"],
        outgoing_count: 1,
      });
    return ok(
      status({ sync: "已同步", last_success: new Date().toISOString() }),
    );
  });
  render(<Harness />);
  fireEvent.click(await screen.findByText("立即同步"));
  expect(await screen.findByText("secret.log")).toBeInTheDocument();
  expect(
    screen.getByText("账本备份：1 个文件（2026-09-30）"),
  ).toBeInTheDocument();
  expect(screen.getByText("+1")).toBeInTheDocument();
  expect(screen.getByText("待推送提交 1")).toBeInTheDocument();
  fireEvent.click(screen.getByText("确认校验并推送"));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(screen.getByText(/已同步；最后成功/)).toBeInTheDocument();
});

it("接入预览勾选 include 后必须重新预览才能确认", async () => {
  changed.mockClear();
  const calls = serve((path) => {
    if (path === "/status")
      return ok(status({ connected: false, sync: "已保存 · 尚未接入" }));
    if (path === "preview")
      return ok({
        revision: "r",
        remote: "test.git",
        branch: "master-1",
        ahead: 1,
        changes: [{ status: "MM", file: "09.bean" }],
        unreferenced: ["extra.bean"],
        errors: [],
        diff: "+include extra.bean\n",
      });
    if (path === "connect") return ok(status({ sync: "已同步" }));
    return ok({});
  });
  render(<Harness />);
  fireEvent.click(await screen.findByText("接入 GitHub 仓库"));
  fireEvent.click(screen.getByText("预览接入范围"));
  expect(await screen.findByText("extra.bean")).toBeInTheDocument();
  expect(screen.getByText("已修改")).toBeInTheDocument();
  expect(screen.getByText("test.git")).toBeInTheDocument();
  const confirm = screen.getByText("确认接入（保持自动备份关闭）");
  expect(confirm).toBeEnabled();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(confirm).toBeDisabled();
  expect(
    screen.getByText("include 选择已变化，请重新预览后再确认接入。"),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByText("重新预览"));
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(screen.getByText(/接入完成；自动备份保持关闭/)).toBeInTheDocument();
  expect(calls.find((call) => call.path === "connect")?.body).toEqual({
    revision: "r",
    include: ["extra.bean"],
  });
});

it("定时备份可开关、按预设调整间隔并显示调度原因", async () => {
  let enabled = false;
  const calls = serve((path, body) => {
    if (path === "schedule") {
      enabled = body?.enabled === true;
      return ok(status({ enabled }));
    }
    return ok(
      status({
        enabled,
        failures: enabled ? 3 : 0,
        schedule_reason: enabled ? "无账本变更，本轮跳过" : "自动备份关闭",
      }),
    );
  });
  render(<Harness />);
  await screen.findByText("已同步");
  fireEvent.click(screen.getByText("备份中心"));
  const toggle = screen.getByRole("switch");
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  expect(calls.find((call) => call.path === "schedule")?.body).toEqual({
    enabled: true,
    interval: 300,
    quiet: 60,
  });
  expect(screen.getByText("已开启")).toBeInTheDocument();
  expect(screen.getByText("连续失败 3 次")).toBeInTheDocument();
  expect(screen.getByText(/调度：无账本变更，本轮跳过/)).toBeInTheDocument();
  fireEvent.click(screen.getByText("15 分钟"));
  fireEvent.click(screen.getByText("保存定时设置"));
  await waitFor(() =>
    expect(calls.some((call) => call.body?.interval === 900)).toBe(true),
  );
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(calls.some((call) => call.body?.enabled === false)).toBe(true),
  );
});

it("接入预览无遗漏文件时提示已覆盖，校验错误时禁止确认", async () => {
  serve((path) => {
    if (path === "/status")
      return ok(
        status({
          connected: false,
          sync: "已保存 · 尚未接入",
          last_success: undefined,
        }),
      );
    if (path === "preview")
      return ok({
        revision: "r",
        remote: "test.git",
        branch: "master-1",
        changes: [],
        unreferenced: [],
        errors: [{ file: "bad.bean", line: 3, message: "账户未定义" }],
        diff: "",
      });
    return ok({});
  });
  render(<Harness />);
  fireEvent.click(await screen.findByText("接入 GitHub 仓库"));
  expect(screen.getByText("已关闭")).toBeInTheDocument();
  expect(screen.getByText("尚无")).toBeInTheDocument();
  fireEvent.click(screen.getByText("预览接入范围"));
  expect(
    await screen.findByText("所有账本文件都已被 include 覆盖。"),
  ).toBeInTheDocument();
  expect(screen.getByText("bad.bean:3 · 账户未定义")).toBeInTheDocument();
  expect(screen.getByText("确认接入（保持自动备份关闭）")).toBeDisabled();
});

it("备份预览无变更时说明不会创建空提交", async () => {
  serve((path) => {
    if (path === "/status") return ok(status({ sync: "已保存 · 待提交" }));
    if (path === "backup-preview")
      return ok({
        revision: "r",
        head: "h",
        files: [],
        excluded: [],
        message: "账本备份：0 个文件",
        diff: "",
        outgoing_files: [],
        outgoing_count: 0,
      });
    return ok(status());
  });
  render(<Harness />);
  fireEvent.click(await screen.findByText("立即同步"));
  expect(await screen.findByText("无新变更")).toBeInTheDocument();
  expect(screen.getByText("账本备份：0 个文件")).toBeInTheDocument();
  expect(screen.getByText("待推送提交 0")).toBeInTheDocument();
  expect(screen.getByText(/不会创建空提交/)).toBeInTheDocument();
});

it("克隆失败时提示本地记录保留", async () => {
  serve((path) =>
    path === "/status"
      ? ok(status({ connected: false, sync: "已保存 · 尚未接入" }))
      : fail("网络不可用", 503),
  );
  render(<Harness />);
  fireEvent.click(await screen.findByText("接入 GitHub 仓库"));
  fireEvent.click(screen.getByText("克隆到空目录"));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("已保存的记录仍在本地");
  expect(alert).not.toHaveTextContent("Error:");
});

it("状态响应无效时提示可重试，恢复后显示真实状态", async () => {
  let broken = true;
  serve((path) => {
    if (path !== "/status") return ok({});
    if (broken) {
      broken = false;
      return ok({ unexpected: true });
    }
    return ok(status({ sync: "已保存 · 待提交" }));
  });
  render(<SyncPanel onOpen={() => {}} />);
  const failure = await screen.findByText(/备份状态响应无效/);
  expect(failure).toBeInTheDocument();
  expect(failure).not.toHaveTextContent("Error:");
  fireEvent.click(screen.getByText("重试"));
  expect(await screen.findByText("已保存 · 待提交")).toBeInTheDocument();
  expect(screen.queryByText(/备份状态读取失败/)).not.toBeInTheDocument();
});
