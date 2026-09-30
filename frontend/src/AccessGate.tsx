import { useEffect, useState, type ReactNode } from "react";
import { api, reasonOf, setAccessToken } from "./api";

/** 访问门禁：本机模式自动进入；私网模式先登录，口令只保留在页面内存。 */
export default function AccessGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [required, setRequired] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function check() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ required: boolean; authenticated: boolean }>(
        "/access",
      );
      setRequired(result.required);
      setReady(result.authenticated);
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void check();
  }, []);
  if (ready)
    return (
      <>
        {required && (
          <div className="access-bar" role="status">
            <span className="access-pill">
              <span className="dot" />
              个人访问已认证
              <button
                className="ghost small"
                onClick={() => {
                  setAccessToken("");
                  setToken("");
                  setError("");
                  setReady(false);
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
        <div className="brand">
          <span className="brand-mark">账</span>
          <span>
            日用账本
            <small>THE DAILY LEDGER · 本地记账</small>
          </span>
        </div>
        <div>
          <h2>个人访问</h2>
          <p className="muted">
            {required
              ? "私有网络部署：账本读取、写入与备份控制都需要本页口令。"
              : "本机模式无需口令；正在确认服务端访问配置。"}
          </p>
        </div>
        {error && (
          <p className="access-error" role="alert">
            {error}
          </p>
        )}
        {required ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setAccessToken(token);
              void check();
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
            <p className="muted small">
              口令由服务端配置，不是 GitHub
              令牌；只保留在当前页内存，刷新后需重新登录。请通过受控私网或加密
              VPN 访问。
            </p>
          </form>
        ) : (
          <button disabled={busy} onClick={() => void check()}>
            {busy ? "连接中…" : "重新连接"}
          </button>
        )}
      </section>
    </main>
  );
}
