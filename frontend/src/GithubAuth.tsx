import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { SyncStatus } from "./syncStatus";
import { Chip, Toolbar } from "./ui";

export default function GithubAuth({
  auth,
  busy,
  run,
  onDone,
}: {
  auth: SyncStatus["github_auth"];
  busy: boolean;
  run: (action: string, work: () => Promise<void>) => Promise<void>;
  onDone: (message: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const edited = useRef(false);
  useEffect(() => {
    if (!edited.current) setUsername(auth?.username ?? "");
  }, [auth]);

  function save() {
    return run("github-auth", async () => {
      await api("/sync/github-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          token: token.trim(),
        }),
      });
      setToken("");
      edited.current = false;
      onDone(
        "GitHub 认证已保存；可检查连接或重试克隆。升级时保留原 state 挂载即可继续使用。",
      );
    });
  }

  return (
    <section className="work-area" aria-label="GitHub 认证">
      <div className="work-head">
        <h3>GitHub 认证</h3>
        <p>
          公开仓库可直接克隆；私有仓库读取和所有仓库的备份推送需要相应授权。
        </p>
      </div>
      <p className="muted small">
        <Chip tone={auth?.configured ? "ok" : "muted"}>
          {auth?.configured ? "已保存认证" : "尚未保存认证"}
        </Chip>{" "}
        {auth?.configured && `${auth.username} · ${auth.repository}`}
      </p>
      <div className="form-grid">
        <label className="field">
          GitHub 用户名
          <input
            value={username}
            autoComplete="off"
            disabled={busy}
            onChange={(e) => {
              edited.current = true;
              setUsername(e.target.value);
            }}
          />
        </label>
        <label className="field">
          GitHub Token
          <input
            type="password"
            value={token}
            autoComplete="new-password"
            disabled={busy}
            placeholder={
              auth?.configured
                ? "已保存；更换时填写新 Token"
                : "粘贴 GitHub Personal Access Token"
            }
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
      </div>
      <p className="muted small">
        <a
          href="https://github.com/settings/personal-access-tokens/new"
          target="_blank"
          rel="noreferrer"
        >
          创建 GitHub Token
        </a>
        ：仅选择账本仓库，Contents 权限设为 Read and
        write。公开仓库只读取时可不填写。 这里填写的是 GitHub
        Token，网页登录口令不能用于仓库认证。 Token
        保存后不回显；服务端持久保存，重启或升级无需重填，过期时在此更新。
      </p>
      <Toolbar>
        <button
          disabled={busy || !username.trim() || !token.trim()}
          onClick={() => void save()}
        >
          {auth?.configured ? "更新 GitHub 认证" : "保存 GitHub 认证"}
        </button>
        <button
          className="ghost"
          disabled={busy || !!token}
          onClick={() =>
            void run("check-connection", async () => {
              const result = await api<{ message: string }>(
                "/sync/check-connection",
                { method: "POST" },
              );
              onDone(result.message);
            })
          }
        >
          检查 GitHub 连接
        </button>
        {auth?.configured && (
          <button
            className="ghost"
            disabled={busy}
            onClick={() =>
              void run("github-auth-remove", async () => {
                await api("/sync/github-auth", { method: "DELETE" });
                setToken("");
                setUsername("");
                edited.current = false;
                onDone(
                  "页面保存的 GitHub 认证已移除，账本文件保留；服务端已有的其他认证配置仍可使用。",
                );
              })
            }
          >
            移除 GitHub 认证
          </button>
        )}
      </Toolbar>
    </section>
  );
}
