const storageKey = "beancount-ui.access-token";

/** 浏览器禁止会话存储时，仍允许在当前页使用口令。 */
export function saveSessionToken(token: string): boolean {
  try {
    if (token) sessionStorage.setItem(storageKey, token);
    else sessionStorage.removeItem(storageKey);
    return true;
  } catch {
    return false;
  }
}

/** 只在进入页面时消费 URL 凭据，清理地址但保留路由及历史状态。 */
export function takeInitialToken(): string {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  if (url.searchParams.has("token")) {
    url.searchParams.delete("token");
    window.history.replaceState(window.history.state, "", url);
  }
  if (token) return token;
  try {
    return sessionStorage.getItem(storageKey) || "";
  } catch {
    return "";
  }
}
