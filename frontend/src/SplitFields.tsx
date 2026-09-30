import type { Journal } from "./api";
import type { EntryFields } from "./Editor";
import { decimalSum, money, signedTone } from "./format";
import { Chip, Empty } from "./ui";

/** 明细金额的精确十进制合计；任一项无法解析时返回提示文本。 */
export function decimalTotal(values: string[]): string {
  if (values.some((v) => !/^-?\d+(\.\d{1,8})?$/.test(v)))
    return "待填写有效金额";
  return decimalSum(values);
}

function flip(value: string): string {
  return value.startsWith("-") ? value.slice(1) : `-${value}`;
}

export default function SplitFields({
  fields,
  accounts,
  onChange,
}: {
  fields: EntryFields;
  accounts: Journal["accounts"];
  onChange: (fields: EntryFields) => void;
}) {
  const splits = fields.splits || [];
  const categories = accounts
    .map((account) => account.name)
    .filter((name) => name.startsWith("Expenses:"));
  const total = splits.length ? decimalTotal(splits.map((s) => s.amount)) : "";
  const paid = /^-?\d+(\.\d{1,8})?$/.test(fields.amount) ? fields.amount : "";
  /** 差额 = 实付 − 明细合计；按十进制精确比较，避免 68.5 与 68.50 被判不等。 */
  const difference =
    /^-?\d/.test(total) && paid ? decimalSum([paid, flip(total)]) : "";
  const balanced = difference !== "" && signedTone(difference) === "zero";
  /** 合法十进制才格式化金额，提示文本原样显示。 */
  const asMoney = (value: string) =>
    /^-?\d/.test(value) ? money(value, fields.currency) : value;
  function update(
    index: number,
    key: "category" | "amount" | "note",
    value: string,
  ) {
    onChange({
      ...fields,
      splits: splits.map((s, i) => (i === index ? { ...s, [key]: value } : s)),
    });
  }
  return (
    <section className="split-fields">
      <div className="work-head">
        <h3>商品明细与折扣</h3>
        <p>
          88VIP 只填实付金额；展开明细时优惠填负项，合计必须等于实付，系统不会额外扣减。
        </p>
      </div>
      <button
        type="button"
        className="chip-btn"
        onClick={() =>
          onChange({
            ...fields,
            splits: [
              ...splits,
              { category: fields.category, amount: "", note: "" },
            ],
          })
        }
      >
        {splits.length ? "增加商品 / 折扣项" : "展开商品与折扣明细"}
      </button>
      {splits.map((s, i) => (
        <div className="split-row" key={i}>
          <label className="field">
            <span>分类 {i + 1}</span>
            <select
              aria-label={`分类 ${i + 1}`}
              value={s.category}
              required
              onChange={(e) => update(i, "category", e.target.value)}
            >
              <option value="">请选择</option>
              {categories.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>明细金额 {i + 1}</span>
            <input
              aria-label={`明细金额 ${i + 1}`}
              inputMode="decimal"
              required
              value={s.amount}
              onChange={(e) => update(i, "amount", e.target.value)}
            />
          </label>
          <label className="field">
            <span>商品备注 {i + 1}</span>
            <input
              aria-label={`商品备注 ${i + 1}`}
              value={s.note}
              onChange={(e) => update(i, "note", e.target.value)}
            />
          </label>
          <button
            type="button"
            className="ghost small"
            onClick={() =>
              onChange({
                ...fields,
                splits: splits.filter((_, index) => index !== i),
              })
            }
          >
            移除明细 {i + 1}
          </button>
        </div>
      ))}
      {splits.length === 0 ? (
        <Empty>尚未展开明细：整笔金额按上面选择的分类记账。</Empty>
      ) : (
        <div className="split-sum">
          <span className="label">明细合计</span>
          <span>{asMoney(total)}</span>
          <span className="label">实付</span>
          <span>{paid ? asMoney(paid) : "待填写"}</span>
          {balanced && <Chip tone="ok">合计与实付一致</Chip>}
          {difference && !balanced && (
            <Chip
              tone="warn"
              title="实付金额减去明细合计；负数表示明细超出实付"
            >
              差额 {money(difference, fields.currency)}
            </Chip>
          )}
        </div>
      )}
    </section>
  );
}
