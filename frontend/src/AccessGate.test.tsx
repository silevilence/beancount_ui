import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import AccessGate from "./AccessGate";
import { api, setAccessToken } from "./api";

afterEach(() => setAccessToken(""));

it("本机自动进入，私网登录前不显示账本", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ required: false, authenticated: true }),
    })),
  );
  render(
    <AccessGate>
      <p>本地账本</p>
    </AccessGate>,
  );
  expect(await screen.findByText("本地账本")).toBeInTheDocument();
});

it("口令只存内存，登录失败可更正且可以退出", async () => {
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
    const token = new Headers(options?.headers).get("Authorization");
    return {
      ok: token !== "Bearer wrong",
      status: 401,
      json: async () =>
        token === "Bearer wrong"
          ? { detail: "口令错误" }
          : { required: true, authenticated: token === "Bearer app-secret" },
    };
  });
  vi.stubGlobal("fetch", fetcher);
  render(
    <AccessGate>
      <p>私人账本</p>
    </AccessGate>,
  );
  const input = await screen.findByLabelText("个人访问口令");
  expect(screen.queryByText("私人账本")).not.toBeInTheDocument();
  fireEvent.change(input, { target: { value: "wrong" } });
  fireEvent.click(screen.getByText("登录"));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("口令错误");
  expect(alert).not.toHaveTextContent("Error:");
  fireEvent.change(input, { target: { value: "app-secret" } });
  fireEvent.click(screen.getByText("登录"));
  expect(await screen.findByText("私人账本")).toBeInTheDocument();
  expect(localStorage.length).toBe(0);
  await api("/ledger");
  expect(
    new Headers(fetcher.mock.calls.at(-1)?.[1]?.headers).get("Authorization"),
  ).toBe("Bearer app-secret");
  fireEvent.click(screen.getByText("退出"));
  expect(screen.queryByText("私人账本")).not.toBeInTheDocument();
  await api("/access");
  await waitFor(() =>
    expect(
      new Headers(fetcher.mock.calls.at(-1)?.[1]?.headers).has("Authorization"),
    ).toBe(false),
  );
});
