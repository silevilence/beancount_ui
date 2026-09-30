import { expect, it } from "vitest";
import {
  changeLabel,
  trimReason,
  syncDetail,
  syncLabel,
  syncTone,
  type SyncStatus,
} from "./syncStatus";

function status(over: Partial<SyncStatus> = {}): SyncStatus {
  return {
    connected: true,
    enabled: false,
    branch: "master-1",
    sync: "已同步",
    changes: [],
    ...over,
  };
}

it("拼接错误文本时去掉后端自带的尾部标点", () => {
  expect(trimReason("本地记录保留。")).toBe("本地记录保留");
  expect(trimReason("远端不可用；")).toBe("远端不可用");
  expect(trimReason("网络不可用")).toBe("网络不可用");
});

it("Git 状态码翻译为中文标签", () => {
  expect(changeLabel(" M")).toBe("已修改");
  expect(changeLabel("MM")).toBe("已修改");
  expect(changeLabel("??")).toBe("未纳入 Git");
  expect(changeLabel("AM")).toBe("新增 · 已修改");
  expect(changeLabel("UU")).toBe("冲突");
  expect(changeLabel("!!")).toBe("已忽略");
  expect(changeLabel("XY")).toBe("X · Y");
  expect(changeLabel("")).toBe("有变更");
});

it("状态色调按失败、暂停、待同步与未接入区分", () => {
  expect(syncTone(undefined)).toBe("muted");
  expect(syncTone(status())).toBe("ok");
  expect(syncTone(status({ sync: undefined }))).toBe("warn");
  expect(syncTone(status({ sync: "已保存 · 待提交" }))).toBe("warn");
  expect(syncTone(status({ connected: false, sync: undefined }))).toBe("muted");
  expect(syncTone(status({ error: "网络不可用" }))).toBe("danger");
  expect(syncTone(status({ blocked: true }))).toBe("danger");
});

it("状态标题与副行按优先级回退", () => {
  expect(syncLabel(undefined)).toBe("备份状态读取中");
  expect(syncLabel(status({ blocked: true }))).toBe("备份已暂停 · 需人工处理");
  expect(syncLabel(status({ sync: undefined }))).toBe("已接入");
  expect(syncLabel(status({ connected: false, sync: undefined }))).toBe(
    "尚未接入",
  );
  expect(syncLabel(status({ sync: "已同步" }))).toBe("已同步");

  expect(syncDetail(undefined)).toBe("等待连接后端");
  expect(syncDetail(status({ error: "网络不可用" }))).toBe("网络不可用");
  expect(syncDetail(status({ ahead: 3 }))).toBe("3 个提交待推送");
  expect(syncDetail(status({ last_success: new Date().toISOString() }))).toBe(
    "最后成功 刚刚",
  );
  expect(syncDetail(status({ sync: undefined }))).toBe("尚无成功备份");
  expect(syncDetail(status({ connected: false, sync: undefined }))).toBe(
    "未配置账本远端",
  );
  expect(
    syncDetail(
      status({ connected: false, sync: undefined, remote: "origin.git" }),
    ),
  ).toBe("尚未确认接入");
});
