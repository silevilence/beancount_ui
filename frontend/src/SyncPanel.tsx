import {
  refreshSync,
  syncDetail,
  syncLabel,
  syncTone,
  useSyncSnapshot,
} from "./syncStatus";
import { untilWhen } from "./format";
import { Facts, Notice, Toolbar } from "./ui";

/** 备份卡片：常驻状态摘要与入口，具体流程在「备份中心」对话框完成。 */
export default function SyncPanel({
  onOpen,
}: {
  onOpen: (auto?: boolean) => void;
}) {
  const { status, error } = useSyncSnapshot();
  const tone = syncTone(status);
  const connected = !!status?.connected;
  return (
    <section className="panel card sync-card" aria-label="账本备份">
      <div className="panel-head">
        <h2>GitHub 备份</h2>
        <span className="panel-meta">{status?.branch ?? "master-1"}</span>
      </div>
      <p className={`sync-line ${tone}`}>
        <span className="dot" />
        <strong>{syncLabel(status)}</strong>
        <small>{syncDetail(status)}</small>
      </p>
      {error && (
        <Notice
          tone="warn"
          action={
            <button className="ghost small" onClick={() => void refreshSync()}>
              重试
            </button>
          }
        >
          备份状态读取失败：{error}
        </Notice>
      )}
      {connected ? (
        <Facts
          items={[
            { label: "远端", value: status?.remote ?? "—" },
            {
              label: "待提交",
              value: `${status?.changes.length ?? 0} 个文件`,
            },
            {
              label: "未推送",
              value:
                status?.ahead === null || status?.ahead === undefined
                  ? "需联网核验"
                  : `${status.ahead} 个提交`,
            },
            {
              label: "下次检查",
              value: !status?.enabled
                ? "已关闭"
                : status.next_check
                  ? untilWhen(status.next_check)
                  : "等待调度",
            },
          ]}
        />
      ) : (
        <p className="muted small">
          尚未接入远端仓库；接入只预览 include
          与既有变更，不会覆盖或重新克隆本地文件。
        </p>
      )}
      {!connected && status?.error && (
        <p className="muted small">服务端提示：{status.error}</p>
      )}
      <Toolbar>
        {connected ? (
          <button onClick={() => onOpen(true)}>立即同步</button>
        ) : (
          <button onClick={() => onOpen(false)}>接入 GitHub 仓库</button>
        )}
        <button className="ghost" onClick={() => onOpen(false)}>
          备份中心
        </button>
      </Toolbar>
      <p className="muted small">
        本地保存与远端备份分别确认；备份失败只影响远端，已保存记录仍可查询与继续记账。
      </p>
    </section>
  );
}
