import type { EntryFields } from "./Editor";
import type { Journal } from "./api";

export function decimalTotal(values: string[]): string {
  if (values.some(v => !/^-?\d+(\.\d{1,8})?$/.test(v))) return "待填写有效金额";
  const total = values.reduce((n, v) => { const [whole, fraction = ""] = v.replace("-", "").split("."); return n + BigInt(whole + fraction.padEnd(8, "0")) * (v.startsWith("-") ? -1n : 1n); }, 0n);
  const digits = (total < 0n ? -total : total).toString().padStart(9, "0");
  return `${total < 0n ? "-" : ""}${digits.slice(0, -8)}.${digits.slice(-8)}`.replace(/0+$/, "").replace(/\.$/, "");
}

export default function SplitFields({ fields, accounts, onChange }: { fields: EntryFields; accounts: Journal["accounts"]; onChange: (fields: EntryFields) => void }) {
  const splits = fields.splits || [];
  function update(index: number, key: "category" | "amount" | "note", value: string) { onChange({ ...fields, splits: splits.map((s, i) => i === index ? { ...s, [key]: value } : s) }); }
  return <section className="split-fields"><p className="muted">88VIP 默认只记实付金额；展开明细时优惠填负项，合计必须等于实付，系统不会额外扣减优惠。</p>
    <button type="button" className="ghost small" onClick={() => onChange({ ...fields, splits: [...splits, { category: fields.category, amount: "", note: "" }] })}>{splits.length ? "增加商品 / 折扣项" : "展开商品与折扣明细"}</button>
    {splits.map((s, i) => <div key={i} className="file-card form-grid"><label className="field"><span>分类 {i + 1}</span><select aria-label={`分类 ${i + 1}`} value={s.category} required onChange={e => update(i, "category", e.target.value)}><option value="">请选择</option>{accounts.filter(a => a.name.startsWith("Expenses:")).map(a => <option key={a.name}>{a.name}</option>)}</select></label><label className="field"><span>明细金额 {i + 1}</span><input aria-label={`明细金额 ${i + 1}`} required value={s.amount} onChange={e => update(i, "amount", e.target.value)} /></label><label className="field"><span>商品备注 {i + 1}</span><input aria-label={`商品备注 ${i + 1}`} value={s.note} onChange={e => update(i, "note", e.target.value)} /></label><button type="button" className="ghost small" onClick={() => onChange({ ...fields, splits: splits.filter((_, index) => index !== i) })}>移除明细 {i + 1}</button></div>)}
    {!!splits.length && <p>明细合计：{decimalTotal(splits.map(s => s.amount))} {fields.currency} · 实付：{fields.amount || "待填写"}</p>}
  </section>;
}
