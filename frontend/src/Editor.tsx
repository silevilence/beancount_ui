import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Journal, type Transaction } from "./api";

export const PENDING_KEY = "beancount-ui.pending-save.v1";
interface Fields {
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
  entry?: Fields;
  raw?: string;
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
  const defaults = (): Fields => ({
    date: row?.date || journal.date,
    payee: row?.payee || "",
    narration: row?.narration || "",
    amount: row?.simple ? row.postings[0].amount : "",
    currency: row?.postings[0]?.currency || "CNY",
    category: row?.simple ? row.postings[0].account : "",
    payment: row?.simple ? row.postings[1].account : "",
    note: row?.note || "",
  });
  const [fields, setFields] = useState<Fields>(
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
  const busyRef = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const [accounts, setAccounts] = useState(journal.accounts);
  const [accountError, setAccountError] = useState("");
  const op = pending.current?.request.operation || operation;
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  useEffect(() => {
    let active = true;
    setAccountError("");
    api<Journal>(`/journal?day=${fields.date}`)
      .then((view) => {
        if (active) setAccounts(view.accounts);
      })
      .catch((e) => {
        if (active) setAccountError(String(e));
      });
    return () => {
      active = false;
    };
  }, [fields.date]);
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
  function change(key: keyof Fields, value: string) {
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
        request_id: crypto.randomUUID(),
        revision: baseRevision.current,
        operation,
        transaction_id: row?.id,
        business,
        ...(operation === "delete"
          ? {}
          : advanced
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
        setFields({
          ...fields,
          amount: "",
          payee: "",
          narration: "",
          note: "",
        });
        setRaw("");
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
  const field = (key: keyof Fields, label: string, type = "text") => (
    <label>
      {label}
      <input
        required={["date", "amount", "currency"].includes(key)}
        type={type}
        inputMode={key === "amount" ? "decimal" : undefined}
        value={fields[key]}
        onChange={(e) => change(key, e.target.value)}
      />
    </label>
  );
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
      <div className="section-heading">
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
        <button
          className="quiet"
          onClick={onClose}
          disabled={busy}
          aria-label="关闭编辑"
        >
          关闭
        </button>
      </div>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {uncertain && (
        <p className="notice">
          正在核对原保存请求，内容已锁定。即使上次已经保存，重试也不会重复入账。
        </p>
      )}
      {restored.current && !uncertain && (
        <p className="notice">
          已恢复原预览请求。可继续核验，或取消此预览后重新录入。
        </p>
      )}
      {restored.current && !uncertain && !preview && (
        <button
          className="quiet"
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
          <p>将从原文件移除此交易，其他记录保留。请核对原文和下面的差异。</p>
          <pre>{row?.raw || "请核对已保存的删除预览。"}</pre>
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
              <label>
                业务类型
                <select
                  value={business}
                  onChange={(e) => {
                    invalidate();
                    setBusiness(e.target.value);
                    if (
                      ["salary", "yuebao", "balance"].includes(e.target.value)
                    )
                      setAdvanced(true);
                  }}
                >
                  <option value="ordinary">日常消费 / 转账</option>
                  <option value="phone">话费</option>
                  <option value="salary">工资 / 奖金</option>
                  <option value="yuebao">余额宝收益</option>
                  <option value="balance">余额核对断言</option>
                </select>
              </label>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={advanced}
                disabled={
                  (!!row && !row.simple) ||
                  ["salary", "yuebao", "balance"].includes(business)
                }
                onChange={(e) => {
                  invalidate();
                  setAdvanced(e.target.checked);
                }}
              />
              原文高级编辑
              {row && !row.simple ? "（复杂记录必须保留完整分录）" : ""}
            </label>
            {advanced ? (
              <>
                <label>
                  Beancount 原文
                  <textarea
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
                {field("currency", "币种")}
                <label>
                  支出分类
                  <select
                    required
                    value={fields.category}
                    onChange={(e) => change("category", e.target.value)}
                  >
                    <option value="">请选择分类</option>
                    {accounts
                      .filter((a) => a.name.startsWith("Expenses:"))
                      .map((a) => (
                        <option key={a.name}>{a.name}</option>
                      ))}
                  </select>
                </label>
                <label>
                  付款账户
                  <select
                    required
                    value={fields.payment}
                    onChange={(e) => change("payment", e.target.value)}
                  >
                    <option value="">请选择账户</option>
                    {accounts
                      .filter((a) => /^(Assets|Liabilities):/.test(a.name))
                      .map((a) => (
                        <option key={a.name}>{a.name}</option>
                      ))}
                  </select>
                </label>
                {field("note", "备注")}
              </div>
            )}
          </fieldset>
          {accountError && <p role="alert">账户加载失败：{accountError}</p>}
          {!uncertain && (
            <button type="submit" disabled={busy || !!accountError}>
              {busy ? "正在校验…" : "预览并校验"}
            </button>
          )}
        </form>
      )}
      {op === "delete" && !uncertain && (
        <button disabled={busy} onClick={() => void makePreview()}>
          预览删除影响
        </button>
      )}
      {preview && (
        <section className="preview">
          <h3>保存预览 · {preview.target}</h3>
          <p className="muted">完整候选账本已通过校验。确认后写入本地文件。</p>
          {Object.entries(preview.diffs).map(([file, diff]) => (
            <div key={file}>
              <h4>{file}</h4>
              <pre>{diff}</pre>
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
              className="quiet"
              onClick={() => {
                invalidate();
                if (restored.current) onClose();
              }}
            >
              取消预览，继续修改
            </button>
          )}
        </section>
      )}
    </dialog>
  );
}
