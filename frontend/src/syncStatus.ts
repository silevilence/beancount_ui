/** GitHub 备份状态：单例轮询，备份卡片、顶栏状态与备份中心共用同一份快照。 */

import { useSyncExternalStore } from "react";
import { api, reasonOf } from "./api";
import { timeAgo } from "./format";

export interface SyncChange {
  file: string;
  status: string;
}

export interface SyncStatus {
  connected: boolean;
  enabled: boolean;
  remote?: string;
  branch: string;
  head?: string;
  error?: string;
  message?: string;
  sync?: string;
  last_success?: string;
  ahead?: number | null;
  interval?: number;
  quiet?: number;
  schedule_reason?: string;
  next_check?: number;
  failures?: number;
  blocked?: boolean;
  pending?: boolean;
  changes: SyncChange[];
}

export interface ConnectPreview {
  revision: string;
  remote: string;
  branch: string;
  ahead?: number | null;
  unreferenced: string[];
  changes: SyncChange[];
  errors: { file: string; line: number; message: string }[];
  diff: string;
}

export interface BackupPreview {
  revision: string;
  head: string;
  files: string[];
  excluded: string[];
  message: string;
  diff: string;
  outgoing_files?: string[];
  outgoing_count?: number | null;
}

export interface SyncSnapshot {
  status?: SyncStatus;
  error: string;
  loading: boolean;
}

const POLL_MS = 5000;

let snapshot: SyncSnapshot = { status: undefined, error: "", loading: true };
let inflight: Promise<void> | undefined;
let timer: number | undefined;
const listeners = new Set<() => void>();

function publish(next: SyncSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** 读取一次备份状态；并发调用共用同一个请求。失败时保留上次快照，只更新错误。 */
export function refreshSync(): Promise<void> {
  inflight ??= request();
  return inflight;
}

async function request(): Promise<void> {
  try {
    const result = await api<SyncStatus>("/sync");
    if (
      typeof result?.connected !== "boolean" ||
      typeof result?.branch !== "string"
    )
      throw new Error("备份状态响应无效");
    publish({ status: result, error: "", loading: false });
  } catch (e) {
    publish({ ...snapshot, error: reasonOf(e), loading: false });
  } finally {
    inflight = undefined;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshSync();
    timer = window.setInterval(() => void refreshSync(), POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

const getSnapshot = () => snapshot;

export function useSyncSnapshot(): SyncSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 仅供测试：丢弃缓存快照与轮询，避免用例之间互相影响。 */
export function resetSync() {
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
  listeners.clear();
  snapshot = { status: undefined, error: "", loading: true };
  inflight = undefined;
}

export type SyncTone = "ok" | "warn" | "danger" | "muted";

/** 状态色调：失败与暂停用红色，待提交 / 待推送用琥珀，已同步用绿色，未接入用灰色。 */
export function syncTone(status?: SyncStatus): SyncTone {
  if (!status) return "muted";
  if (status.blocked || status.error) return "danger";
  if (!status.connected) return "muted";
  return status.sync?.includes("已同步") ? "ok" : "warn";
}

/** 一句状态标题，与后端 sync 标签一致，暂停等人工状态优先。 */
export function syncLabel(status?: SyncStatus): string {
  if (!status) return "备份状态读取中";
  if (status.blocked) return "备份已暂停 · 需人工处理";
  return status.sync || (status.connected ? "已接入" : "尚未接入");
}

/** 顶栏副行：失败原因、待推送数量、最后成功时间按优先级择一。 */
export function syncDetail(status?: SyncStatus): string {
  if (!status) return "等待连接后端";
  if (status.error) return status.error;
  if (status.ahead) return `${status.ahead} 个提交待推送`;
  if (status.last_success) return `最后成功 ${timeAgo(status.last_success)}`;
  if (!status.connected)
    return status.remote ? "尚未确认接入" : "未配置账本远端";
  return "尚无成功备份";
}

/** 后端错误自带句号与分号，拼接时去掉尾部标点，避免界面出现「。。」。 */
export function trimReason(text: string): string {
  return text.replace(/[。；;.]+$/, "");
}

const CHANGE_LABEL: Record<string, string> = {
  M: "已修改",
  A: "新增",
  D: "已删除",
  R: "重命名",
  C: "复制",
  U: "冲突",
  "?": "未纳入 Git",
  "!": "已忽略",
};

/** 把 Git porcelain 状态码翻译成中文标签，如 " M" → 已修改，"??" → 未纳入 Git。 */
export function changeLabel(code: string): string {
  const marks = [code[0], code[1]].filter((mark) => mark && mark !== " ");
  const labels = [...new Set(marks.map((mark) => CHANGE_LABEL[mark] ?? mark))];
  return labels.join(" · ") || "有变更";
}
