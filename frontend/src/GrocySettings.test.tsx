import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import GrocySettings from "./GrocySettings";
const config = {
  url: "http://grocy",
  enabled: true,
  key_configured: true,
  instance_id: "one",
  default_location_id: null,
  default_best_before_days: null,
};
it("修改默认位置与保质期、取消、清除凭据和测试连接", async () => {
  const fetch = vi.fn(async (path: string, init?: RequestInit) => ({
    ok: true,
    json: async () =>
      path.endsWith("check")
        ? { version: "4.7.1", write_permission: "未执行写入" }
        : init
          ? { ...config, ...JSON.parse(String(init.body)) }
          : config,
  }));
  vi.stubGlobal("fetch", fetch);
  render(<GrocySettings />);
  const url = await screen.findByLabelText("Grocy 实例地址");
  fireEvent.change(url, { target: { value: "http://other" } });
  fireEvent.change(screen.getByLabelText(/默认入库位置/), {
    target: { value: "2" },
  });
  fireEvent.change(screen.getByLabelText(/默认保质期/), {
    target: { value: "30" },
  });
  fireEvent.click(screen.getByText("取消修改"));
  expect(url).toHaveValue("http://grocy");
  fireEvent.change(screen.getByLabelText(/默认入库位置/), {
    target: { value: "2" },
  });
  fireEvent.change(screen.getByLabelText(/默认入库位置/), {
    target: { value: "" },
  });
  fireEvent.change(screen.getByLabelText(/默认保质期/), {
    target: { value: "30" },
  });
  fireEvent.change(screen.getByLabelText(/默认保质期/), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByLabelText("清除已保存 Key"));
  expect(screen.getByLabelText("启用库存联动")).not.toBeChecked();
  fireEvent.click(screen.getByText("保存 Grocy 设置"));
  await screen.findByText("Grocy 设置已保存");
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
    clear_key: true,
    api_key: null,
    enabled: false,
  });
  fireEvent.click(screen.getByText("测试已保存连接"));
  expect(await screen.findByText(/Grocy 4.7.1/)).toBeInTheDocument();
});
it("读取失败有说明", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ detail: "配置读取失败" }),
    })),
  );
  render(<GrocySettings />);
  expect(await screen.findByText("配置读取失败")).toBeInTheDocument();
});
it("保存失败保留未提交的 Key 供修正", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_path: string, init?: RequestInit) => ({
      ok: !init,
      status: 503,
      json: async () =>
        init ? { detail: "保存失败" } : { ...config, key_configured: false },
    })),
  );
  render(<GrocySettings />);
  const key = await screen.findByLabelText(/API Key/);
  fireEvent.change(key, { target: { value: "test-only-key" } });
  fireEvent.click(screen.getByLabelText("启用库存联动"));
  fireEvent.click(screen.getByText("保存 Grocy 设置"));
  await waitFor(() => expect(screen.getByText("保存失败")).toBeInTheDocument());
  expect(key).toHaveValue("test-only-key");
});
