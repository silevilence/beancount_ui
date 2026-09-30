import { useEffect, useState } from "react";
import { ApiError, api, type Journal } from "./api";
import type { EntryFields } from "./Editor";
import { businessLabel } from "./format";
import { Chip, Empty, Facts, Notice, Toolbar, type ChipTone } from "./ui";

/** 快捷模板：只预填商户、摘要、分类与账户，金额和日期每次确认。 */
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

/** 无本地存储或解析失败时的内置模板；分类与账户留空，由用户每次确认。 */
const BUILTINS: Template[] = [
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

const BUSINESS_TONE: Record<string, ChipTone> = {
  ordinary: "muted",
  salary: "income",
  yuebao: "transfer",
  phone: "warn",
};

export default function Templates({
  journal,
  fields,
  business,
  accounts,
  onApply,
  mode = "full",
}: {
  journal: Journal;
  fields: EntryFields;
  business: string;
  accounts: Journal["accounts"];
  onApply: (template: Template) => void;
  mode?: "quick" | "full";
}) {
  const key = `beancount-ui.templates.v1.${journal.identity || "default"}`;
  const [templates, setTemplates] = useState<Template[]>(() => {
    try {
      const raw = localStorage.getItem(key);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? (parsed as Template[]) : BUILTINS;
    } catch {
      return BUILTINS;
    }
  });
  const [recent, setRecent] = useState<Template[]>([]);
  const [name, setName] = useState("");
  const [saveError, setSaveError] = useState("");
  const [recentError, setRecentError] = useState("");
  useEffect(() => {
    let active = true;
    api<Template[]>(`/templates?day=${fields.date}`)
      .then((rows) => {
        if (active) {
          setRecent(rows);
          setRecentError("");
        }
      })
      .catch((e) => {
        if (active)
          setRecentError(
            `推荐加载失败：${e instanceof ApiError ? e.message : String(e)}`,
          );
      });
    return () => {
      active = false;
    };
  }, [fields.date]);
  /** 只有写入成功才替换内存列表，配额不足时保留原样并提示。 */
  function save(next: Template[]) {
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setTemplates(next);
      setSaveError("");
    } catch (e) {
      setSaveError(`模板未保存：${e instanceof ApiError ? e.message : String(e)}`);
    }
  }
  /** 分类与付款账户不在现有科目里时置空，避免套用失效账户。 */
  function apply(template: Template) {
    const names = accounts.map((account) => account.name);
    onApply({
      ...template,
      category: names.includes(template.category) ? template.category : "",
      payment: names.includes(template.payment) ? template.payment : "",
    });
  }
  /** 固定当前表单组合；同名覆盖，便于事后用同名更新模板。 */
  function pin() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const template: Template = {
      name: trimmed,
      business,
      payee: fields.payee,
      narration: fields.narration,
      category: fields.category,
      payment: fields.payment,
      currency: fields.currency,
    };
    save([...templates.filter((old) => old.name !== template.name), template]);
  }
  function toggle(template: Template) {
    save(
      templates.map((old) =>
        old.name === template.name ? { ...old, disabled: !old.disabled } : old,
      ),
    );
  }
  const active = templates.filter((template) => !template.disabled);
  return (
    <section className="template-panel">
      <div className="work-head">
        <h3>快捷模板</h3>
        <p>只预填商户、摘要、分类和账户；金额与日期每次确认。</p>
      </div>
      {saveError && <Notice tone="error">{saveError}</Notice>}
      {recentError && <Notice tone="error">{recentError}</Notice>}
      {active.length ? (
        <Toolbar>
          {active.map((template) => (
            <button
              key={template.name}
              type="button"
              className="chip-btn"
              aria-label={template.name}
              title={[template.payee, template.narration]
                .filter(Boolean)
                .join(" · ")}
              onClick={() => apply(template)}
            >
              {template.name}
              <Chip tone={BUSINESS_TONE[template.business] ?? "muted"}>
                {businessLabel(template.business)}
              </Chip>
            </button>
          ))}
        </Toolbar>
      ) : (
        <Empty>
          {mode === "quick"
            ? "暂无可用的快捷模板。"
            : "模板都已停用，可在下方「模板管理」里重新启用。"}
        </Empty>
      )}
      {mode === "full" && (
        <>
          <div className="work-head">
            <h3>最近常用</h3>
            <p>依据近期有效交易推荐；点击即套用同样的商户、摘要与分类。</p>
          </div>
          {recent.length ? (
            <Toolbar>
              {recent.map((template, index) => (
                <button
                  key={`${template.name}-${index}`}
                  type="button"
                  className="chip-btn"
                  onClick={() => apply(template)}
                >
                  {`${template.payee || template.narration} · ${
                    template.category || "请选择分类"
                  }`}
                </button>
              ))}
            </Toolbar>
          ) : (
            <Empty>最近暂无可用推荐，先记几笔后自动出现。</Empty>
          )}
          <div className="work-head">
            <h3>固定当前组合</h3>
            <p>表单调整后用同名保存即可更新模板。</p>
          </div>
          <label className="field">
            <span>模板名称</span>
            <input
              aria-label="模板名称"
              placeholder="例如：周末采购"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button type="button" className="cta" onClick={pin}>
            将当前组合固定为模板
          </button>
          <Facts
            items={[
              { label: "业务", value: businessLabel(business) },
              { label: "商户", value: fields.payee || "未填写" },
              { label: "摘要", value: fields.narration || "未填写" },
              { label: "分类", value: fields.category || "未选择" },
              { label: "付款账户", value: fields.payment || "未选择" },
              { label: "币种", value: fields.currency },
            ]}
          />
          <div className="work-head">
            <h3>模板管理</h3>
            <p>停用的模板不出现在快捷入口，随时可以启用。</p>
          </div>
          {templates.map((template) => (
            <div
              key={template.name}
              className={`template-row${template.disabled ? " off" : ""}`}
            >
              <span>
                {template.name}{" "}
                <Chip tone={BUSINESS_TONE[template.business] ?? "muted"}>
                  {businessLabel(template.business)}
                </Chip>
              </span>
              <button
                type="button"
                className="ghost small"
                onClick={() => toggle(template)}
              >
                {template.disabled ? "启用" : "停用"}
              </button>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
