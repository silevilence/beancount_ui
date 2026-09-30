import { useEffect, useState } from "react";
import { api, type Journal } from "./api";
import type { EntryFields } from "./Editor";
import { Notice } from "./ui";

export interface Template {
  name: string;
  business: string;
  payee: string;
  narration: string;
  category: string;
  payment: string;
  currency: string;
  disabled?: boolean;
}
const builtins: Template[] = [
  ["淘宝 / 88VIP", "ordinary", "淘宝", "88VIP每日红包"],
  ["超市", "ordinary", "超市", "食材"],
  ["餐饮", "ordinary", "", "餐饮"],
  ["水电费", "ordinary", "", "水电费"],
  ["余额宝", "yuebao", "", "余额宝收益"],
  ["工资 / 奖金", "salary", "", "工资"],
  ["话费", "phone", "", "话费"],
].map(([name, business, payee, narration]) => ({
  name,
  business,
  payee,
  narration,
  category: "",
  payment: "",
  currency: "CNY",
}));

export default function Templates({
  journal,
  fields,
  business,
  accounts,
  onApply,
}: {
  journal: Journal;
  fields: EntryFields;
  business: string;
  accounts: Journal["accounts"];
  onApply: (template: Template) => void;
}) {
  const key = `beancount-ui.templates.v1.${journal.identity || "default"}`;
  const [templates, setTemplates] = useState<Template[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) || "null") || builtins;
    } catch {
      return builtins;
    }
  });
  const [recent, setRecent] = useState<Template[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<Template[]>(`/templates?day=${fields.date}`)
      .then((rows) => {
        if (active) setRecent(rows);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [fields.date]);
  function save(next: Template[]) {
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setTemplates(next);
      setError("");
    } catch (e) {
      setError(`模板未保存：${String(e)}`);
    }
  }
  function apply(t: Template) {
    const names = accounts.map((a) => a.name);
    onApply({
      ...t,
      category: names.includes(t.category) ? t.category : "",
      payment: names.includes(t.payment) ? t.payment : "",
    });
  }
  function pin() {
    if (!name.trim()) return;
    const t = {
      name: name.trim(),
      business,
      payee: fields.payee,
      narration: fields.narration,
      category: fields.category,
      payment: fields.payment,
      currency: fields.currency,
    };
    save([...templates.filter((old) => old.name !== t.name), t]);
  }
  return (
    <section className="template-panel">
      <h3>快捷模板</h3>
      <p className="muted">
        仅预填商户、摘要、分类和账户；金额与日期每次确认。调整表单后使用同名保存即可更新模板。
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="template-buttons">
        {templates
          .filter((t) => !t.disabled)
          .map((t) => (
            <button
              type="button"
              className="ghost small"
              key={t.name}
              onClick={() => apply(t)}
            >
              {t.name}
            </button>
          ))}
      </div>
      <details>
        <summary>最近常用与模板管理</summary>
        <div className="template-buttons">
          {recent.map((t, i) => (
            <button
              type="button"
              className="ghost small"
              key={i}
              onClick={() => apply(t)}
            >
              {t.payee || t.narration} · {t.category || "请选择分类"}
            </button>
          ))}
        </div>
        <label className="field">
          <span>模板名称</span>
          <input
            aria-label="模板名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button type="button" onClick={pin}>
          将当前组合固定为模板
        </button>
        {templates.map((t) => (
          <div key={t.name}>
            {t.name}{" "}
            <button
              type="button"
              className="ghost small"
              onClick={() =>
                save(
                  templates.map((x) =>
                    x === t ? { ...x, disabled: !x.disabled } : x,
                  ),
                )
              }
            >
              {t.disabled ? "启用" : "停用"}
            </button>
          </div>
        ))}
      </details>
    </section>
  );
}
