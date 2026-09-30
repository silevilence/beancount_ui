import { useState } from "react";
import { ApiError, api, type Journal } from "./api";
import { businessLabel, decimalSum, money, signedTone } from "./format";
import { Empty, Facts, Notice, Segmented, Toolbar, type Fact } from "./ui";
import type { DraftItem } from "./BatchEditor";

/** 后端 /api/finance/compose 的响应；余额断言额外带账面与差额。 */
export interface ComposeResult extends DraftItem {
  actual?: string;
  expected?: string;
  difference?: string;
}

/** 三种账户业务的界面标签、提示与账户范围。 */
interface BusinessSpec {
  label: string;
  hint: string;
  /** 对侧账户允许的前缀；余额断言没有对侧账户。 */
  target: string[];
  /** 金额字段在该业务下的标签。 */
  amount: string;
  /** 当前业务的语义说明，显示在表单上方。 */
  help: string;
  button: string;
}

const BUSINESS: Record<string, BusinessSpec> = {
  transfer: {
    label: "转账",
    hint: "资产 / 负债账户之间移动，手续费单列",
    target: ["Assets:", "Liabilities:"],
    amount: "转入金额",
    help: "转入金额是对侧账户实际收到的金额，手续费从转出账户单列。",
    button: "生成分录",
  },
  repayment: {
    label: "信用账户还款",
    hint: "减少信用账户负债，不再计为消费",
    target: ["Liabilities:"],
    amount: "转入金额",
    help: "还款减少信用账户负债，不再计为消费。",
    button: "生成分录",
  },
  balance: {
    label: "余额断言",
    hint: "检查所选日期开始时的余额（含子账户、不含当天交易），核对日终请选次日",
    target: [],
    amount: "预期余额",
    help: "断言只比对账面余额，不生成交易，也不补差或增加 pad；核对日终余额请选次日。",
    button: "核对差额",
  },
};

const SOURCE = ["Assets:", "Liabilities:"];
const FEE = ["Expenses:"];
/** 金额按十进制字符串处理，不接受科学计数法与千分位。 */
const DECIMAL = /^-?\d+(\.\d+)?$/;

/** 账户币种候选：按账户顺序去重，仅作为输入建议。 */
function currencyOptions(accounts: Journal["accounts"]): string[] {
  const seen: Record<string, true> = {};
  const options: string[] = [];
  for (const account of accounts)
    for (const currency of account.currencies)
      if (!seen[currency]) {
        seen[currency] = true;
        options.push(currency);
      }
  return options;
}

export default function Finance({
  date,
  accounts,
  onAdd,
}: {
  date: string;
  accounts: Journal["accounts"];
  onAdd: (item: DraftItem) => boolean | void;
}) {
  const [form, setForm] = useState({
    kind: "transfer",
    account: "",
    target: "",
    amount: "",
    currency: "CNY",
    fee: "0",
    fee_account: "",
    note: "",
  });
  const [result, setResult] = useState<ComposeResult>();
  const [resultDate, setResultDate] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Segmented 的选项直接来自 BUSINESS，因此查表必然命中。
  const spec = BUSINESS[form.kind];
  const currencies = currencyOptions(accounts);

  function change(key: keyof typeof form, value: string) {
    setForm((current) => {
      const next = { ...current, [key]: value };
      // 切换业务后对侧账户可能不再合法，避免留下错选。
      if (key === "kind")
        next.target = BUSINESS[value].target.some((prefix) =>
          next.target.startsWith(prefix),
        )
          ? next.target
          : "";
      return next;
    });
    setResult(undefined);
  }

  function select(
    key: "account" | "target" | "fee_account",
    label: string,
    prefixes: string[],
  ) {
    return (
      <label className="field">
        <span>{label}</span>
        <select
          aria-label={label}
          value={form[key]}
          onChange={(e) => change(key, e.target.value)}
        >
          <option value="">请选择</option>
          {accounts
            .filter((a) => prefixes.some((p) => a.name.startsWith(p)))
            .map((a) => (
              <option key={a.name}>{a.name}</option>
            ))}
        </select>
      </label>
    );
  }

  async function compose() {
    setBusy(true);
    setResult(undefined);
    setError("");
    try {
      setResult(
        await api<ComposeResult>("/finance/compose", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...form, date }),
        }),
      );
      setResultDate(date);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const fee = form.fee.trim() || "0";
  const summable =
    form.kind !== "balance" &&
    DECIMAL.test(form.amount.trim()) &&
    DECIMAL.test(fee);
  const currency = form.currency.trim();
  // 实时合计只作预览，最终金额仍由后端按十进制字符串核对。
  const estimate: Fact[] = [
    {
      label: spec.amount,
      value: summable ? money(form.amount.trim(), currency) : "待填写",
    },
    { label: "手续费", value: summable ? money(fee, currency) : "待填写" },
    {
      label: "转出账户合计（转入金额 + 手续费）",
      value: summable
        ? money(decimalSum([form.amount.trim(), fee]), currency)
        : "待填写",
    },
  ];

  // 结果只属于生成它的日期；日期切换后整块隐藏。
  const shown = result && resultDate === date ? result : undefined;
  const difference = shown?.difference ?? "";
  const differenceTone = difference ? signedTone(difference) : "zero";
  const headLine = shown
    ? shown.business === "balance"
      ? `${form.account || "所选账户"} · ${resultDate} 开始时`
      : `${form.account || "转出账户"} → ${form.target || "对侧账户"}`
    : "";

  return (
    <section className="file-card">
      <div className="work-head">
        <h3>转账、信用账户还款与余额核对</h3>
        <p>三种业务都只组装分录或核对结果，先落到草稿托盘，不直接写账本。</p>
      </div>
      <Segmented
        label="账户业务"
        value={form.kind}
        options={Object.entries(BUSINESS).map(([value, item]) => ({
          value,
          label: item.label,
          hint: item.hint,
        }))}
        onChange={(value) => change("kind", value)}
        disabled={busy}
      />
      <p className="muted small">{spec.help}</p>
      {error && <Notice tone="error">{error}</Notice>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void compose();
        }}
      >
        <fieldset disabled={busy}>
          <div className="form-grid">
            {select(
              "account",
              form.kind === "balance" ? "核对账户" : "转出账户",
              SOURCE,
            )}
            {form.kind !== "balance" &&
              select("target", "转入 / 还款账户", spec.target)}
            <label className="field">
              <span>{spec.amount}</span>
              <input
                aria-label={spec.amount}
                inputMode="decimal"
                placeholder="0.00"
                required
                value={form.amount}
                onChange={(e) => change("amount", e.target.value)}
              />
            </label>
            <label className="field">
              <span>账户币种</span>
              <input
                aria-label="账户币种"
                list="finance-currency"
                required
                value={form.currency}
                onChange={(e) => change("currency", e.target.value)}
              />
            </label>
            {form.kind !== "balance" && (
              <>
                <label className="field">
                  <span>手续费</span>
                  <input
                    aria-label="手续费"
                    inputMode="decimal"
                    placeholder="0"
                    value={form.fee}
                    onChange={(e) => change("fee", e.target.value)}
                  />
                </label>
                {select("fee_account", "手续费分类", FEE)}
              </>
            )}
            <label className="field">
              <span>账户备注</span>
              <input
                aria-label="账户备注"
                placeholder="可留空"
                value={form.note}
                onChange={(e) => change("note", e.target.value)}
              />
            </label>
          </div>
          <datalist id="finance-currency">
            {currencies.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
          {form.kind !== "balance" && <Facts items={estimate} />}
          <Toolbar>
            <button className="cta">{spec.button}</button>
            <span className="muted small">
              金额与币种必填，备注可选，手续费默认 0。
            </span>
          </Toolbar>
        </fieldset>
      </form>
      {shown ? (
        <section className="result-card">
          <div className="result-head">
            <strong>{businessLabel(shown.business)}</strong>
            <span>{headLine}</span>
          </div>
          <pre className="result-raw">{shown.raw}</pre>
          {shown.difference !== undefined && (
            <>
              <Facts
                items={[
                  {
                    label: "预期",
                    value: shown.expected ? money(shown.expected, currency) : "—",
                  },
                  {
                    label: "账面实际",
                    value: shown.actual ? money(shown.actual, currency) : "—",
                  },
                  {
                    label: "差额（实际 − 预期）",
                    value: (
                      <span
                        className={`difference${
                          differenceTone === "zero" ? "" : ` ${differenceTone}`
                        }`}
                      >
                        {money(difference, currency)}
                      </span>
                    ),
                  },
                ]}
              />
              <p className="muted small">
                差额为正说明账面比预期多，为负说明少了；这里不会自动补差或增加 pad。
              </p>
            </>
          )}
          <Toolbar>
            <button
              type="button"
              className="cta"
              onClick={() => {
                if (
                  onAdd({ business: shown.business, raw: shown.raw }) === false
                )
                  return;
                setResult(undefined);
              }}
            >
              将核对结果加入草稿
            </button>
            <span className="muted small">先在草稿托盘核对原文，再统一提交。</span>
          </Toolbar>
        </section>
      ) : (
        <Empty>
          {form.kind === "balance"
            ? "填写核对账户与预期余额后点「核对差额」，这里会列出账面实际与差额。"
            : "填写账户与金额后点「生成分录」，可先在草稿托盘中核对原文。"}
        </Empty>
      )}
    </section>
  );
}
