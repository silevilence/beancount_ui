import { useId } from "react";
import AccountSelect from "./AccountSelect";
import {
  inputValues,
  templateSummary,
  type RecordTemplate,
} from "./businessConfig";

/**
 * 记录模板驱动的录入表单：只呈现「用户填写」字段，
 * 固定值、保存当天与币种等由模板生成并在说明中列出。
 */
export default function RecordFields({
  template,
  values,
  day,
  accounts,
  onChange,
  disabled = false,
}: {
  template: RecordTemplate;
  values: Record<string, string>;
  day: string;
  accounts: { name: string; currencies: string[] }[];
  onChange: (values: Record<string, string>) => void;
  disabled?: boolean;
}) {
  const currenciesId = useId();
  const inputs = inputValues(template, values, day);
  const summary = templateSummary(template);
  const currencies = [
    ...new Set(accounts.flatMap((account) => account.currencies)),
  ].sort();
  const generated = [
    ...summary.fixed.map(
      ({ field }) => `${field.label}=${field.value || "空文本"}`,
    ),
    ...summary.today.map(({ field }) => `${field.label}=保存当天`),
  ];
  return (
    <>
      <p className="record-note">
        <span>
          模板表单：
          {summary.input.length > 0
            ? `填写 ${summary.input.map(({ field }) => field.label).join("、")}`
            : "无需填写字段"}
        </span>
        {generated.length > 0 && (
          <span className="muted">由模板生成：{generated.join("、")}</span>
        )}
      </p>
      <fieldset className="form-grid" disabled={disabled}>
        {summary.input.map(({ key, field }) => (
          <label className="field" key={key}>
            <span>
              {field.label}
              {field.value && (
                <small className="field-default">默认 {field.value}</small>
              )}
            </span>
            {field.type === "account" ? (
              <AccountSelect
                label={field.label}
                required
                value={inputs[key]}
                options={accounts.map((account) => ({ value: account.name }))}
                onChange={(value) => onChange({ ...inputs, [key]: value })}
              />
            ) : (
              <>
                <input
                  aria-label={field.label}
                  type={field.type === "date" ? "date" : "text"}
                  inputMode={field.type === "amount" ? "decimal" : undefined}
                  maxLength={2000}
                  required={field.type !== "text"}
                  placeholder={
                    field.type === "token" ? "*、!、#tag 或 ^link" : undefined
                  }
                  list={field.type === "currency" ? currenciesId : undefined}
                  value={inputs[key]}
                  onChange={(e) => onChange({ ...inputs, [key]: e.target.value })}
                />
                {field.type === "currency" && (
                  <datalist id={currenciesId}>
                    {currencies.map((currency) => (
                      <option value={currency} key={currency} />
                    ))}
                  </datalist>
                )}
              </>
            )}
          </label>
        ))}
      </fieldset>
    </>
  );
}
