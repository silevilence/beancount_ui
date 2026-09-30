import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type Journal as JournalView,
  type LedgerStatus,
  type Transaction,
} from "./api";
import BatchEditor, { draftKey } from "./BatchEditor";
import Editor, { readPending } from "./Editor";
import JournalPanel, { type Filters } from "./Journal";
import SyncDialog from "./SyncDialog";
import SyncPanel from "./SyncPanel";
import {
  syncDetail,
  syncLabel,
  syncTone,
  trimReason,
  useSyncSnapshot,
} from "./syncStatus";
import { Chip, Notice } from "./ui";
import {
  byCurrency,
  clockOf,
  dayFull,
  dayRelative,
  money,
  netTotals,
  shanghaiToday,
  shiftDay,
  type AmountLine,
} from "./format";

function Stat({
  label,
  lines,
  value,
  note,
  signed,
}: {
  label: string;
  lines: AmountLine[];
  value?: string;
  note: string;
  signed?: boolean;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      {value !== undefined && <strong className="stat-value">{value}</strong>}
      {value === undefined && lines.length === 0 && (
        <strong className="stat-value">0.00</strong>
      )}
      {value === undefined && lines.length > 0 && (
        <div className="stat-lines">
          {lines.map((line) => (
            <strong
              className={`stat-value ${signed ? (line.amount.startsWith("-") ? "neg" : "pos") : ""}`}
              key={line.currency}
            >
              {money(line.amount, line.currency)}
            </strong>
          ))}
        </div>
      )}
      <small className="stat-note">{note}</small>
    </div>
  );
}

function IncludeTree({
  name,
  graph,
}: {
  name: string;
  graph: Record<string, string[]>;
}) {
  const children = graph[name] ?? [];
  return (
    <li>
      <span className="tree-name">{name}</span>
      {children.length > 0 && (
        <ul>
          {children.map((child) => (
            <IncludeTree key={child} name={child} graph={graph} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** 读取本账本当前草稿笔数，仅用于入口提示；损坏草稿按 0 处理。 */
function countDraft(journal: JournalView): number {
  try {
    const text = localStorage.getItem(draftKey(journal));
    const value = text ? JSON.parse(text) : undefined;
    return Array.isArray(value?.items) ? value.items.length : 0;
  } catch {
    return 0;
  }
}

export default function App() {
  const [batch, setBatch] = useState(false);
  const [ledger, setLedger] = useState<LedgerStatus>();
  const [journal, setJournal] = useState<JournalView>();
  const [day, setDay] = useState(shanghaiToday);
  const [draftFilters, setDraftFilters] = useState<Filters>({
    payee: "",
    narration: "",
    account: "",
  });
  const [filters, setFilters] = useState<Filters>(draftFilters);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [editor, setEditor] = useState<{
    row?: Transaction;
    operation: "create" | "edit" | "delete";
  }>();
  const [hasPending, setHasPending] = useState(() => !!readPending());
  const [drafts, setDrafts] = useState(0);
  const [backupOpen, setBackupOpen] = useState<{ auto: boolean } | null>(null);
  const [updated, setUpdated] = useState<Date>();
  const sync = useSyncSnapshot();
  const sequence = useRef(0);
  const search = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const params = new URLSearchParams({ day, ...filters });
      const [status, view] = await Promise.all([
        api<LedgerStatus>("/ledger"),
        api<JournalView>(`/journal?${params}`),
      ]);
      if (request !== sequence.current) return;
      setLedger(status);
      setJournal(view);
      setUpdated(new Date());
      setError("");
    } catch (e) {
      if (request === sequence.current) setError(String(e));
    }
  }, [day, filters]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      ++sequence.current;
      window.clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (journal) setDrafts(countDraft(journal));
  }, [journal, batch]);
  useEffect(() => {
    const timer = window.setTimeout(() => setFilters(draftFilters), 250);
    return () => window.clearTimeout(timer);
  }, [draftFilters]);
  const visible = journal?.date === day ? journal : undefined;
  const ready = !!ledger?.writable && !error;
  const canCreate = ready && !!visible && !visible.stale;
  const canEditRow = canCreate && !hasPending;
  const openCreate = useCallback(() => {
    if (canCreate) setEditor({ operation: "create" });
  }, [canCreate]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
        return;
      if (event.key === "n") {
        event.preventDefault();
        openCreate();
      } else if (event.key === "b") {
        event.preventDefault();
        if (canEditRow) setBatch(true);
      } else if (event.key === "s") {
        event.preventDefault();
        setBackupOpen({ auto: false });
      } else if (event.key === "/") {
        event.preventDefault();
        search.current?.focus();
      } else if (event.key === "r") {
        event.preventDefault();
        void refresh();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canEditRow, openCreate, refresh]);
  const relative = dayRelative(day);
  const status = error
    ? "连接异常"
    : ledger?.writable
      ? "本地账本已连接"
      : "等待有效账本";
  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">账</span>
          <span>
            日用账本
            <small>THE DAILY LEDGER · 本地记账</small>
          </span>
        </div>
        <div className="topbar-side">
          <span className={`status-chip ${ready ? "ok" : "warn"}`}>
            <span className="dot" />
            {status}
            <small>
              {ledger
                ? `${ledger.files.length} 文件 · ${ledger.entry_count} 条指令`
                : "等待连接"}
            </small>
          </span>
          <button
            className={`status-chip backup ${syncTone(sync.status)}`}
            title="打开备份中心"
            onClick={() => setBackupOpen({ auto: true })}
          >
            <span className="dot" />
            {syncLabel(sync.status)}
            <small>{syncDetail(sync.status)}</small>
          </button>
          <span className="clock">
            {updated ? `更新于 ${clockOf(updated)}` : "正在读取…"}
          </span>
        </div>
      </header>
      <section className="daybar">
        <div className="day-nav">
          <button
            className="ghost square"
            aria-label="前一天"
            onClick={() => setDay(shiftDay(day, -1))}
          >
            ‹
          </button>
          <div className="day-title">
            <strong>{dayFull(day)}</strong>
            <small>
              {relative && <span className="rel">{relative}</span>}
              {day} · Asia/Shanghai
            </small>
          </div>
          <button
            className="ghost square"
            aria-label="后一天"
            onClick={() => setDay(shiftDay(day, 1))}
          >
            ›
          </button>
          <button
            className="ghost"
            disabled={day === shanghaiToday()}
            onClick={() => setDay(shanghaiToday())}
          >
            今天
          </button>
          <label className="field inline">
            <span>记账日期</span>
            <input
              aria-label="记账日期"
              type="date"
              value={day}
              onChange={(e) => {
                if (e.target.value) setDay(e.target.value);
              }}
            />
          </label>
        </div>
        <div className="day-actions">
          <button className="ghost" onClick={() => void refresh()}>
            刷新
          </button>
          <button
            className="ghost"
            disabled={!canEditRow}
            title="集中补记、业务面板与模板"
            onClick={() => setBatch(true)}
          >
            补记工作台
            {drafts > 0 && <Chip tone="warn">{drafts} 笔草稿</Chip>}
          </button>
          <button className="cta" disabled={!canCreate} onClick={openCreate}>
            ＋ 记一笔
          </button>
        </div>
      </section>
      {error && (
        <Notice
          tone="error"
          action={
            <button className="ghost small" onClick={() => void refresh()}>
              重新加载
            </button>
          }
        >
          {error}
          {journal && "。当前为上一次有效视图，无法确认最新状态。"}
        </Notice>
      )}
      {journal?.stale && (
        <Notice tone="warn">
          账本校验失败，以下保留上一次有效视图，已暂停写入。
        </Notice>
      )}
      {sync.status?.blocked && (
        <Notice
          tone="error"
          action={
            <button
              className="ghost small"
              onClick={() => setBackupOpen({ auto: false })}
            >
              打开备份中心
            </button>
          }
        >
          备份已暂停：
          {trimReason(sync.status.error || "仓库存在未完成的合并或冲突")}
          。已保存的记录仍在本地，人工解决后重新同步即可恢复。
        </Notice>
      )}
      {sync.status?.connected && sync.status.error && !sync.status.blocked && (
        <Notice
          tone="warn"
          action={
            <button
              className="ghost small"
              onClick={() => setBackupOpen({ auto: true })}
            >
              打开备份中心
            </button>
          }
        >
          备份未完成：{trimReason(sync.status.error)}
          。已保存的记录仍在本地，无需重复录入。
        </Notice>
      )}
      {!!ledger?.errors.length && (
        <Notice tone="error">
          {ledger.errors.map((item, index) => (
            <span className="diag" key={index}>
              {item.file}:{item.line} · {item.message}
            </span>
          ))}
        </Notice>
      )}
      {hasPending && journal && (
        <Notice
          action={
            <button
              className="ghost small"
              onClick={() => setEditor({ operation: "create" })}
            >
              恢复原请求
            </button>
          }
        >
          有一笔待确认的保存请求，重试不会重复入账。
        </Notice>
      )}
      <section className="summary" aria-label="当日收支">
        <Stat
          label="当日消费"
          lines={byCurrency(visible?.expenses)}
          note="不含转账与还款 · 分币种统计"
        />
        <Stat
          label="当日收入"
          lines={byCurrency(visible?.income)}
          note="涵盖工资与专项收益"
        />
        <Stat
          label="当日净额"
          lines={netTotals(visible?.expenses, visible?.income)}
          note="收入 − 支出，逐币种计算"
          signed
        />
        <Stat
          label="当日记录"
          lines={[]}
          value={visible ? `${visible.transactions.length} 笔` : "—"}
          note={`${dayFull(day)} · 来源含全部包含文件`}
        />
      </section>
      <div className="workspace">
        <JournalPanel
          journal={visible}
          filters={draftFilters}
          onFilter={setDraftFilters}
          searchRef={search}
          canEdit={canEditRow}
          onEdit={(row) => setEditor({ row, operation: "edit" })}
          onDelete={(row) => setEditor({ row, operation: "delete" })}
        />
        <aside className="rail">
          <SyncPanel onOpen={(auto) => setBackupOpen({ auto: !!auto })} />
          <section className="panel card">
            <div className="panel-head">
              <h2>待记便笺</h2>
              <span className="panel-meta">仅本页会话</span>
            </div>
            <p className="muted">临时记下消费或待核对内容，不计入收支。</p>
            <textarea
              aria-label="待记便笺"
              placeholder="先记下商户、金额或待核对的内容…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            {draft && (
              <div className="draft">
                <span className="badge">草稿 · 不计入收支</span>
                <p>{draft}</p>
                <button className="ghost small" onClick={() => setDraft("")}>
                  清除便笺
                </button>
              </div>
            )}
          </section>
          <section className="panel card">
            <div className="panel-head">
              <h2>账本</h2>
              <span className="panel-meta">
                {ledger ? `Beancount ${ledger.version}` : "未连接"}
              </span>
            </div>
            {ledger ? (
              <>
                <dl className="facts">
                  <div>
                    <dt>入口</dt>
                    <dd>{ledger.entry}</dd>
                  </div>
                  <div>
                    <dt>文件</dt>
                    <dd>
                      {ledger.files.length} 个 · {ledger.entry_count} 条指令
                    </dd>
                  </div>
                  <div>
                    <dt>版本</dt>
                    <dd>
                      {ledger.git.branch || "无 Git 仓库"} ·{" "}
                      {ledger.git.commit?.slice(0, 7) || "无提交"}
                    </dd>
                  </div>
                  <div>
                    <dt>本地 Git</dt>
                    <dd>{ledger.git.sync}</dd>
                  </div>
                </dl>
                {!!ledger.git.changes?.length && (
                  <pre className="changes">{ledger.git.changes.join("\n")}</pre>
                )}
                <details className="tree">
                  <summary>包含关系</summary>
                  <ul>
                    <IncludeTree
                      name={ledger.entry}
                      graph={ledger.include_graph}
                    />
                  </ul>
                </details>
                <p className="muted small">
                  未纳入文件：{ledger.unreferenced.join("、") || "无"}
                </p>
              </>
            ) : (
              <p className="muted">正在读取账本信息…</p>
            )}
          </section>
          <section className="panel card">
            <div className="panel-head">
              <h2>快捷键</h2>
              <span className="panel-meta">键盘优先</span>
            </div>
            <ul className="shortcuts">
              <li>
                <kbd>n</kbd> 记一笔
              </li>
              <li>
                <kbd>b</kbd> 补记工作台
              </li>
              <li>
                <kbd>s</kbd> 备份中心
              </li>
              <li>
                <kbd>/</kbd> 聚焦搜索
              </li>
              <li>
                <kbd>r</kbd> 刷新账本
              </li>
              <li>
                <kbd>esc</kbd> 关闭对话框
              </li>
            </ul>
          </section>
        </aside>
      </div>
      <footer className="page-footer">
        日用账本 / 本地记账，日常有据。<span>Asia/Shanghai</span>
      </footer>
      {backupOpen && (
        <SyncDialog
          auto={backupOpen.auto}
          onClose={() => setBackupOpen(null)}
          onChanged={refresh}
        />
      )}
      {batch && journal && (
        <BatchEditor
          journal={journal}
          onClose={() => setBatch(false)}
          onSaved={refresh}
          onEdit={(row) => {
            setBatch(false);
            setEditor({ row, operation: "edit" });
          }}
        />
      )}
      {editor && journal && (
        <Editor
          journal={journal}
          row={editor.row}
          operation={editor.operation}
          onSaved={async () => {
            setHasPending(false);
            await refresh();
          }}
          onClose={() => {
            setEditor(undefined);
            setHasPending(!!readPending());
            void refresh();
          }}
        />
      )}
    </main>
  );
}
