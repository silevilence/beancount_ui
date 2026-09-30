import { useEffect, useState, type ReactNode } from "react";
import { api, setAccessToken } from "./api";

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
      setError(String(e));
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
          <div className="access-bar">
            <span>个人访问已认证</span>
            <button
              onClick={() => {
                setAccessToken("");
                setToken("");
                setReady(false);
              }}
            >
              退出
            </button>
          </div>
        )}
        {children}
      </>
    );
  return (
    <main className="access-screen">
      <section className="panel card">
        <h1>日用账本</h1>
        <p>个人访问 · Asia/Shanghai</p>
        {error && <p role="alert">{error}</p>}
        {required ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setAccessToken(token);
              void check();
            }}
          >
            <label>
              个人访问口令
              <input
                type="password"
                autoComplete="current-password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            <p className="muted">
              使用服务端配置的应用口令。口令只保留在本页内存，刷新后重新登录。
            </p>
            <button disabled={busy || !token}>登录</button>
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
