import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, reasonOf, setAccessToken } from "./api";
import { saveSessionToken, takeInitialToken } from "./accessSession";
import Brand from "./Brand";

/** 访问门禁：URL 优先，会话恢复仍须服务端验证。 */
export default function AccessGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [required, setRequired] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [initializing, setInitializing] = useState(true);
  const [canRetry, setCanRetry] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const initialToken = useRef<string | null>(null);
  const retryToken = useRef("");
  const request = useRef(0);
  function clearCredentials() {
    setAccessToken("");
    saveSessionToken("");
    retryToken.current = "";
    initialToken.current = "";
  }
  async function check(candidate: string, automatic = false) {
    const current = ++request.current;
    setAccessToken(candidate);
    setBusy(true);
    setError("");
    setCanRetry(false);
    try {
      const result = await api<{ required: boolean; authenticated: boolean }>(
        "/access",
      );
      if (current !== request.current) return;
      setRequired(result.required);
      setReady(result.authenticated);
      if (result.authenticated) {
        setStorageUnavailable(
          !saveSessionToken(result.required ? candidate : ""),
        );
        if (!result.required) clearCredentials();
        retryToken.current = "";
        initialToken.current = "";
        setToken("");
      } else if (candidate) {
        clearCredentials();
        setError(
          automatic ? "自动登录失败，请重新输入口令" : "口令错误，请重新输入",
        );
      }
    } catch (e) {
      if (current !== request.current) return;
      setRequired(true);
      setReady(false);
      setAccessToken("");
      if (e instanceof ApiError && e.status === 401) {
        clearCredentials();
        setError(automatic ? "自动登录失败，请重新输入口令" : reasonOf(e));
      } else {
        retryToken.current = candidate;
        setCanRetry(true);
        setError(`连接或访问失败：${reasonOf(e)}`);
      }
    } finally {
      if (current === request.current) {
        setBusy(false);
        setInitializing(false);
      }
    }
  }
  useEffect(() => {
    // StrictMode 会重新运行 effect；URL 凭据只消费一次，旧响应不得更新状态。
    if (initialToken.current === null)
      initialToken.current = takeInitialToken();
    void check(initialToken.current, true);
    return () => {
      request.current++;
    };
  }, []);
  if (ready)
    return (
      <>
        {required && (
          <div className="access-bar" role="status">
            <span className="access-pill">
              <span className="dot" />
              个人访问已认证
              {storageUnavailable && (
                <span>浏览器未允许保存口令，刷新后需重新登录。</span>
              )}
              <button
                className="ghost small"
                onClick={() => {
                  request.current++;
                  clearCredentials();
                  setToken("");
                  setError("");
                  setReady(false);
                  setCanRetry(false);
                }}
              >
                退出
              </button>
            </span>
          </div>
        )}
        {children}
      </>
    );
  return (
    <main className="access-screen">
      <section className="panel card access-card">
        <Brand />
        <div>
          <h2>个人访问</h2>
          <p className="muted">
            {initializing
              ? "正在登录…"
              : required
                ? "私有网络部署：账本读取、写入与备份控制都需要本页口令。"
                : "本机模式无需口令；正在确认服务端访问配置。"}
          </p>
        </div>
        {error && (
          <p className="access-error" role="alert">
            {error}
          </p>
        )}
        {initializing ? (
          <p role="status">正在验证访问权限…</p>
        ) : required ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy && token) void check(token);
            }}
          >
            <label className="field">
              个人访问口令
              <input
                type="password"
                autoFocus
                autoComplete="current-password"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setError("");
                }}
              />
            </label>
            <button className="cta" disabled={busy || !token}>
              {busy ? "验证中…" : "登录"}
            </button>
            {canRetry && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void check(retryToken.current, true)}
              >
                重试连接
              </button>
            )}
            <p className="muted small">
              口令由服务端配置，不是 GitHub
              令牌；登录后在当前标签页会话中保存，刷新自动恢复，退出即清除。请通过受控私网或加密
              VPN 访问。
            </p>
          </form>
        ) : (
          <button disabled={busy} onClick={() => void check("")}>
            {busy ? "连接中…" : "重新连接"}
          </button>
        )}
      </section>
    </main>
  );
}
