import type { RecordTemplate } from "./businessConfig";
import { inputValues } from "./businessConfig";
import AccountSelect from "./AccountSelect";

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
  accounts: { name: string }[];
  onChange: (values: Record<string, string>) => void;
  disabled?: boolean;
}) {
  const inputs = inputValues(template, values, day);
  return (
    <fieldset className="form-grid" disabled={disabled}>
      {Object.entries(template.fields).map(([key, field]) =>
        field.mode === "input" ? (
          <label className="field" key={key}>
            <span>{field.label}</span>
            {field.type === "account" ? (
              <AccountSelect
                label={field.label}
                required
                value={inputs[key]}
                options={accounts.map((account) => ({ value: account.name }))}
                onChange={(value) => onChange({ ...inputs, [key]: value })}
              />
            ) : (
              <input
                aria-label={field.label}
                type={field.type === "date" ? "date" : "text"}
                inputMode={field.type === "amount" ? "decimal" : undefined}
                maxLength={2000}
                required={field.type !== "text"}
                value={inputs[key]}
                onChange={(e) => onChange({ ...inputs, [key]: e.target.value })}
              />
            )}
          </label>
        ) : (
          <div className="field" key={key}>
            <span>{field.label}</span>
            <span>
              {field.mode === "today"
                ? "保存当天（Asia/Shanghai，预览时确认）"
                : field.value || "空文本"}
            </span>
          </div>
        ),
      )}
    </fieldset>
  );
}
