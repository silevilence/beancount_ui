import RecordFields from "./RecordFields";
import {
  businessNames,
  businessKind,
  carryTemplateValues,
  inputValues,
  routeLabel,
  templateDay,
  useBusinessConfig,
  type BusinessConfig,
} from "./businessConfig";
import AccountSelect from "./AccountSelect";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Journal, type Transaction } from "./api";
import Diff from "./Diff";
import type { EntryFields } from "./Editor";
import Finance from "./Finance";
import IncomeDays from "./IncomeDays";
import Orders from "./Orders";
import SplitFields from "./SplitFields";
import Templates, { type Template } from "./Templates";
import {
  businessLabel,
  money,
  orderKindLabel,
  shortDay,
  sumByCurrency,
  type AmountLine,
} from "./format";
import { Chip, Empty, Notice, Segmented, Toolbar } from "./ui";
import { requestId } from "./requestId";

export interface DraftItem {
  business: string;
  entry?: EntryFields;
  raw?: string;
  values?: Record<string, string>;
  layout_version?: string;
  order?: {
    kind: string;
    purchase?: EntryFields;
    source_id?: string;
    date: string;
    amount: string;
    account: string;
    category?: string;
    note?: string;
  };
}

interface Preview {
  warnings?: string[];
  request_id: string;
  revision: string;
  diffs: Record<string, string>;
  items: { item: number; target: string; raw: string }[];
}

interface Draft {
  task?: TaskId;
  business?: string;
  orderMode?: string;
  advanced?: boolean;
  advancedRaw?: string;
  templateValues?: Record<string, string>;
  templateVersion?: string;
  form: EntryFields;
  items: DraftItem[];
  pending?: {
    request_id: string;
    revision: string;
    items: DraftItem[];
    preview?: Preview;
    uncertain?: boolean;
  };
}

type TaskId =
  "daily" | "transfer" | "income" | "orders" | "advanced" | "templates";

/** 作业分区：一笔补记只能属于一个作业，草稿托盘按作业计数。 */
const TASKS: { id: TaskId; label: string; hint: string }[] = [
  { id: "daily", label: "日常消费", hint: "支出、工资话费与购物明细" },
  {
    id: "transfer",
    label: "转账 / 还款 / 余额",
    hint: "资产负债移动与余额断言",
  },
  { id: "income", label: "余额宝收益", hint: "逐日补录实际收益" },
  { id: "orders", label: "淘宝订单", hint: "确认收货、部分结算与退款" },
  { id: "advanced", label: "高级分录", hint: "多分录、外币与元数据原文" },
  { id: "templates", label: "模板与推荐", hint: "快捷入口、固定与停用" },
];

/** 表单可以直接录入的业务类型；标签与模板名刻意区分，避免同一屏出现同名按钮。 */
const BUSINESS_CHOICES = [
  { value: "ordinary", label: "日常消费" },
  { value: "salary", label: "工资·奖金" },
  { value: "phone", label: "话费充值" },
  { value: "yuebao", label: "余额宝收益" },
];

export const draftKey = (journal: Journal) =>
  `beancount-ui.batch.v1.${journal.identity || "default"}`;

const blank = (date: string): EntryFields => ({
  date,
  payee: "",
  narration: "",
  amount: "",
  currency: "CNY",
  category: "",
  payment: "",
  note: "",
});

const ORDERS: Record<string, string> = {
  paid: "淘宝直接付款",
  deferred: "淘宝先挂待付款负债",
};

/** 草稿条目归属的作业分区，用于托盘与轨道计数。 */
function taskOf(item: DraftItem): TaskId {
  if (item.values) return "daily";
  if (item.order) return "orders";
  if (item.business === "yuebao") return "income";
  if (item.business === "balance") return "transfer";
  return item.raw ? "advanced" : "daily";
}

function titleOf(item: DraftItem, config?: BusinessConfig): string {
  if (item.values)
    return `模板记录 · ${routeLabel(
      item.business,
      config?.layout.routes[item.business]?.label,
    )}`;
  if (item.entry) return item.entry.payee || item.entry.narration || "一笔记录";
  if (item.order)
    return item.order.purchase
      ? item.order.purchase.payee || item.order.purchase.narration || "一笔购物"
      : `订单${orderKindLabel(item.order.kind)}`;
  return (item.raw || "").split("\n")[0].slice(0, 32) || "高级分录";
}

function amountOf(item: DraftItem): string {
  if (item.entry) return item.entry.amount;
  if (item.order) return item.order.purchase?.amount || item.order.amount;
  return "";
}

function currencyOf(item: DraftItem): string {
  return item.entry?.currency || item.order?.purchase?.currency || "";
}

function labelOf(item: DraftItem): string {
  if (item.order) return orderKindLabel(item.order.kind);
  return item.raw
    ? `${businessLabel(item.business)} · 原文`
    : businessLabel(item.business);
}

export default function BatchEditor({
  journal,
  onClose,
  onSaved,
  onEdit,
}: {
  journal: Journal;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onEdit?: (row: Transaction) => void;
}) {
  const key = draftKey(journal);
  const { config: businessConfig, error: configError } = useBusinessConfig();
  const [initial] = useState(() => {
    try {
      const text = localStorage.getItem(key);
      const value: Draft = text
        ? JSON.parse(text)
        : { form: blank(journal.date), items: [] };
      if (
        !value.form ||
        !Array.isArray(value.items) ||
        typeof value.form.date !== "string"
      )
        throw new Error("草稿格式无效，请保留浏览器存储并核对");
      return { text, value, error: "" };
    } catch (e) {
      return {
        text: null,
        value: { form: blank(journal.date), items: [] } as Draft,
        error: `草稿读取失败：${String(e)}`,
      };
    }
  });
  const original = useRef(initial.text);
  const [draft, setDraft] = useState<Draft>(initial.value);
  const business = draft.business || "ordinary";
  const recordTemplate = businessConfig?.layout.routes[business]?.template;
  const kind = businessKind(business, businessConfig?.layout.routes[business]);
  const balanceRaw = kind === "balance" && !recordTemplate;
  const templateStale =
    !!draft.templateVersion &&
    !!businessConfig &&
    draft.templateVersion !== businessConfig.version;
  const [task, setTask] = useState<TaskId>(initial.value.task || "daily");
  const accountDay = templateDay(
    task === "daily" ? recordTemplate : null,
    draft.templateValues || {},
    draft.form.date,
    businessConfig?.write_day || journal.date,
  );
  const [error, setError] = useState(initial.error);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const preview = useRef<HTMLElement>(null);
  const [accounts, setAccounts] = useState(journal.accounts);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  useEffect(() => {
    let active = true;
    api<Journal>(`/journal?day=${accountDay}`)
      .then((view) => {
        if (active) setAccounts(view.accounts);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [accountDay]);
  useEffect(() => {
    if (draft.pending?.preview) preview.current?.scrollIntoView?.();
  }, [draft.pending?.preview]);
  function persist(next: Draft) {
    if (localStorage.getItem(key) !== original.current)
      throw new Error("另一页面已修改草稿，请关闭并重新打开，避免覆盖。");
    if (initial.error) throw new Error(initial.error);
    const text = JSON.stringify(next);
    localStorage.setItem(key, text);
    original.current = text;
    setDraft(next);
  }
  function update(next: Draft) {
    try {
      persist(next);
      setError("");
      setMessage("");
      return true;
    } catch (e) {
      setError(`草稿未保存：${String(e)}`);
      return false;
    }
  }
  function change(name: keyof EntryFields, value: string) {
    update({
      ...draft,
      form: {
        ...draft.form,
        [name]: value,
        ...(name === "date" ? { category: "", payment: "" } : {}),
      },
    });
  }
  function add(extra: Partial<Draft> = {}) {
    const next = { ...draft, ...extra };
    if (templateStale && !next.advanced) {
      setError("业务配置已变化，请按新配置重新填写后加入草稿。");
      return;
    }
    update({
      ...next,
      items: [
        ...next.items,
        {
          business: next.business || "ordinary",
          ...(recordTemplate && !next.advanced
            ? {
                values: inputValues(
                  recordTemplate,
                  next.templateValues || {},
                  next.form.date,
                ),
                layout_version: businessConfig!.version,
              }
            : next.advanced || balanceRaw
              ? { raw: next.advancedRaw || "" }
              : next.orderMode &&
                  (!next.business || next.business === "ordinary")
                ? {
                    order: {
                      kind: next.orderMode,
                      purchase: next.form,
                      date: next.form.date,
                      amount: next.form.amount,
                      account: next.form.payment,
                    },
                  }
                : { entry: next.form }),
        },
      ],
      advancedRaw: "",
      templateValues: carryTemplateValues(
        recordTemplate,
        next.templateValues || {},
        next.form.date,
      ),
      templateVersion: recordTemplate ? businessConfig!.version : undefined,
      form: { ...next.form, amount: "", note: "", splits: [] },
    });
  }
  async function submitPreview() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const view = await api<Journal>(`/journal?day=${draft.form.date}`);
      const pending = draft.pending || {
        request_id: requestId(),
        revision: view.revision,
        items: draft.items,
      };
      persist({ ...draft, pending });
      const result = await api<Preview>("/batch/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: pending.request_id,
          revision: pending.revision,
          items: pending.items,
        }),
      });
      persist({ ...draft, pending: { ...pending, preview: result } });
    } catch (e) {
      setError(String(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function save() {
    if (running.current || !draft.pending?.preview) return;
    running.current = true;
    setBusy(true);
    setError("");
    const pending = { ...draft.pending, uncertain: true };
    try {
      persist({ ...draft, pending });
      await api("/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: pending.request_id }),
      });
      persist({ ...draft, pending: undefined, items: [] });
      setMessage("整批已入账，等待备份；草稿已清空。可继续补记。");
      await onSaved();
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status === 409 &&
        e.message.includes("预览后")
      )
        persist({ ...draft, pending: { ...pending, uncertain: false } });
      setError(`${String(e)} 请重试原请求核对结果。`);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  function applyTemplate(template: Template) {
    update({
      ...draft,
      task: "daily",
      business: template.business,
      form: {
        ...draft.form,
        payee: template.payee,
        narration: template.narration,
        category: template.category,
        payment: template.payment,
        currency: template.currency,
        amount: "",
        note: "",
        splits: [],
      },
    });
  }
  function recall(index: number) {
    const item = draft.items[index];
    update({
      ...draft,
      task: taskOf(item),
      business: item.business,
      advanced: !!item.raw,
      advancedRaw: item.raw,
      orderMode: item.order?.kind || "",
      form: item.entry || item.order?.purchase || draft.form,
      templateValues: item.values,
      templateVersion: item.layout_version,
      items: draft.items.filter((_, position) => position !== index),
    });
  }
  const locked = busy || !!draft.pending || !!initial.error;
  const last = draft.items.at(-1);
  const businessChoices = [
    ...BUSINESS_CHOICES.map((item) => ({
      ...item,
      label: businessConfig?.layout.routes[item.value]?.label || item.label,
    })),
    ...Object.entries(businessConfig?.layout.routes || {})
      .filter(
        ([key, route]) =>
          !BUSINESS_CHOICES.some((item) => item.value === key) &&
          (key !== "balance" || route.template),
      )
      .map(([key, route]) => ({
        value: key,
        label: route.label || businessNames[key] || key,
      })),
  ];
  const salaryLike = ["salary", "yuebao"].includes(kind);
  const counts = draft.items.reduce<Partial<Record<TaskId, number>>>(
    (sum, item) => {
      const id = taskOf(item);
      sum[id] = (sum[id] ?? 0) + 1;
      return sum;
    },
    {},
  );
  const totals: AmountLine[] = sumByCurrency(
    draft.items.flatMap((item) =>
      item.entry
        ? [{ amount: item.entry.amount, currency: item.entry.currency }]
        : [],
    ),
  );
  const vague = draft.items.filter((item) => !item.entry).length;
  const account = (
    name: "category" | "payment",
    label: string,
    prefixes: string[],
  ) => (
    <label className="field">
      <span>{label}</span>
      <AccountSelect
        label={label}
        required
        value={String(draft.form[name] ?? "")}
        onChange={(value) => change(name, value)}
        options={accounts
          .filter((a) => prefixes.some((p) => a.name.startsWith(p)))
          .map((a) => ({ value: a.name }))}
      />
    </label>
  );
  const field = (name: keyof EntryFields, label: string, type = "text") => (
    <label className="field">
      <span>{label}</span>
      <input
        aria-label={label}
        type={type}
        inputMode={name === "amount" ? "decimal" : undefined}
        value={String(draft.form[name] ?? "")}
        onChange={(e) => change(name, e.target.value)}
        required={["date", "amount", "currency"].includes(name)}
      />
    </label>
  );
  const entryForm = (
    <>
      <div className="work-head">
        <h3>填写一笔</h3>
        <p>Tab 切换字段，Ctrl+Enter 加入草稿；日期保持选定值。</p>
      </div>
      <Segmented
        label="业务类型"
        value={business}
        options={businessChoices}
        onChange={(value) =>
          update({
            ...draft,
            business: value,
            templateValues: {},
            templateVersion: undefined,
          })
        }
        disabled={locked}
      />
      {templateStale && (
        <Notice>
          业务配置已变化，旧填写内容仍保留。请核对新规则后重新填写。
          <button
            type="button"
            className="ghost small"
            onClick={() =>
              update({
                ...draft,
                templateValues: {},
                templateVersion: businessConfig!.version,
              })
            }
          >
            按新配置重新填写
          </button>
        </Notice>
      )}
      {recordTemplate ? (
        <RecordFields
          disabled={templateStale}
          template={recordTemplate}
          values={draft.templateValues || {}}
          day={draft.form.date}
          accounts={accounts}
          onChange={(templateValues) =>
            update({
              ...draft,
              templateValues,
              templateVersion: businessConfig!.version,
            })
          }
        />
      ) : balanceRaw ? (
        <label className="field">
          <span>Beancount 原文</span>
          <textarea
            aria-label="Beancount 原文"
            className="raw-input"
            required
            spellCheck={false}
            value={draft.advancedRaw || ""}
            onChange={(e) => update({ ...draft, advancedRaw: e.target.value })}
          />
          <small>余额业务仅接受一条 balance，不生成补差。</small>
        </label>
      ) : (
        <>
          {business === "ordinary" && (
            <label className="field">
              <span>购物付款方式</span>
              <select
                aria-label="购物付款方式"
                value={draft.orderMode || ""}
                onChange={(e) =>
                  update({ ...draft, orderMode: e.target.value })
                }
              >
                <option value="">普通消费</option>
                {Object.entries(ORDERS).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="form-grid">
            {field("date", "补记日期", "date")}
            {field("amount", salaryLike ? "到账金额" : "实付金额")}
            {field("payee", "商户")}
            {field("narration", "摘要")}
            {field("currency", "币种")}
            {account("category", salaryLike ? "收入账户" : "支出分类", [
              salaryLike ? "Income:" : "Expenses:",
            ])}
            {account("payment", salaryLike ? "到账账户" : "付款账户", [
              "Assets:",
              ...(salaryLike ? [] : ["Liabilities:"]),
            ])}
            {field("note", kind === "salary" ? "工资 / 奖金备注" : "备注")}
          </div>
          {!salaryLike && (
            <SplitFields
              fields={draft.form}
              accounts={accounts}
              onChange={(form) => update({ ...draft, form })}
            />
          )}
        </>
      )}
    </>
  );
  const advancedForm = (
    <>
      <div className="work-head">
        <h3>高级分录原文</h3>
        <p>
          一条完整交易，文件位置遵循业务配置；余额业务只接受一条
          balance。启用记录模板的业务请在「日常消费」填写。
        </p>
      </div>
      <label className="field">
        <span>高级业务路由</span>
        <select
          aria-label="高级业务路由"
          value={business}
          onChange={(e) => update({ ...draft, business: e.target.value })}
        >
          {[
            ...new Set([
              "ordinary",
              "salary",
              "phone",
              "yuebao",
              "balance",
              ...Object.keys(businessConfig?.layout.routes || {}),
            ]),
          ].map((value) => (
            <option key={value} value={value}>
              {routeLabel(value, businessConfig?.layout.routes[value]?.label)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>高级 Beancount 原文</span>
        <textarea
          className="raw-input"
          aria-label="高级 Beancount 原文"
          required
          spellCheck={false}
          value={draft.advancedRaw || ""}
          onChange={(e) => update({ ...draft, advancedRaw: e.target.value })}
        />
      </label>
      <p className="muted small">
        支持多分录、外币、负折扣、标签 #tag、链接 ^link、交易与 posting
        元数据、成本 {"{}"}、价格 @ /
        @@、省略金额和预算权益分录；未经整批完整校验不可入账。
      </p>
    </>
  );
  return (
    <dialog
      ref={dialog}
      className="editor-dialog batch-dialog"
      aria-label="补记工作台"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="editor-head">
        <div>
          <p className="eyebrow">BATCH JOURNAL / 集中补记</p>
          <h2>补记工作台</h2>
        </div>
        <div className="editor-side">
          <div className="item-meta">
            <Chip tone="transfer">{draft.form.date}</Chip>
            <Chip tone={draft.items.length ? "warn" : "muted"}>
              待入账 {draft.items.length} 笔
            </Chip>
            {draft.pending && <Chip tone="warn">已预览待确认</Chip>}
          </div>
          <button className="ghost small" onClick={onClose} disabled={busy}>
            关闭补记
          </button>
        </div>
      </header>
      <p className="muted small">
        草稿自动保存在本机浏览器，按账本隔离，不计入余额也不参与 Git
        备份；全部条目通过校验后才整批写入。
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      <div className="batch-grid">
        <nav className="task-rail" aria-label="作业类型">
          {TASKS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="task"
              aria-current={item.id === task}
              onClick={() => setTask(item.id)}
            >
              {item.label}
              {counts[item.id] ? (
                <span
                  className="task-count"
                  title={`${counts[item.id]} 笔草稿`}
                >
                  {counts[item.id]}
                </span>
              ) : null}
              <small>{item.hint}</small>
            </button>
          ))}
        </nav>
        <section
          className="work-area"
          aria-label={TASKS.find((item) => item.id === task)?.label ?? "补记"}
        >
          {configError && (
            <Notice>业务配置读取失败：{configError}。请关闭后重试。</Notice>
          )}
          {task === "daily" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                add({ advanced: false });
              }}
              onKeyDown={(e) => {
                if (e.ctrlKey && e.key === "Enter" && !locked) {
                  e.preventDefault();
                  e.currentTarget.requestSubmit();
                }
              }}
            >
              <fieldset disabled={locked}>
                {!recordTemplate && (
                  <Templates
                    journal={journal}
                    fields={draft.form}
                    business={business}
                    accounts={accounts}
                    mode="quick"
                    onApply={applyTemplate}
                  />
                )}
                {entryForm}
                <Toolbar>
                  <button type="submit">加入草稿</button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={!last?.entry}
                    onClick={() =>
                      update({
                        ...draft,
                        business: last!.business,
                        orderMode: "",
                        advanced: false,
                        form: { ...last!.entry!, date: draft.form.date },
                      })
                    }
                  >
                    复制上一条
                  </button>
                </Toolbar>
              </fieldset>
            </form>
          )}
          {task === "transfer" && (
            <fieldset disabled={locked}>
              <Finance
                date={draft.form.date}
                accounts={accounts}
                onAdd={(item) =>
                  update({ ...draft, items: [...draft.items, item] })
                }
              />
            </fieldset>
          )}
          {task === "income" && (
            <fieldset disabled={locked}>
              <IncomeDays
                date={draft.form.date}
                accounts={accounts}
                onAdd={(items) =>
                  update({ ...draft, items: [...draft.items, ...items] })
                }
                onEdit={onEdit}
              />
            </fieldset>
          )}
          {task === "orders" && (
            <fieldset disabled={locked}>
              <Orders
                date={draft.form.date}
                accounts={accounts}
                onAdd={(item) =>
                  update({ ...draft, items: [...draft.items, item] })
                }
              />
            </fieldset>
          )}
          {task === "advanced" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                add({ advanced: true });
              }}
              onKeyDown={(e) => {
                if (e.ctrlKey && e.key === "Enter" && !locked) {
                  e.preventDefault();
                  e.currentTarget.requestSubmit();
                }
              }}
            >
              <fieldset disabled={locked}>{advancedForm}</fieldset>
              <Toolbar>
                <button type="submit">加入草稿</button>
              </Toolbar>
            </form>
          )}
          {task === "templates" && (
            <fieldset disabled={locked}>
              <Templates
                journal={journal}
                fields={draft.form}
                business={business}
                accounts={accounts}
                mode="full"
                onApply={applyTemplate}
              />
            </fieldset>
          )}
        </section>
        <aside className="tray" aria-label="待入账草稿">
          <div className="tray-head">
            <h3>待入账草稿</h3>
            <strong>{draft.items.length} 笔</strong>
          </div>
          {totals.length > 0 && (
            <div className="tray-total">
              {totals.map((line) => (
                <span key={line.currency}>
                  {money(line.amount, line.currency)}
                </span>
              ))}
            </div>
          )}
          {vague > 0 && (
            <p className="muted small">
              另有 {vague} 笔订单 / 原文草稿，金额以预览为准。
            </p>
          )}
          {draft.items.length === 0 ? (
            <Empty>还没有草稿：填好后点「加入草稿」，或按 Ctrl+Enter。</Empty>
          ) : (
            <div className="tray-items">
              {draft.items.map((item, index) => (
                <article className="item-card" key={index}>
                  <div className="item-head">
                    <strong>
                      {index + 1}. {titleOf(item, businessConfig)}
                    </strong>
                    {amountOf(item) && (
                      <span className="item-figure">
                        {money(amountOf(item), currencyOf(item))}
                      </span>
                    )}
                  </div>
                  <div className="item-meta">
                    <Chip tone="transfer">
                      {item.values
                        ? routeLabel(
                            item.business,
                            businessConfig?.layout.routes[item.business]?.label,
                          )
                        : labelOf(item)}
                    </Chip>
                    {(item.entry || item.order?.purchase)?.date && (
                      <Chip>{(item.entry || item.order?.purchase)?.date}</Chip>
                    )}
                    {item.values && <Chip>模板 · 日期由模板生成</Chip>}
                  </div>
                  {item.raw && (
                    <details>
                      <summary>查看原文</summary>
                      <pre className="result-raw">{item.raw}</pre>
                    </details>
                  )}
                  <div className="item-actions">
                    <button
                      type="button"
                      className="ghost small"
                      disabled={
                        locked || (!!item.order && !item.order.purchase)
                      }
                      onClick={() => recall(index)}
                    >
                      取回修改
                    </button>
                    <button
                      type="button"
                      className="ghost small"
                      disabled={locked}
                      onClick={() =>
                        update({
                          ...draft,
                          items: draft.items.filter((_, i) => i !== index),
                        })
                      }
                    >
                      移除
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
          <div className="tray-actions">
            <button
              type="button"
              disabled={
                busy || !draft.items.length || !!draft.pending?.uncertain
              }
              onClick={() => void submitPreview()}
            >
              整批预览并校验
            </button>
            {draft.pending && !draft.pending.uncertain && (
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => update({ ...draft, pending: undefined })}
              >
                取消预览并修改
              </button>
            )}
            {draft.pending?.preview && (
              <button type="button" disabled={busy} onClick={() => void save()}>
                {draft.pending.uncertain ? "重试原批次保存" : "确认整批入账"}
              </button>
            )}
          </div>
          <p className="muted small">
            草稿与已入账、备份状态分开：确认后写入本地账本，本阶段不自动上传。
          </p>
        </aside>
      </div>
      {draft.pending?.preview && (
        <section className="preview" ref={preview}>
          <div className="preview-head">
            <h3>整批预览 · 已校验</h3>
            <span className="target">
              {draft.pending.preview.items.length} 笔 ·{" "}
              {Object.keys(draft.pending.preview.diffs).length} 个文件
            </span>
          </div>
          {draft.pending.preview.warnings?.map((warning) => (
            <Notice key={warning}>{warning}</Notice>
          ))}
          <p className="muted small">
            任一错误都会阻止整批写入；确认后共用同一个保存请求，重复点击不会重复入账。
          </p>
          <div className="preview-items">
            {draft.pending.preview.items.map((item) => (
              <article className="preview-item" key={item.item}>
                <div className="item-head">
                  <strong>第 {item.item} 笔</strong>
                  <span className="file">{item.target}</span>
                </div>
                <pre className="result-raw">{item.raw}</pre>
              </article>
            ))}
          </div>
          {Object.entries(draft.pending.preview.diffs).map(([file, diff]) => (
            <div className="file-card" key={file}>
              <h4>{file}</h4>
              <Diff diff={diff} />
            </div>
          ))}
          {Object.keys(draft.pending.preview.diffs).length === 0 && (
            <p className="muted">原文没有变化。</p>
          )}
        </section>
      )}
      <footer className="muted small">
        最近一次核对日期 {shortDay(draft.form.date)}
        ；清除浏览器数据会同时清除草稿。
      </footer>
    </dialog>
  );
}
