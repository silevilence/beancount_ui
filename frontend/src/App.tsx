import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Journal, type LedgerStatus } from './api';

export function shanghaiToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export default function App() {
  const [ledger, setLedger] = useState<LedgerStatus>();
  const [journal, setJournal] = useState<Journal>();
  const [day, setDay] = useState(shanghaiToday);
  const [filters, setFilters] = useState({ payee: '', narration: '', account: '' });
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const params = new URLSearchParams({ day, ...filters });
      const [status, view] = await Promise.all([api<LedgerStatus>('/ledger'), api<Journal>(`/journal?${params}`)]);
      if (request !== sequence.current) return;
      setLedger(status); setJournal(view); setError('');
    } catch (e) { if (request === sequence.current) setError(String(e)); }
  }, [day, filters]);
  useEffect(() => {
    void refresh(); const timer = window.setInterval(() => void refresh(), 5000);
    return () => { ++sequence.current; window.clearInterval(timer); };
  }, [refresh]);
  const totals = (value?: Record<string, string>) => Object.entries(value ?? {}).map(([currency, amount]) => `${amount} ${currency}`).join(' / ') || '0.00';
  const visible = journal?.date === day ? journal : undefined;

  return <main>
    <header className="masthead"><a className="brand" href="/">日用<span>账本</span><small>THE DAILY LEDGER</small></a>
      <div className="connection"><span className={`dot ${ledger?.writable && !error ? '' : 'warning'}`} />{error ? '连接异常' : ledger?.writable ? '本地账本已连接' : '等待有效账本'}<small>{ledger?.git.sync || '仅本地访问'}</small></div>
    </header>
    <section className="page-heading"><div><p className="eyebrow">DAY BY DAY / 日常有据</p><h1>把日子，记清楚。</h1><p className="muted">按实际交易日期，整理每一笔收支。</p></div>
      <label className="date-control">记账日期<input aria-label="记账日期" type="date" value={day} onChange={e => { if (e.target.value) setDay(e.target.value); }} /></label>
    </section>
    {error && <div className="notice error" role="alert">{error}。{journal && '当前为旧视图，无法确认最新状态。'}<button onClick={() => void refresh()}>重新加载</button></div>}
    {journal?.stale && <div className="notice error" role="alert">账本校验失败，以下保留上一次有效视图，已暂停写入。</div>}
    {!!ledger?.errors.length && <section className="notice error">{ledger.errors.map((e, i) => <p key={i}>{e.file}:{e.line} · {e.message}</p>)}</section>}
    <section className="totals" aria-label="当日收支"><div><p>当日消费</p><strong>{totals(visible?.expenses)}</strong><small>不含转账与还款 · 不同币种分别统计</small></div>
      <div><p>当日收入</p><strong>{totals(visible?.income)}</strong><small>涵盖工资与专项收益</small></div><div><p>当日记录</p><strong>{visible?.transactions.length ?? '—'} <em>笔</em></strong><small>{day} · Asia/Shanghai</small></div></section>
    <div className="workspace"><section className="journal"><div className="section-heading"><h2>当日流水</h2><span>01 / JOURNAL</span></div>
      <div className="filters">{(['payee', 'narration', 'account'] as const).map((key, i) => <label key={key}>{['商户', '摘要', '账户'][i]}<input value={filters[key]} placeholder={['筛选商户', '搜索摘要', '搜索账户'][i]} onChange={e => setFilters({...filters, [key]: e.target.value})} /></label>)}</div>
      {!visible && <p className="empty">正在读取账本…</p>}
      {visible?.transactions.length === 0 && <p className="empty">这一天还没有匹配的记录。<br/><small>可以切换日期或清空筛选。</small></p>}
      {visible?.transactions.map(row => <article className="transaction" key={row.id}><span className={`type-mark ${row.kind === '收入' ? 'income' : ''}`}>{row.kind === '消费' ? '支' : row.kind === '收入' ? '收' : '转'}</span>
        <div className="transaction-body"><div className="transaction-title"><h3>{row.payee || row.narration}</h3><span>{row.kind}</span></div><p>{row.payee ? row.narration : row.tags.map(t => `#${t}`).join(' ')}</p>
          <div className="postings">{row.postings.map((p, i) => <span key={i}>{p.account} <b>{p.amount} {p.currency}</b></span>)}</div>
          <footer>{row.file}:{row.line} · {visible.sync}</footer>
          <details><summary>查看原文{row.readonly ? ' · 历史导入只读' : row.simple ? '' : ' · 复杂分录'}</summary><pre>{row.raw}</pre></details>
        </div></article>)}
    </section><aside><div className="section-heading"><h2>待记便笺</h2><span>02 / DRAFT</span></div><p className="muted">当前会话的提醒，尚未入账。</p>
      <textarea aria-label="待记便笺" placeholder="先记下商户、金额或待核对的内容…" value={draft} onChange={e => setDraft(e.target.value)} />
      {draft && <div className="draft"><span className="badge">草稿 · 不计入收支</span><p>{draft}</p><button className="quiet" onClick={() => setDraft('')}>清除便笺</button></div>}
      <div className="aside-note"><span>文 本 为 据</span><p>每一笔记录都来自你的 Beancount 文件。保存与备份分别显示，便于核对。</p></div>
    </aside></div>
    {ledger && <details className="ledger-details"><summary>账本信息 · Beancount {ledger.version} · {ledger.files.length} 个文件</summary><p>{ledger.entry} · 分支 {ledger.git.branch || '无 Git 仓库'} · {ledger.git.commit?.slice(0, 7)}</p><pre>{JSON.stringify(ledger.include_graph, null, 2)}</pre><p>未纳入文件：{ledger.unreferenced.join('、') || '无'}</p><pre>{ledger.git.changes?.join('\n')}</pre></details>}
    <footer className="page-footer">日用账本 / 本地记账，日常有据。<span>Asia/Shanghai</span></footer>
  </main>;
}
