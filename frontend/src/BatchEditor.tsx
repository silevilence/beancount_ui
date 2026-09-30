import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Journal, type Transaction } from "./api";
import type { EntryFields } from "./Editor";
import Finance from "./Finance";
import IncomeDays from "./IncomeDays";
import Orders from "./Orders";
import SplitFields from "./SplitFields";
import Templates from "./Templates";
import { Notice } from "./ui";

export interface DraftItem { business: string; entry?: EntryFields; raw?: string; order?: { kind: string; purchase?: EntryFields; source_id?: string; date: string; amount: string; account: string; category?: string; note?: string } }
interface Preview { warnings?: string[]; request_id: string; revision: string; diffs: Record<string, string>; items: { item: number; target: string; raw: string }[] }
interface Draft {
  business?: string;
  orderMode?: string;
  advanced?: boolean;
  advancedRaw?: string;
  form: EntryFields;
  items: DraftItem[];
  pending?: { request_id: string; revision: string; items: DraftItem[]; preview?: Preview; uncertain?: boolean };
}
export const draftKey = (journal: Journal) => `beancount-ui.batch.v1.${journal.identity || "default"}`;
const blank = (date: string): EntryFields => ({ date, payee: "", narration: "", amount: "", currency: "CNY", category: "", payment: "", note: "" });

export default function BatchEditor({ journal, onClose, onSaved, onEdit }: { journal: Journal; onClose: () => void; onSaved: () => Promise<void>; onEdit?: (row: Transaction) => void }) {
  const key = draftKey(journal);
  const original = useRef(localStorage.getItem(key));
  const [draft, setDraft] = useState<Draft>(() => {
    try { return original.current ? JSON.parse(original.current) : { form: blank(journal.date), items: [] }; }
    catch { return { form: blank(journal.date), items: [] }; }
  });
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const [accounts, setAccounts] = useState(journal.accounts);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => {
    let active = true;
    api<Journal>(`/journal?day=${draft.form.date}`).then(view => { if (active) setAccounts(view.accounts); }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [draft.form.date]);
  function persist(next: Draft) {
    if (localStorage.getItem(key) !== original.current) throw new Error("另一页面已修改草稿，请关闭并重新打开，避免覆盖。");
    const text = JSON.stringify(next);
    localStorage.setItem(key, text);
    original.current = text;
    setDraft(next);
  }
  function update(next: Draft) { try { persist(next); setError(""); setMessage(""); } catch (e) { setError(`草稿未保存：${String(e)}`); } }
  function change(name: keyof EntryFields, value: string) { update({ ...draft, form: { ...draft.form, [name]: value } }); }
  function add() {
    update({ ...draft, items: [...draft.items, { business: draft.business || "ordinary", ...(draft.advanced ? { raw: draft.advancedRaw || "" } : draft.orderMode && (!draft.business || draft.business === "ordinary") ? { order: { kind: draft.orderMode, purchase: draft.form, date: draft.form.date, amount: draft.form.amount, account: draft.form.payment } } : { entry: draft.form }) }], advancedRaw: "", form: { ...draft.form, amount: "", note: "", splits: [] } });
  }
  async function preview() {
    if (running.current) return;
    running.current = true; setBusy(true); setError("");
    try {
      const view = await api<Journal>(`/journal?day=${draft.form.date}`);
      const pending = draft.pending || { request_id: crypto.randomUUID(), revision: view.revision, items: draft.items };
      persist({ ...draft, pending });
      const result = await api<Preview>("/batch/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request_id: pending.request_id, revision: pending.revision, items: pending.items }) });
      persist({ ...draft, pending: { ...pending, preview: result } });
    } catch (e) { setError(String(e)); }
    finally { running.current = false; setBusy(false); }
  }
  async function save() {
    if (running.current || !draft.pending?.preview) return;
    running.current = true; setBusy(true); setError("");
    const pending = { ...draft.pending, uncertain: true };
    try {
      persist({ ...draft, pending });
      await api("/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request_id: pending.request_id }) });
      persist({ business: draft.business, form: draft.form, items: [] });
      setMessage("整批已入账，等待备份；草稿已清空。可继续补记。");
      await onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.message.includes("预览后")) persist({ ...draft, pending: { ...pending, uncertain: false } });
      setError(`${String(e)} 请重试原请求核对结果。`);
    } finally { running.current = false; setBusy(false); }
  }
  const locked = busy || !!draft.pending;
  const field = (name: keyof EntryFields, label: string, type = "text") => <label className="field"><span>{label}</span><input aria-label={label} type={type} value={String(draft.form[name] ?? "")} onChange={e => change(name, e.target.value)} required={["date", "amount", "currency"].includes(name)} /></label>;
  const account = (name: "category" | "payment", label: string, prefixes: string[]) => <label className="field"><span>{label}</span><select aria-label={label} required value={String(draft.form[name] ?? "")} onChange={e => change(name, e.target.value)}><option value="">请选择</option>{accounts.filter(a => prefixes.some(p => a.name.startsWith(p))).map(a => <option key={a.name}>{a.name}</option>)}</select></label>;
  return <dialog ref={dialog} className="editor-dialog" aria-label="集中补记" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <header className="editor-head"><div><p className="eyebrow">BATCH JOURNAL</p><h2>集中补记</h2></div><button className="ghost" onClick={onClose} disabled={busy}>关闭补记</button></header>
    <p className="muted">日期保持选定值。草稿自动保存在本机浏览器，不计入余额、不参与 Git 备份。Tab 切换字段，Ctrl+Enter 加入草稿。</p>
    {error && <Notice tone="error">{error}</Notice>}{message && <Notice>{message}</Notice>}
    <fieldset disabled={locked}><Finance date={draft.form.date} accounts={accounts} onAdd={item => update({ ...draft, items: [...draft.items, item] })} /><IncomeDays date={draft.form.date} accounts={accounts} onAdd={items => update({ ...draft, items: [...draft.items, ...items] })} onEdit={onEdit} /><Orders date={draft.form.date} accounts={accounts} onAdd={item => update({ ...draft, items: [...draft.items, item] })} /></fieldset>
    <form onSubmit={e => { e.preventDefault(); add(); }} onKeyDown={e => { if (e.ctrlKey && e.key === "Enter" && !locked) { e.preventDefault(); e.currentTarget.requestSubmit(); } }}>
      <fieldset disabled={locked}>
        <label className="check"><input type="checkbox" checked={!!draft.advanced} onChange={e => update({ ...draft, advanced: e.target.checked })} />高级分录录入</label>
        {draft.advanced ? <><label className="field"><span>高级业务路由</span><select value={draft.business || "ordinary"} onChange={e => update({ ...draft, business: e.target.value })}>{[["ordinary", "日常 / 转账"], ["salary", "工资"], ["phone", "话费"], ["yuebao", "余额宝"], ["balance", "余额断言"]].map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label><label className="field"><span>高级 Beancount 原文</span><textarea className="raw-input" aria-label="高级 Beancount 原文" required value={draft.advancedRaw || ""} onChange={e => update({ ...draft, advancedRaw: e.target.value })} /></label><p className="muted">一条完整交易，支持多分录、外币、负折扣、标签 #tag、链接 ^link、交易与 posting 元数据、成本 {'{}'}、价格 @ / @@、省略金额和预算权益分录。原文日期决定路由；余额断言仅允许 balance。整批完整校验通过后才可入账。</p></> : <>
        <Templates journal={journal} fields={draft.form} business={draft.business || "ordinary"} accounts={accounts} onApply={t => update({ ...draft, business: t.business, form: { ...draft.form, payee: t.payee, narration: t.narration, category: t.category, payment: t.payment, currency: t.currency, amount: "", note: "", splits: [] } })} />
        {(!draft.business || draft.business === "ordinary") && <label className="field"><span>购物付款方式</span><select aria-label="购物付款方式" value={draft.orderMode || ""} onChange={e => update({ ...draft, orderMode: e.target.value })}><option value="">普通消费</option><option value="paid">淘宝直接付款</option><option value="deferred">淘宝先挂待付款负债</option></select></label>}
        <p>当前业务：{{ ordinary: "日常消费", salary: "工资 / 奖金", phone: "话费", yuebao: "余额宝收益" }[draft.business || "ordinary"]}</p><div className="form-grid">
        {field("date", "补记日期", "date")}{field("amount", ["salary", "yuebao"].includes(draft.business || "") ? "到账金额" : "实付金额")}{field("payee", "商户")}{field("narration", "摘要")}{field("currency", "币种")}
        {account("category", ["salary", "yuebao"].includes(draft.business || "") ? "收入账户" : "支出分类", [["salary", "yuebao"].includes(draft.business || "") ? "Income:" : "Expenses:"])}{account("payment", ["salary", "yuebao"].includes(draft.business || "") ? "到账账户" : "付款账户", ["Assets:", ...(["salary", "yuebao"].includes(draft.business || "") ? [] : ["Liabilities:"])])}{field("note", draft.business === "salary" ? "工资 / 奖金备注" : "备注")}
      </div>{!["salary", "yuebao"].includes(draft.business || "") && <SplitFields fields={draft.form} accounts={accounts} onChange={form => update({ ...draft, form })} />}</>}<div className="editor-actions"><button type="submit">加入草稿</button><button type="button" className="ghost" disabled={!draft.items.at(-1)?.entry} onClick={() => update({ ...draft, form: { ...draft.items.at(-1)!.entry!, date: draft.form.date } })}>复制上一条</button></div></fieldset>
    </form>
    <section className="preview"><h3>待入账草稿 · {draft.items.length} 笔</h3>{draft.items.map((item, index) => <article className="file-card" key={index}><strong>第 {index + 1} 笔 · {item.entry?.date} {item.entry?.payee} {item.entry?.amount} {item.entry?.currency}</strong>{item.order && <p>订单业务：{item.order.kind} · {item.order.date} · {item.order.amount}</p>}{item.raw && <pre>{item.raw}</pre>}<p>{item.entry?.narration} {item.entry?.note}</p><button className="ghost small" disabled={locked || !!item.order} onClick={() => update({ ...draft, business: item.business, advanced: !!item.raw, advancedRaw: item.raw, form: item.entry || draft.form, items: draft.items.filter((_, i) => i !== index) })}>取回修改</button><button className="ghost small" disabled={locked} onClick={() => update({ ...draft, items: draft.items.filter((_, i) => i !== index) })}>移除</button></article>)}</section>
    {draft.pending?.preview && <section className="preview"><h3>整批预览 · 已校验</h3>{draft.pending.preview.warnings?.map(w => <Notice key={w}>{w}</Notice>)}{draft.pending.preview.items.map(item => <div key={item.item} className="file-card"><strong>第 {item.item} 笔 → {item.target}</strong><pre>{item.raw}</pre></div>)}{Object.entries(draft.pending.preview.diffs).map(([file, diff]) => <details key={file}><summary>{file} 差异</summary><pre className="diff">{diff}</pre></details>)}</section>}
    <footer className="preview-actions"><button disabled={busy || !draft.items.length || !!draft.pending?.uncertain} onClick={() => void preview()}>整批预览并校验</button>{draft.pending && !draft.pending.uncertain && <button className="ghost" disabled={busy} onClick={() => update({ ...draft, pending: undefined })}>取消预览并修改</button>}{draft.pending?.preview && <button disabled={busy} onClick={() => void save()}>{draft.pending.uncertain ? "重试原批次保存" : "确认整批入账"}</button>}</footer>
  </dialog>;
}
