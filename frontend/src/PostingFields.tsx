import AccountSelect from "./AccountSelect";
import type { Journal, PostingLine } from "./api";
import { decimalSum, money, signedTone } from "./format";

export function blankPosting(currency = "CNY"): PostingLine {
  return { account: "", amount: "", currency, note: "" };
}

export default function PostingFields({
  postings,
  accounts,
  onChange,
}: {
  postings: PostingLine[];
  accounts: Journal["accounts"];
  onChange: (postings: PostingLine[]) => void;
}) {
  const valid = postings.every(
    (p) => p.amount === null || /^-?\d+(\.\d{1,8})?$/.test(p.amount),
  );
  const inferred = postings.some((p) => p.amount === null);
  const currencies = [
    ...new Set(
      postings.filter((p) => p.amount !== null).map((p) => p.currency),
    ),
  ];
  const totals = valid
    ? currencies.map((currency) => ({
        currency,
        amount: decimalSum(
          postings
            .filter((p) => p.currency === currency && p.amount !== null)
            .map((p) => p.amount!),
        ),
      }))
    : [];
  function update(index: number, patch: Partial<PostingLine>) {
    onChange(postings.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }
  return (
    <section className="posting-fields">
      <div className="work-head">
        <h3>多行分录</h3>
        <p>
          每行选择账户、填写带正负号的金额；优惠填负数。各币种合计应为零，可将一行设为自动推导。
        </p>
      </div>
      {postings.map((p, i) => (
        <div className="posting-row" key={i}>
          <label className="field">
            <span>分录账户 {i + 1}</span>
            <AccountSelect
              label={`分录账户 ${i + 1}`}
              required
              value={p.account}
              options={accounts.map((a) => ({ value: a.name }))}
              onChange={(account) => update(i, { account })}
            />
          </label>
          <label className="field">
            <span>分录金额 {i + 1}</span>
            <input
              aria-label={`分录金额 ${i + 1}`}
              inputMode="decimal"
              required
              disabled={p.amount === null}
              value={p.amount ?? ""}
              onChange={(e) => update(i, { amount: e.target.value })}
            />
          </label>
          <label className="field">
            <span>分录币种 {i + 1}</span>
            <input
              aria-label={`分录币种 ${i + 1}`}
              required
              disabled={p.amount === null}
              value={p.currency}
              onChange={(e) => update(i, { currency: e.target.value })}
            />
          </label>
          <label className="field">
            <span>分录备注 {i + 1}</span>
            <input
              aria-label={`分录备注 ${i + 1}`}
              value={p.note}
              onChange={(e) => update(i, { note: e.target.value })}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={p.amount === null}
              onChange={(e) =>
                update(
                  i,
                  e.target.checked
                    ? { amount: null, currency: "" }
                    : { amount: "", currency: "CNY" },
                )
              }
            />
            自动推导 {i + 1}
          </label>
          <button
            type="button"
            className="ghost small"
            disabled={postings.length <= 2}
            onClick={() => onChange(postings.filter((_, j) => j !== i))}
          >
            移除分录 {i + 1}
          </button>
        </div>
      ))}
      <button
        type="button"
        className="chip-btn"
        disabled={postings.length >= 100}
        onClick={() =>
          onChange([
            ...postings,
            blankPosting(postings.find((p) => p.currency)?.currency),
          ])
        }
      >
        增加分录
      </button>
      <div className="split-sum" aria-live="polite">
        {!valid
          ? "填写金额后显示合计"
          : inferred
            ? "含自动推导分录，最终金额以预览校验为准"
            : totals.map((total) => (
                <span key={total.currency}>
                  {total.currency} 合计 {money(total.amount, total.currency)} ·{" "}
                  {signedTone(total.amount) === "zero" ? "已平衡" : "未平衡"}
                </span>
              ))}
      </div>
    </section>
  );
}
