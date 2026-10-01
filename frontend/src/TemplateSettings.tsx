import { useRef, useState } from "react";
import {
  fieldIssue,
  renderExample,
  sourceIssue,
  templateSummary,
  type RecordTemplate,
  type TemplateField,
} from "./businessConfig";
import { shanghaiToday } from "./format";
import { Chip, Notice } from "./ui";

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
  fields: { date: { ...standard.date }, amount: { ...standard.amount } },
};
const fullFormSource =
  "{{date}} * {{payee}} {{narration}}\n  {{category}} {{amount}} {{currency}}\n  {{payment}} {{-amount}} {{currency}}\n";

const FIELD_TYPES: Record<TemplateField["type"], string> = {
  date: "日期",
  amount: "金额",
  text: "文本（自动引号）",
  account: "账户",
  currency: "币种",
  token: "标记或标签",
};
const INSERTABLE = ["date", "amount", "payee", "narration", "category", "payment", "currency"];

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
        {
          ...(previous.fields[key] ||
            standard[key] || {
              label: key,
              type: "text",
              mode: "input",
              value: "",
            }),
        },
      ]),
    ),
  };
}

/**
 * 记录模板设置：原文是唯一来源，占位符决定录入表单的字段。
 * 固定内容直接写在原文里；{{name}} 为可配置部分，{{-name}} 取负值。
 */
export default function TemplateSettings({
  name,
  value,
  onChange,
}: {
  name: string;
  value: RecordTemplate | null | undefined;
  onChange: (value: RecordTemplate | null) => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [memory, setMemory] = useState<RecordTemplate>();
  const [renaming, setRenaming] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [message, setMessage] = useState("");

  function patch(key: string, changes: Partial<TemplateField>) {
    onChange({
      ...value!,
      fields: { ...value!.fields, [key]: { ...value!.fields[key], ...changes } },
    });
  }

  function insert(snippet: string) {
    const el = area.current;
    const source = value!.source;
    const focused = !!el && document.activeElement === el;
    const start = focused ? (el.selectionStart ?? source.length) : source.length;
    const end = focused ? (el.selectionEnd ?? start) : start;
    onChange(
      templateWithSource(
        source.slice(0, start) + snippet + source.slice(end),
        value!,
      ),
    );
    const at = start + snippet.length;
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
    });
  }

  function startRename(key: string) {
    setRenaming(key);
    setRenameValue(key);
    setMessage("");
  }

  function commitRename(key: string) {
    const next = renameValue.trim();
    setRenaming("");
    if (next === key) return;
    if (!/^[a-z][a-z0-9_]*$/.test(next)) {
      setMessage("字段名需小写字母开头，可含数字和下划线");
      return;
    }
    if (value!.fields[next]) {
      setMessage(`字段 ${next} 已存在`);
      return;
    }
    const source = value!.source.replace(
      new RegExp(`\\{\\{(-?)${key}\\}\\}`, "g"),
      (_match, sign: string) => `{{${sign}${next}}}`,
    );
    onChange({
      source,
      fields: Object.fromEntries(
        Object.entries(value!.fields).map(([key2, field]) => [
          key2 === key ? next : key2,
          field,
        ]),
      ),
    });
  }

  const summary = value ? templateSummary(value) : undefined;
  const inputs = summary?.input.map((item) => item.field.label).join("、") || "";
  const generated = [
    ...(summary?.fixed ?? []).map(
      (item) => `${item.field.label}=${item.field.value || "（空）"}`,
    ),
    ...(summary?.today ?? []).map((item) => `${item.field.label}=保存当天`),
  ];
  const issue = value ? sourceIssue(value) : "";
  return (
    <section className="template-settings">
      <div className="template-head">
        <h4>记录模板</h4>
        <label className="switch">
          <input
            type="checkbox"
            aria-label={`${name}使用记录模板`}
            checked={!!value}
            onChange={(e) => {
              setMessage("");
              if (e.target.checked) onChange(memory || starterTemplate);
              else {
                setMemory(value || undefined);
                onChange(null);
              }
            }}
          />
          使用记录模板
        </label>
      </div>
      {!value ? (
        <p className="muted small">
          未启用时使用内置表单（日期、金额、商户、摘要、分类账户、付款账户、币种）。启用后录入页面只显示「用户填写」字段，其余内容按原文生成。
          {memory && (
            <button
              type="button"
              className="ghost small"
              onClick={() => {
                setMemory(undefined);
                onChange(memory);
              }}
            >
              恢复上次模板
            </button>
          )}
        </p>
      ) : (
        <>
          <div className="template-grid">
            <div className="template-source">
              <label className="field">
                <span>原文模板</span>
                <textarea
                  ref={area}
                  className="raw-input"
                  aria-label={`${name}原文模板`}
                  spellCheck={false}
                  value={value.source}
                  onChange={(e) =>
                    onChange(templateWithSource(e.target.value, value))
                  }
                />
              </label>
              <div className="toolbar">
                <span className="muted small">插入占位符</span>
                {INSERTABLE.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className="ghost small"
                    title={`插入 {{${key}}} 到光标处`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insert(`{{${key}}}`)}
                  >
                    {standard[key].label}
                  </button>
                ))}
              </div>
              <div className="toolbar">
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => onChange(templateWithSource(fullFormSource, value))}
                >
                  填入完整消费表单示例
                </button>
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => onChange(starterTemplate)}
                >
                  仅日期与金额
                </button>
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => {
                    setMemory(value);
                    onChange(null);
                  }}
                >
                  清除模板
                </button>
              </div>
              <p className="muted small">
                固定内容直接写在原文里；文本字段自动加引号，不要给占位符再加引号。占位符需独立放置，金额取负值用 {"{{-amount}}"}。
              </p>
            </div>
            <div className="template-example">
              <h5>填写示意</h5>
              <pre className="raw-block" aria-label={`${name}填写示意`}>
                {renderExample(value, shanghaiToday())}
              </pre>
              <div className="item-meta">
                <Chip tone="transfer">
                  {inputs ? `录入 ${inputs}` : "无需填写字段"}
                </Chip>
                {generated.length > 0 && <Chip>生成 {generated.join("、")}</Chip>}
              </div>
              <p className="muted small">
                〈…〉是用户填写项，其余按固定值或保存当天生成；实际写入前由服务器再次校验。
              </p>
            </div>
          </div>
          {issue && <Notice tone="warn">{issue}</Notice>}
          {message && <Notice tone="warn">{message}</Notice>}
          <div className="template-fields">
            {Object.entries(value.fields).map(([key, field]) => {
              const problem = fieldIssue(field);
              return (
                <div className="template-field" key={key}>
                  <div className="template-field-head">
                    {renaming === key ? (
                      <input
                        className="rename-input"
                        aria-label={`${key}字段名`}
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => commitRename(key)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitRename(key);
                          }
                          if (e.key === "Escape") setRenaming("");
                        }}
                      />
                    ) : (
                      <code>{`{{${key}}}`}</code>
                    )}
                    <span className="muted small">
                      {FIELD_TYPES[field.type]} ·{" "}
                      {field.mode === "input"
                        ? "用户填写"
                        : field.mode === "fixed"
                          ? "固定值"
                          : "自动当天"}
                    </span>
                    {renaming !== key && (
                      <button
                        type="button"
                        className="ghost small"
                        aria-label={`${key}重命名`}
                        title="改写原文中的占位符名称"
                        onClick={() => startRename(key)}
                      >
                        重命名
                      </button>
                    )}
                  </div>
                  <div className="form-grid">
                    <label className="field">
                      <span>显示名称</span>
                      <input
                        aria-label={`${key}显示名称`}
                        value={field.label}
                        onChange={(e) => patch(key, { label: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span>字段类型</span>
                      <select
                        aria-label={`${key}字段类型`}
                        value={field.type}
                        onChange={(e) =>
                          patch(key, {
                            type: e.target.value as TemplateField["type"],
                            mode: field.mode === "today" ? "input" : field.mode,
                          })
                        }
                      >
                        {Object.entries(FIELD_TYPES).map(([type, text]) => (
                          <option key={type} value={type}>
                            {text}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>填写方式</span>
                      <select
                        aria-label={`${key}填写方式`}
                        value={field.mode}
                        onChange={(e) =>
                          patch(key, {
                            mode: e.target.value as TemplateField["mode"],
                          })
                        }
                      >
                        <option value="input">用户填写</option>
                        <option value="fixed">固定值（不显示输入框）</option>
                        {field.type === "date" && (
                          <option value="today">自动使用保存当天</option>
                        )}
                      </select>
                    </label>
                    {field.mode !== "today" && (
                      <label className="field">
                        <span>{field.mode === "fixed" ? "固定值" : "默认值"}</span>
                        <input
                          aria-label={`${key}${field.mode === "fixed" ? "固定值" : "默认值"}`}
                          type={field.type === "date" ? "date" : "text"}
                          placeholder={
                            field.type === "token" ? "*、!、#tag 或 ^link" : ""
                          }
                          value={field.value}
                          onChange={(e) => patch(key, { value: e.target.value })}
                        />
                      </label>
                    )}
                  </div>
                  {problem && <p className="field-hint warn">{problem}</p>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
