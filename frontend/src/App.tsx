import { useEffect, useState } from 'react';
import { api, type LedgerStatus } from './api';

export default function App() {
  const [ledger, setLedger] = useState<LedgerStatus>();
  const [error, setError] = useState('');
  useEffect(() => { api<LedgerStatus>('/ledger').then(setLedger).catch(e => setError(String(e))); }, []);
  return <main><p className="eyebrow">THE DAILY LEDGER / 日常有据</p><h1>日用账本</h1><p>一笔一笔，记下生活。</p>
    {error && <p role="alert">{error}</p>}
    {ledger && <section><h2>{ledger.writable ? '账本校验通过' : '账本错误 · 暂停写入'}</h2>
      <p>Beancount {ledger.version} · {ledger.files.length} 个文件 · {ledger.entry_count} 条指令</p>
      <p>{ledger.git.branch} {ledger.git.commit?.slice(0, 7)} · {ledger.git.sync}</p>
      {ledger.errors.map((e, i) => <p role="alert" key={i}>{e.file}:{e.line} {e.message}</p>)}
      <details><summary>文件与 include 链</summary><pre>{JSON.stringify(ledger.include_graph, null, 2)}</pre>
        <p>未纳入文件：{ledger.unreferenced.join('、') || '无'}</p>
        <pre>{ledger.git.changes?.join('\n')}</pre></details>
    </section>}
  </main>;
}
