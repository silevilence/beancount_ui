import RecordFields from "./RecordFields";
import {
  businessNames,
  businessKind,
  carryTemplateValues,
  inputValues,
  templateDay,
  useBusinessConfig,
} from "./businessConfig";
import AccountSelect from "./AccountSelect";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Journal, type Transaction } from "./api";
import Diff from "./Diff";
import { expenseGroups, fundingGroups, money } from "./format";
import { Notice } from "./ui";
import { requestId } from "./requestId";

export const PENDING_KEY = "beancount-ui.pending-save.v1";

export interface EntryFields {
  splits?: { category: string; amount: string; note: string }[];
  date: string;
  payee: string;
  narration: string;
  amount: string;
  currency: string;
  category: string;
  payment: string;
  note: string;
}

interface Preview {
  warnings?: string[];
  request_id: string;
  target: string;
  diffs: Record<string, string>;
  status: string;
  revision: string;
}

interface SaveRequest {
  request_id: string;
  revision: string;
  operation: string;
  transaction_id?: string;
  business: string;
  entry?: EntryFields;
  raw?: string;
  values?: Record<string, string>;
  layout_version?: string;
}

interface Pending {
  request: SaveRequest;
  preview?: Preview;
  uncertain?: boolean;
}

export function readPending(): Pending | undefined {
  try {
    const text = localStorage.getItem(PENDING_KEY);
    return text ? (JSON.parse(text) as Pending) : undefined;
  } catch {
    return undefined;
  }
}

const BUSINESSES = [
  { value: "ordinary", label: "日常消费 / 转账" },
  { value: "phone", label: "话费" },
  { value: "salary", label: "工资 / 奖金" },
  { value: "yuebao", label: "余额宝收益" },
  { value: "balance", label: "余额核对断言" },
];

const RAW_ONLY = ["salary", "yuebao", "balance"];

export default function Editor({
  journal,
  row,
  operation,
  onClose,
  onSaved,
}: {
  journal: Journal;
  row?: Transaction;
  operation: "create" | "edit" | "delete";
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const pending = useRef(readPending());
  const restored = useRef(!!pending.current);
  const baseRevision = useRef(journal.revision);
  const defaults = (): EntryFields => ({
    date: row?.date || journal.date,
    payee: row?.payee || "",
    narration: row?.narration || "",
    amount: row?.simple ? row.postings[0].amount : "",
    currency: row?.postings[0]?.currency || "CNY",
    category: row?.simple ? row.postings[0].account : "",
    payment: row?.simple ? row.postings[1].account : "",
    note: row?.note || "",
  });
  const [fields, setFields] = useState<EntryFields>(
    pending.current?.request.entry || defaults,
  );
  const [raw, setRaw] = useState(
    pending.current?.request.raw || row?.raw || "",
  );
  const [advanced, setAdvanced] = useState(
    !!pending.current?.request.raw || (!!row && !row.simple),
  );
  const [business, setBusiness] = useState(
    pending.current?.request.business || "ordinary",
  );
  const [preview, setPreview] = useState(pending.current?.preview);
  const [uncertain, setUncertain] = useState(!!pending.current?.uncertain);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [keepOpen, setKeepOpen] = useState(true);
  const [log, setLog] = useState<{ label: string; amount: string }[]>([]);
  const busyRef = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const [accounts, setAccounts] = useState(journal.accounts);
  const [accountError, setAccountError] = useState("");
  const op = pending.current?.request.operation || operation;
  const { config: businessConfig, error: configError } = useBusinessConfig(
    op === "create",
  );
  const recordTemplate =
    op === "create" ? businessConfig?.layout.routes[business]?.template : null;
  const rawOnly = RAW_ONLY.includes(
    businessKind(business, businessConfig?.layout.routes[business]),
  );
  const [values, setValues] = useState<Record<string, string>>(
    pending.current?.request.values || {},
  );
  const choices = [
    ...BUSINESSES.map((item) => ({
      ...item,
      label: businessConfig?.layout.routes[item.value]?.label || item.label,
    })),
    ...Object.entries(businessConfig?.layout.routes || {})
      .filter(([key]) => !BUSINESSES.some((item) => item.value === key))
      .map(([key, route]) => ({ value: key, label: route.label || key })),
  ];
  const accountDay = templateDay(
    recordTemplate,
    values,
    fields.date,
    businessConfig?.write_day || journal.date,
  );
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  useEffect(() => {
    let active = true;
    setAccountError("");
    api<Journal>(`/journal?day=${accountDay}`)
      .then((view) => {
        if (active) setAccounts(view.accounts);
      })
      .catch((e) => {
        if (active) setAccountError(String(e));
      });
    return () => {
      active = false;
    };
  }, [accountDay]);
  function persist(value: Pending) {
    localStorage.setItem(PENDING_KEY, JSON.stringify(value));
    pending.current = value;
  }
  function invalidate() {
    localStorage.removeItem(PENDING_KEY);
    pending.current = undefined;
    setPreview(undefined);
    setError("");
    setMessage("");
  }
  function change(key: keyof EntryFields, value: string) {
    try {
      invalidate();
      setFields({ ...fields, [key]: value });
    } catch (e) {
      setError(String(e));
    }
  }
  async function makePreview() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const request = pending.current?.request || {
        request_id: requestId(),
        revision: baseRevision.current,
        operation,
        transaction_id: row?.id,
        business,
        ...(operation === "delete"
          ? {}
          : recordTemplate
            ? {
                values: inputValues(recordTemplate, values, fields.date),
                layout_version: businessConfig!.version,
              }
            : advanced || rawOnly
              ? { raw }
              : { entry: fields }),
      };
      persist({ request });
      const result = await api<Preview>("/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      persist({ request, preview: result });
      setPreview(result);
    } catch (e) {
      setError(String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function save() {
    if (busyRef.current || !preview || !pending.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      persist({ ...pending.current, uncertain: true });
      setUncertain(true);
      const saved = await api<Preview>("/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: preview.request_id }),
      });
      baseRevision.current = saved.revision;
      localStorage.removeItem(PENDING_KEY);
      pending.current = undefined;
      setPreview(undefined);
      setUncertain(false);
      restored.current = false;
      await onSaved();
      if (op === "create" && keepOpen) {
        setLog([
          ...log,
          {
            label: recordTemplate
              ? businessConfig?.layout.routes[business]?.label ||
                businessNames[business] ||
                business
              : fields.payee || fields.narration || "一笔记录",
            amount: recordTemplate
              ? "已按模板保存"
              : money(fields.amount, fields.currency),
          },
        ]);
        setFields({
          ...fields,
          amount: "",
          payee: "",
          narration: "",
          note: "",
        });
        setRaw("");
        setValues(carryTemplateValues(recordTemplate, values, fields.date));
        setMessage("已保存到本地账本，可以继续记下一笔。");
      } else onClose();
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status === 409 &&
        e.message.includes("预览后")
      ) {
        persist({ ...pending.current!, uncertain: false });
        setUncertain(false);
        setError(`${e.message}。请关闭编辑、取消旧预览后重新打开记录。`);
      } else setError(`${String(e)} 请使用原请求重试保存；不要重新录入。`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const locked = busy || uncertain || restored.current;
  const names = accounts.map((account) => account.name);
  const currencies = [
    ...new Set(accounts.flatMap((account) => account.currencies)),
  ].sort();
  const field = (key: keyof EntryFields, label: string, type = "text") => (
    <label className="field">
      <span>{label}</span>
      <input
        aria-label={label}
        required={["date", "amount", "currency"].includes(key)}
        type={type}
        inputMode={key === "amount" ? "decimal" : undefined}
        value={String(fields[key] ?? "")}
        onChange={(e) => change(key, e.target.value)}
      />
    </label>
  );
  const step = preview ? (uncertain || busy ? 3 : 2) : 1;
  return (
    <dialog
      ref={dialog}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className="editor-dialog"
      aria-labelledby="editor-title"
    >
      <header className="editor-head">
        <div>
          <p className="eyebrow">LOCAL JOURNAL / 逐笔确认</p>
          <h2 id="editor-title">
            {op === "create"
              ? "随手记一笔"
              : op === "delete"
                ? "删除误记记录"
                : "纠正这笔记录"}
          </h2>
        </div>
        <div className="editor-side">
          <ol className="steps" aria-label="录入步骤">
            {["填写", "预览校验", "写入"].map((name, index) => (
              <li
                key={name}
                className={index + 1 <= step ? "done" : ""}
                aria-current={index + 1 === step ? "step" : undefined}
              >
                {name}
              </li>
            ))}
          </ol>
          <button
            className="ghost small"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭编辑"
          >
            关闭
          </button>
        </div>
      </header>
      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      {configError && (
        <Notice>业务配置读取失败：{configError}。请关闭后重试。</Notice>
      )}
      {uncertain && (
        <Notice>
          正在核对原保存请求，内容已锁定。即使上次已经保存，重试也不会重复入账。
        </Notice>
      )}
      {restored.current && !uncertain && (
        <Notice>已恢复原预览请求。可继续核验，或取消此预览后重新录入。</Notice>
      )}
      {restored.current && !uncertain && !preview && (
        <button
          className="ghost small"
          onClick={() => {
            invalidate();
            onClose();
          }}
        >
          取消未保存请求
        </button>
      )}
      {op === "delete" ? (
        <>
          <p className="muted">
            将从原文件移除此交易，其他记录保留。请核对原文和下面的差异。
          </p>
          <pre className="raw-block">
            {row?.raw || "请核对已保存的删除预览。"}
          </pre>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void makePreview();
          }}
        >
          <fieldset disabled={locked}>
            {operation === "create" && (
              <label className="field">
                <span>业务类型</span>
                <select
                  aria-label="业务类型"
                  value={business}
                  onChange={(e) => {
                    invalidate();
                    setBusiness(e.target.value);
                    setValues({});
                  }}
                >
                  {choices.map((item) => (
                    <option value={item.value} key={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!recordTemplate && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={advanced || rawOnly}
                  disabled={(!!row && !row.simple) || rawOnly}
                  onChange={(e) => {
                    invalidate();
                    setAdvanced(e.target.checked);
                  }}
                />
                原文高级编辑
                {row && !row.simple ? "（复杂记录必须保留完整分录）" : ""}
              </label>
            )}
            {recordTemplate ? (
              <RecordFields
                template={recordTemplate}
                values={values}
                day={fields.date}
                accounts={accounts}
                onChange={(next) => {
                  invalidate();
                  setValues(next);
                }}
              />
            ) : advanced || rawOnly ? (
              <>
                <label className="field">
                  <span>Beancount 原文</span>
                  <textarea
                    aria-label="Beancount 原文"
                    className="raw-input"
                    required
                    value={raw}
                    onChange={(e) => {
                      invalidate();
                      setRaw(e.target.value);
                    }}
                    spellCheck={false}
                  />
                </label>
                <p className="muted">
                  仅一条完整交易；保留成本、价格、标签和元数据。余额业务仅接受
                  balance，不生成补差。
                </p>
              </>
            ) : (
              <div className="form-grid">
                {field("date", "交易日期", "date")}
                {field("amount", "金额")}
                {field("payee", "商户")}
                {field("narration", "摘要")}
                <label className="field">
                  <span>币种</span>
                  <input
                    aria-label="币种"
                    list="currency-options"
                    required
                    value={fields.currency}
                    onChange={(e) => change("currency", e.target.value)}
                  />
                  <datalist id="currency-options">
                    {currencies.map((currency) => (
                      <option value={currency} key={currency} />
                    ))}
                  </datalist>
                </label>
                <label className="field">
                  <span>支出分类</span>
                  <AccountSelect
                    label="支出分类"
                    required
                    value={fields.category}
                    onChange={(value) => change("category", value)}
                    options={expenseGroups(names).flatMap((g) =>
                      g.items.map((name) => ({
                        value: name,
                        label: `${g.label} · ${name}`,
                      })),
                    )}
                  />
                </label>
                <label className="field">
                  <span>付款账户</span>
                  <AccountSelect
                    label="付款账户"
                    required
                    value={fields.payment}
                    onChange={(value) => change("payment", value)}
                    options={fundingGroups(names).flatMap((g) =>
                      g.items.map((name) => ({
                        value: name,
                        label: `${g.label} · ${name}`,
                      })),
                    )}
                  />
                </label>
                {field("note", "备注")}
              </div>
            )}
          </fieldset>
          {accountError && (
            <Notice tone="error">账户加载失败：{accountError}</Notice>
          )}
          {!uncertain && (
            <button type="submit" disabled={busy || !!accountError}>
              {busy ? "正在校验…" : "预览并校验"}
            </button>
          )}
        </form>
      )}
      {op === "delete" && !uncertain && (
        <div className="editor-actions">
          <button disabled={busy} onClick={() => void makePreview()}>
            预览删除影响
          </button>
        </div>
      )}
      {preview && (
        <section className="preview">
          {preview.warnings?.map((w) => (
            <Notice key={w}>{w}</Notice>
          ))}
          <div className="preview-head">
            <h3>保存预览</h3>
            <span className="target">{preview.target}</span>
          </div>
          <p className="muted">完整候选账本已通过校验。确认后写入本地文件。</p>
          {Object.entries(preview.diffs).map(([file, diff]) => (
            <div className="file-card" key={file}>
              <h4>{file}</h4>
              <Diff diff={diff} />
            </div>
          ))}
          {Object.keys(preview.diffs).length === 0 && <p>原文没有变化。</p>}
          {op === "create" && (
            <label className="check">
              <input
                type="checkbox"
                checked={keepOpen}
                onChange={(e) => setKeepOpen(e.target.checked)}
              />
              保存后继续录入（保留日期和账户）
            </label>
          )}
          <div className="editor-actions">
            <button
              disabled={busy || (journal.stale && !uncertain)}
              onClick={() => void save()}
            >
              {busy
                ? "正在保存…"
                : uncertain
                  ? "使用原请求重试保存"
                  : op === "delete"
                    ? "确认删除"
                    : "确认保存"}
            </button>
            {!uncertain && (
              <button
                className="ghost"
                onClick={() => {
                  invalidate();
                  if (restored.current) onClose();
                }}
              >
                取消预览，继续修改
              </button>
            )}
          </div>
        </section>
      )}
      {log.length > 0 && (
        <section className="saved-log">
          <h3>本次已录入</h3>
          <ul>
            {log.map((item, index) => (
              <li key={index}>
                <span>{item.label}</span>
                <strong>{item.amount}</strong>
              </li>
            ))}
          </ul>
        </section>
      )}
    </dialog>
  );
}
