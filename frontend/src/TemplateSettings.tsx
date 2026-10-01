import type { RecordTemplate, TemplateField } from "./businessConfig";

const standard: Record<string, TemplateField> = {
  date: { label: "交易日期", type: "date", mode: "input", value: "" },
  amount: { label: "金额", type: "amount", mode: "input", value: "" },
  payee: { label: "商户", type: "text", mode: "input", value: "" },
  narration: { label: "摘要", type: "text", mode: "input", value: "" },
  category: { label: "分类账户", type: "account", mode: "input", value: "" },
  payment: { label: "付款账户", type: "account", mode: "input", value: "" },
  currency: { label: "币种", type: "currency", mode: "fixed", value: "CNY" },
};
export const starterTemplate: RecordTemplate = {
  source:
    '{{date}} * "消费"\n  Expenses:Food {{amount}} CNY\n  Assets:Cash {{-amount}} CNY\n',
  fields: { date: standard.date, amount: standard.amount },
};
export function templateWithSource(
  source: string,
  previous: RecordTemplate,
): RecordTemplate {
  const keys = [
    ...new Set(
      [...source.matchAll(/\{\{-?([a-z][a-z0-9_]*)\}\}/g)].map((m) => m[1]),
    ),
  ];
  return {
    source,
    fields: Object.fromEntries(
      keys.map((key) => [
        key,
        previous.fields[key] ||
          standard[key] || {
            label: key,
            type: "text",
            mode: "input",
            value: "",
          },
      ]),
    ),
  };
}
export default function TemplateSettings({
  value,
  onChange,
  name,
}: {
  value: RecordTemplate | null | undefined;
  onChange: (value: RecordTemplate | null) => void;
  name: string;
}) {
  function field(key: string, patch: Partial<TemplateField>) {
    onChange({
      ...value!,
      fields: { ...value!.fields, [key]: { ...value!.fields[key], ...patch } },
    });
  }
  return (
    <details className="template-settings">
      <summary>{name}记录模板与填写项</summary>
      <label className="check">
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked ? starterTemplate : null)}
        />
        {name}使用记录模板
      </label>
      {value && (
        <>
          <p className="muted">
            固定内容直接写在原文里；可配置部分用 {"{{name}}"}
            。文本字段自动加引号，请勿在占位符外再加引号。金额取负值用{" "}
            {"{{-amount}}"}。标记或标签字段需填写有效默认值，如 *、#tag 或
            ^link。
          </p>
          <button
            type="button"
            className="ghost small"
            onClick={() =>
              onChange(
                templateWithSource(
                  "{{date}} * {{payee}} {{narration}}\n  {{category}} {{amount}} {{currency}}\n  {{payment}} {{-amount}} {{currency}}\n",
                  { source: "", fields: {} },
                ),
              )
            }
          >
            填入完整消费表单示例
          </button>
          <label className="field">
            {name}原文模板
            <textarea
              className="raw-input"
              value={value.source}
              onChange={(e) =>
                onChange(templateWithSource(e.target.value, value))
              }
              spellCheck={false}
            />
          </label>
          <p className="muted small">
            示例中的账户需改为你的有效账户。启用模板后，新建记录统一通过模板表单提交；原文和其他业务入口不能绕过固定字段。历史更正保留原文编辑。
          </p>
          {Object.entries(value.fields).map(([key, f]) => (
            <div className="template-field" key={key}>
              <strong>{`{{${key}}}`}</strong>
              <div className="form-grid">
                <label className="field">
                  {key}字段名称
                  <input
                    value={f.label}
                    onChange={(e) => field(key, { label: e.target.value })}
                  />
                </label>
                <label className="field">
                  {key}字段类型
                  <select
                    value={f.type}
                    onChange={(e) =>
                      field(key, {
                        type: e.target.value as TemplateField["type"],
                        mode: f.mode === "today" ? "input" : f.mode,
                      })
                    }
                  >
                    {Object.entries({
                      date: "日期",
                      amount: "金额",
                      text: "文本（自动引号）",
                      account: "账户",
                      currency: "币种",
                      token: "标记或标签（*、!、#tag、^link）",
                    }).map(([key, text]) => (
                      <option key={key} value={key}>
                        {text}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  {key}填写方式
                  <select
                    value={f.mode}
                    onChange={(e) =>
                      field(key, {
                        mode: e.target.value as TemplateField["mode"],
                      })
                    }
                  >
                    <option value="input">用户填写</option>
                    <option value="fixed">固定值（不可修改）</option>
                    {f.type === "date" && (
                      <option value="today">自动使用保存当天</option>
                    )}
                  </select>
                </label>
                {f.mode !== "today" && (
                  <label className="field">
                    {key}
                    {f.mode === "fixed" ? "固定值" : "默认值"}
                    <input
                      type={f.type === "date" ? "date" : "text"}
                      value={f.value}
                      onChange={(e) => field(key, { value: e.target.value })}
                    />
                  </label>
                )}
              </div>
            </div>
          ))}
        </>
      )}
    </details>
  );
}
