import { normalizeAmount } from "./amounts";
import AccountSelect from "./AccountSelect";
import TextComplete from "./TextComplete";
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
    (p) =>
      p.amount === null ||
      /^-?\d+(\.\d{1,8})?$/.test(normalizeAmount(p.amount)),
  );
  const inferred = postings.some((p) => p.amount === null);
  const priced = postings.some((p) => p.price);
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
          选择账户后自动带入币种，金额带正负号；跨币种交易可填写汇率或换算总价。可将未填价格的一行设为自动推导，最终平衡以预览校验为准。
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
              onChange={(account) => {
                const currencies =
                  accounts.find((a) => a.name === account)?.currencies || [];
                update(i, {
                  account,
                  ...(p.amount !== null &&
                  currencies.length &&
                  !currencies.includes(p.currency)
                    ? { currency: currencies[0] }
                    : {}),
                });
              }}
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
              onBlur={(e) =>
                update(i, { amount: normalizeAmount(e.target.value) })
              }
            />
          </label>
          <label className="field">
            <span>分录币种 {i + 1}</span>
            <TextComplete
              label={`分录币种 ${i + 1}`}
              required
              disabled={p.amount === null}
              options={
                accounts.find((a) => a.name === p.account)?.currencies || []
              }
              value={p.currency}
              onChange={(value) => update(i, { currency: value })}
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
          <label className="field">
            <span>价格换算 {i + 1}</span>
            <select
              aria-label={`价格换算 ${i + 1}`}
              disabled={p.amount === null}
              value={p.price?.kind || ""}
              onChange={(e) =>
                update(i, {
                  price: e.target.value
                    ? {
                        kind: e.target.value as "unit" | "total",
                        amount: p.price?.amount || "",
                        currency: p.price?.currency || "CNY",
                      }
                    : null,
                })
              }
            >
              <option value="">不换算</option>
              <option value="unit">汇率 / 单价（@）</option>
              <option value="total">换算总价（@@）</option>
            </select>
          </label>
          {p.price && (
            <>
              <label className="field">
                <span>
                  {p.price.kind === "unit" ? "汇率 / 单价" : "换算总价"} {i + 1}
                </span>
                <input
                  aria-label={`${p.price.kind === "unit" ? "汇率 / 单价" : "换算总价"} ${i + 1}`}
                  inputMode="decimal"
                  required
                  value={p.price.amount}
                  onBlur={(e) =>
                    update(i, {
                      price: {
                        ...p.price!,
                        amount: normalizeAmount(e.target.value),
                      },
                    })
                  }
                  onChange={(e) =>
                    update(i, {
                      price: { ...p.price!, amount: e.target.value },
                    })
                  }
                />
              </label>
              <label className="field">
                <span>换算币种 {i + 1}</span>
                <input
                  aria-label={`换算币种 ${i + 1}`}
                  required
                  value={p.price.currency}
                  onChange={(e) =>
                    update(i, {
                      price: { ...p.price!, currency: e.target.value },
                    })
                  }
                />
              </label>
            </>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={p.amount === null}
              onChange={(e) =>
                update(
                  i,
                  e.target.checked
                    ? { amount: null, currency: "", price: null }
                    : {
                        amount: "",
                        currency:
                          accounts.find((a) => a.name === p.account)
                            ?.currencies[0] || "CNY",
                      },
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
          : priced
            ? "含价格换算，按换算后的金额校验平衡；以预览结果为准"
            : inferred
              ? "含自动推导分录，最终金额以预览校验为准"
              : totals.map((total) => (
                  <span key={total.currency}>
                    {total.currency} 合计 {money(total.amount, total.currency)}{" "}
                    ·{" "}
                    {signedTone(total.amount) === "zero" ? "已平衡" : "未平衡"}
                  </span>
                ))}
      </div>
    </section>
  );
}
