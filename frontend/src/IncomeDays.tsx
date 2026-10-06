import AccountSelect from "./AccountSelect";
import { useEffect, useRef, useState } from "react";
import { api, type Journal, type Transaction } from "./api";
import {
  money,
  shiftDay,
  shortDay,
  sumByCurrency,
  weekdayShort,
} from "./format";
import { Chip, Empty, Notice } from "./ui";
import type { DraftItem } from "./BatchEditor";

/** 接口返回的逐日记录：区间内每一天都有一行，records 为空表示未记录收益。 */
export interface IncomeDay {
  date: string;
  records: Transaction[];
}

/** 金额一律按十进制字符串校验，非法内容不进入队列也不参与求和。 */
const AMOUNT = /^-?\d+(\.\d+)?$/;

export interface IncomeRange {
  start: string;
  end: string;
}
export interface IncomeAccounts {
  category: string;
  payment: string;
}

/** 只认唯一的余额宝候选；已保存但失效的账户留空，交由用户重新选择。 */
function incomeAccount(
  accounts: Journal["accounts"],
  prefix: string,
  saved?: string,
) {
  const candidates = accounts.filter((a) => a.name.startsWith(prefix));
  if (saved !== undefined)
    return candidates.some((a) => a.name === saved) ? saved : "";
  const matches = candidates.filter((a) =>
    /^(余额宝|余额宝收益|yuebao)$/i.test(a.name.split(":").at(-1)!),
  );
  return matches.length === 1 ? matches[0].name : "";
}

export default function IncomeDays({
  date,
  accounts,
  onAdd,
  onEdit,
  range,
  onRangeChange,
  selectedAccounts,
  onAccountsChange,
}: {
  date: string;
  accounts: Journal["accounts"];
  onAdd: (items: DraftItem[]) => boolean | void;
  onEdit?: (row: Transaction) => void;
  range?: IncomeRange;
  onRangeChange?: (range: IncomeRange) => void;
  selectedAccounts?: IncomeAccounts;
  onAccountsChange?: (accounts: IncomeAccounts) => boolean | void;
}) {
  const [localRange, setLocalRange] = useState<IncomeRange>();
  const selectedRange = onRangeChange ? range : localRange;
  const { start, end } = selectedRange ?? {
    start: shiftDay(date, -6),
    end: date,
  };
  const automatic = !selectedRange;
  const automaticDate = automatic ? date : undefined;
  const [rows, setRows] = useState<IncomeDay[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [localAccounts, setLocalAccounts] = useState<IncomeAccounts>();
  const chosen = onAccountsChange ? selectedAccounts : localAccounts;
  const category = incomeAccount(accounts, "Income:", chosen?.category);
  const payment = incomeAccount(accounts, "Assets:", chosen?.payment);
  function changeAccount(field: keyof IncomeAccounts, value: string) {
    const next = { category, payment, [field]: value };
    if (onAccountsChange) onAccountsChange(next);
    else setLocalAccounts(next);
  }
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const editedRange = useRef(false);
  function changeRange(next: IncomeRange) {
    editedRange.current = true;
    request.current++;
    setRows([]);
    setBusy(false);
    if (onRangeChange) onRangeChange(next);
    else setLocalRange(next);
  }
  async function load() {
    const id = ++request.current;
    setBusy(true);
    setRows([]);
    try {
      const result = await api<IncomeDay[]>(
        `/income/days?start=${start}&end=${end}`,
      );
      if (id !== request.current) return;
      setRows(result);
      setError("");
    } catch (e) {
      if (id === request.current) setError(String(e));
    } finally {
      if (id === request.current) setBusy(false);
    }
  }
  useEffect(() => {
    // 默认区间跟随当天；手选区间仍由「核对日期」拉取，金额按原日期保留。
    if (!editedRange.current || automatic) void load();
    return () => {
      request.current++;
    };
  }, [automaticDate]);
  const blank = rows.filter((r) => !r.records.length);
  const recorded = rows.length - blank.length;
  const filled = blank.filter((r) => (values[r.date] ?? "").trim() !== "");
  const valid = filled.filter((r) =>
    AMOUNT.test((values[r.date] ?? "").trim()),
  );
  const hasInvalid = filled.length !== valid.length;
  const totals = hasInvalid
    ? []
    : sumByCurrency(
        valid.map((r) => ({ amount: values[r.date], currency: "CNY" })),
      );
  const ready = Boolean(category && payment && valid.length);
  return (
    <section className="file-card">
      <div className="work-head">
        <h3>余额宝逐日收益补录</h3>
        <p>
          只填写实际收益，空白不补零、不推算；已有日期请进入更正。支持一次补录多天，统一进入整批预览。
        </p>
      </div>
      <div className="day-toolbar">
        <label className="field">
          <span>收益起始日</span>
          <input
            aria-label="收益起始日"
            type="date"
            value={start}
            onChange={(e) => {
              changeRange({ start: e.target.value, end });
            }}
          />
        </label>
        <label className="field">
          <span>收益结束日</span>
          <input
            aria-label="收益结束日"
            type="date"
            value={end}
            onChange={(e) => {
              changeRange({ start, end: e.target.value });
            }}
          />
        </label>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => void load()}
        >
          核对日期
        </button>
        <span className="muted small push-end">
          已记录 {recorded} 天 · 待补 {blank.length} 天
        </span>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          const added = onAdd(
            valid.map((r) => ({
              business: "yuebao",
              entry: {
                date: r.date,
                amount: values[r.date],
                currency: "CNY",
                category,
                payment,
                payee: "",
                narration: "余额宝收益",
                note: "",
              },
            })),
          );
          if (added === false) return;
          setValues({});
        }}
      >
        <div className="form-grid">
          {[
            [
              "收益账户",
              category,
              (value: string) => changeAccount("category", value),
              "Income:",
            ],
            [
              "收益到账账户",
              payment,
              (value: string) => changeAccount("payment", value),
              "Assets:",
            ],
          ].map(([label, value, set, prefix]) => (
            <label key={String(label)} className="field">
              <span>{String(label)}</span>
              <AccountSelect
                label={String(label)}
                required
                value={String(value)}
                onChange={set as (v: string) => void}
                options={accounts
                  .filter((a) => a.name.startsWith(String(prefix)))
                  .map((a) => ({ value: a.name }))}
              />
            </label>
          ))}
        </div>
        {rows.length ? (
          <div className="day-grid">
            {rows.map((r) => (
              <div
                className={`day-cell${r.records.length ? "" : " missing"}`}
                key={r.date}
              >
                <div className="day-date">
                  <span>{shortDay(r.date)}</span>
                  <span className="day-week">{weekdayShort(r.date)}</span>
                </div>
                {r.records.length ? (
                  <>
                    <Chip tone="ok">已记录</Chip>
                    {r.records.map((row) => (
                      <div key={row.id}>
                        <pre className="result-raw">{row.raw}</pre>
                        <button
                          type="button"
                          className="ghost small"
                          onClick={() => onEdit?.(row)}
                        >
                          更正 {r.date}
                        </button>
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    <Chip tone="warn">未记录</Chip>
                    <label className="field">
                      <span>实际收益 {r.date}</span>
                      <input
                        aria-label={`实际收益 ${r.date}`}
                        value={values[r.date] ?? ""}
                        onChange={(e) =>
                          setValues({ ...values, [r.date]: e.target.value })
                        }
                      />
                    </label>
                  </>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Empty>
            {busy
              ? "正在核对区间内的收益记录……"
              : "尚未核对日期，请点击「核对日期」拉取区间内每一天的收益记录。"}
          </Empty>
        )}
        <div className="split-sum">
          <span className="label">本次补录</span>
          <span>{valid.length} 天</span>
          <span className="label">合计</span>
          <span>
            {totals.length
              ? totals
                  .map((line) => money(line.amount, line.currency))
                  .join(" · ")
              : "待填写有效金额"}
          </span>
        </div>
        <button className="cta" disabled={!ready || busy}>
          将已填收益加入草稿
        </button>
      </form>
    </section>
  );
}
