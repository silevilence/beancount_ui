import { useEffect, useState } from "react";
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

export default function IncomeDays({
  date,
  accounts,
  onAdd,
  onEdit,
}: {
  date: string;
  accounts: Journal["accounts"];
  onAdd: (items: DraftItem[]) => boolean | void;
  onEdit?: (row: Transaction) => void;
}) {
  const [start, setStart] = useState(shiftDay(date, -6));
  const [end, setEnd] = useState(date);
  const [rows, setRows] = useState<IncomeDay[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [category, setCategory] = useState("");
  const [payment, setPayment] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try {
      setRows(
        await api<IncomeDay[]>(`/income/days?start=${start}&end=${end}`),
      );
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    // 首次显示时自动核对一次；区间变化后由「核对日期」重新拉取。
    void load();
  }, []);
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
              setStart(e.target.value);
              setRows([]);
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
              setEnd(e.target.value);
              setRows([]);
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
            ["收益账户", category, setCategory, "Income:"],
            ["收益到账账户", payment, setPayment, "Assets:"],
          ].map(([label, value, set, prefix]) => (
            <label key={String(label)} className="field">
              <span>{String(label)}</span>
              <select
                aria-label={String(label)}
                required
                value={String(value)}
                onChange={(e) => (set as (v: string) => void)(e.target.value)}
              >
                <option value="">请选择</option>
                {accounts
                  .filter((a) => a.name.startsWith(String(prefix)))
                  .map((a) => (
                    <option key={a.name}>{a.name}</option>
                  ))}
              </select>
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
            {busy ? "正在核对区间内的收益记录……" : "尚未核对日期，请点击「核对日期」拉取区间内每一天的收益记录。"}
          </Empty>
        )}
        <div className="split-sum">
          <span className="label">本次补录</span>
          <span>{valid.length} 天</span>
          <span className="label">合计</span>
          <span>
            {totals.length
              ? totals.map((line) => money(line.amount, line.currency)).join(" · ")
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
