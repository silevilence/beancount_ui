import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import GrocySettings from "./GrocySettings";

it("连接配置留空保留密钥，取消不保存，连接测试仅用已保存配置", async () => {
  const config = {
    url: "http://nas",
    enabled: true,
    key_configured: true,
    instance_id: "one",
    default_location_id: null,
    default_best_before_days: null,
  };
  const fetcher = vi.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      url.endsWith("check")
        ? { version: "4.7.1", write_permission: "未执行写入" }
        : config,
  }));
  vi.stubGlobal("fetch", fetcher);
  render(<GrocySettings />);
  const url = await screen.findByLabelText("Grocy 实例地址");
  fireEvent.change(url, { target: { value: "http://other" } });
  fireEvent.click(screen.getByText("取消修改"));
  expect(url).toHaveValue("http://nas");
  fireEvent.click(screen.getByText("测试已保存连接"));
  expect(await screen.findByText(/Grocy 4.7.1/)).toBeInTheDocument();
  fireEvent.click(screen.getByText("保存 Grocy 设置"));
  await waitFor(() =>
    expect(screen.getByText("Grocy 设置已保存")).toBeInTheDocument(),
  );
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain("secret");
});
