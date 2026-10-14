import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import AccessGate from "./AccessGate";
import { api, setAccessToken } from "./api";

const storageKey = "beancount-ui.access-token";
afterEach(() => {
  vi.restoreAllMocks();
  setAccessToken("");
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});

function privateServer() {
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
    const authorization = new Headers(options?.headers).get("Authorization");
    const authenticated = authorization === "Bearer app-secret";
    const ok = !authorization || authenticated;
    return {
      ok,
      status: ok ? 200 : 401,
      json: async () =>
        ok
          ? { required: true, authenticated }
          : { detail: "请使用个人访问口令登录" },
    };
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function openGate() {
  return render(
    <StrictMode>
      <AccessGate>
        <p>私人账本</p>
      </AccessGate>
    </StrictMode>,
  );
}

function loginManually() {
  fireEvent.change(screen.getByLabelText("个人访问口令"), {
    target: { value: "app-secret" },
  });
  fireEvent.click(screen.getByText("登录"));
}

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

it("手动登录失败可更正，成功保存会话且退出清除凭据", async () => {
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
  expect(sessionStorage.getItem(storageKey)).toBe("app-secret");
  await api("/ledger");
  expect(
    new Headers(fetcher.mock.calls.at(-1)?.[1]?.headers).get("Authorization"),
  ).toBe("Bearer app-secret");
  fireEvent.click(screen.getByText("退出"));
  expect(sessionStorage.getItem(storageKey)).toBeNull();
  expect(screen.queryByText("私人账本")).not.toBeInTheDocument();
  await api("/access");
  await waitFor(() =>
    expect(
      new Headers(fetcher.mock.calls.at(-1)?.[1]?.headers).has("Authorization"),
    ).toBe(false),
  );
});

it("快捷登录优先于旧会话，清理 URL 并在刷新后重新验证，退出后不自动登录", async () => {
  sessionStorage.setItem(storageKey, "old-secret");
  history.replaceState(
    { view: "statistics" },
    "",
    "/?month=10&token=app-secret&view=stats#chart",
  );
  const fetcher = privateServer();
  const first = openGate();
  expect(screen.getByText("正在登录…")).toBeInTheDocument();
  expect(screen.queryByLabelText("个人访问口令")).not.toBeInTheDocument();
  expect(screen.queryByText("私人账本")).not.toBeInTheDocument();
  expect(location.search).toBe("?month=10&view=stats");
  expect(location.hash).toBe("#chart");
  expect(history.state).toEqual({ view: "statistics" });
  expect(sessionStorage.getItem(storageKey)).toBe("old-secret");
  expect(await screen.findByText("私人账本")).toBeInTheDocument();
  expect(sessionStorage.getItem(storageKey)).toBe("app-secret");
  expect(localStorage.length).toBe(0);
  expect(
    fetcher.mock.calls.every(
      ([, options]) =>
        new Headers(options?.headers).get("Authorization") ===
        "Bearer app-secret",
    ),
  ).toBe(true);

  first.unmount();
  setAccessToken("");
  fetcher.mockClear();
  const refreshed = openGate();
  expect(screen.queryByText("私人账本")).not.toBeInTheDocument();
  expect(await screen.findByText("私人账本")).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalled();
  fireEvent.click(screen.getByText("退出"));
  expect(sessionStorage.getItem(storageKey)).toBeNull();
  expect(screen.getByLabelText("个人访问口令")).toHaveValue("");
  refreshed.unmount();
  setAccessToken("");
  openGate();
  expect(await screen.findByLabelText("个人访问口令")).toBeInTheDocument();
  expect(screen.queryByText("私人账本")).not.toBeInTheDocument();
});

it("手动登录后刷新使用会话口令，结束会话后需要重新输入", async () => {
  privateServer();
  const first = openGate();
  await screen.findByLabelText("个人访问口令");
  loginManually();
  await screen.findByText("私人账本");
  first.unmount();
  setAccessToken("");
  const refreshed = openGate();
  await screen.findByText("私人账本");
  refreshed.unmount();
  setAccessToken("");
  sessionStorage.clear();
  openGate();
  expect(await screen.findByLabelText("个人访问口令")).toBeInTheDocument();
});

it.each(["/", "/?token=", "/?token"])(
  "缺失或空 URL Token 使用已有会话：%s",
  async (url) => {
    history.replaceState(null, "", url);
    sessionStorage.setItem(storageKey, "app-secret");
    privateServer();
    openGate();
    expect(await screen.findByText("私人账本")).toBeInTheDocument();
    expect(location.search).toBe("");
  },
);

it.each(["/", "/?token="])("没有可用凭据时回到手动登录：%s", async (url) => {
  history.replaceState(null, "", url);
  privateServer();
  openGate();
  expect(await screen.findByLabelText("个人访问口令")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it.each(["url", "session"])(
  "%s Token 无效时清除凭据，允许手动更正",
  async (source) => {
    sessionStorage.setItem(
      storageKey,
      source === "url" ? "app-secret" : "expired",
    );
    if (source === "url") history.replaceState(null, "", "/?token=wrong");
    const fetcher = privateServer();
    openGate();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "自动登录失败，请重新输入口令",
    );
    expect(screen.getByLabelText("个人访问口令")).toHaveValue("");
    expect(sessionStorage.getItem(storageKey)).toBeNull();
    expect(screen.queryByText("私人账本")).not.toBeInTheDocument();
    await api("/access");
    expect(
      new Headers(fetcher.mock.calls.at(-1)?.[1]?.headers).has("Authorization"),
    ).toBe(false);
    loginManually();
    expect(await screen.findByText("私人账本")).toBeInTheDocument();
  },
);

it.each(["network", "server", "origin"])(
  "%s 失败保留已验证会话，可重试恢复",
  async (failure) => {
    sessionStorage.setItem(storageKey, "app-secret");
    const fetcher = privateServer();
    const normal = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async () => {
      if (failure === "network") throw new TypeError("Failed to fetch");
      return {
        ok: false,
        status: failure === "server" ? 503 : 403,
        json: async () => ({ detail: "服务暂不可用或来源未获允许" }),
      };
    });
    openGate();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "连接或访问失败",
    );
    expect(screen.getByLabelText("个人访问口令")).toBeInTheDocument();
    expect(sessionStorage.getItem(storageKey)).toBe("app-secret");
    fetcher.mockImplementation(normal);
    fireEvent.click(screen.getByText("重试连接"));
    expect(await screen.findByText("私人账本")).toBeInTheDocument();
  },
);

it.each(["retry", "manual"])(
  "URL 登录遇到连接失败后可通过 %s 恢复，未验证口令不保存",
  async (action) => {
    history.replaceState(null, "", "/?token=app-secret");
    const fetcher = privateServer();
    const normal = fetcher.getMockImplementation()!;
    fetcher.mockRejectedValue(new TypeError("Failed to fetch"));
    openGate();
    await screen.findByRole("alert");
    expect(location.search).toBe("");
    expect(sessionStorage.getItem(storageKey)).toBeNull();
    fetcher.mockImplementation(normal);
    if (action === "retry") fireEvent.click(screen.getByText("重试连接"));
    else loginManually();
    expect(await screen.findByText("私人账本")).toBeInTheDocument();
    expect(sessionStorage.getItem(storageKey)).toBe("app-secret");
  },
);

it("本机模式忽略口令并清除会话，不向后续 API 发送无用凭据", async () => {
  history.replaceState(null, "", "/?token=unused");
  sessionStorage.setItem(storageKey, "old");
  const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => ({
    ok: true,
    json: async () => ({ required: false, authenticated: true }),
  }));
  vi.stubGlobal("fetch", fetcher);
  openGate();
  await screen.findByText("私人账本");
  expect(screen.queryByText("退出")).not.toBeInTheDocument();
  expect(sessionStorage.getItem(storageKey)).toBeNull();
  expect(location.search).toBe("");
  await api("/ledger");
  expect(
    new Headers(fetcher.mock.calls.at(-1)?.[1]?.headers).has("Authorization"),
  ).toBe(false);
});

it("严格模式较早的验证失败响应不会覆盖已成功的登录", async () => {
  history.replaceState(null, "", "/?token=app-secret");
  let fail!: (reason: Error) => void;
  const fetcher = privateServer();
  fetcher.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  openGate();
  await screen.findByText("私人账本");
  await act(async () => fail(new Error("过期响应")));
  expect(screen.getByText("私人账本")).toBeInTheDocument();
  expect(sessionStorage.getItem(storageKey)).toBe("app-secret");
});

it("会话存储不可用时仍可手动登录并提示刷新限制", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("Blocked", "SecurityError");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Blocked", "SecurityError");
  });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new DOMException("Blocked", "SecurityError");
  });
  privateServer();
  openGate();
  await screen.findByLabelText("个人访问口令");
  loginManually();
  await screen.findByText("私人账本");
  expect(
    screen.getByText("浏览器未允许保存口令，刷新后需重新登录。"),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByText("退出"));
  expect(screen.getByLabelText("个人访问口令")).toBeInTheDocument();
});
