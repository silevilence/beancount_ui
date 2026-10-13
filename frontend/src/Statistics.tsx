import { useEffect, useRef, useState } from "react";
import { money } from "./format";
import { Empty, Notice, Segmented } from "./ui";
import { useToday } from "./useToday";
import StatisticsRanking from "./StatisticsRanking";
import {
  presetRange,
  useReportResource,
  type Bucket,
  type Grain,
  type Preset,
  type Report,
  type ReportDetails,
  type Totals,
} from "./statisticsData";
import "./statistics.css";

const labels = { income: "收入", expenses: "支出", net: "净额" };
const presets = [
  { value: "week", label: "本周" },
  { value: "month", label: "本月" },
  { value: "year", label: "今年" },
  { value: "recent", label: "最近 30 天" },
  { value: "custom", label: "自定义" },
];

function periodLabel(bucket: { start: string; end: string }) {
  return bucket.start === bucket.end
    ? bucket.start
    : `${bucket.start} 至 ${bucket.end}`;
}

function Trend({
  report,
  onSelect,
}: {
  report: Report;
  onSelect: (bucket: Bucket) => void;
}) {
  const [mode, setMode] = useState("both");
  const [hovered, setHovered] = useState<Bucket>();
  const keys: (keyof Totals)[] =
    mode === "net" ? ["net"] : ["income", "expenses"];
  // Numbers are used only for drawing coordinates; displayed values remain decimal strings.
  const values = report.buckets.flatMap((b) =>
    keys.map((key) => Number(b[key])),
  );
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const y = (value: number) => 24 + ((max - value) / (max - min)) * 190;
  const width = Math.max(720, report.buckets.length * 66 + 64);
  const step = (width - 64) / report.buckets.length;
  const current =
    hovered && report.buckets.find((b) => b.start === hovered.start);
  return (
    <section className="panel stats-trend" aria-label="收支趋势">
      <div className="stats-panel-head">
        <div>
          <span className="stats-eyebrow">随时间变化</span>
          <h2>收支趋势</h2>
        </div>
        <Segmented
          label="图表内容"
          value={mode}
          onChange={setMode}
          options={[
            { value: "both", label: "收入 / 支出" },
            { value: "net", label: "净额走势" },
          ]}
        />
      </div>
      <div className="stats-legend">
        {keys.map((key) => (
          <span key={key} className={key}>
            <i />
            {labels[key]}
          </span>
        ))}
        <span>单位：{report.currency || "—"} · 点击时段查看流水</span>
      </div>
      <div
        className="stats-chart-scroll"
        tabIndex={0}
        aria-label="趋势图，可横向滚动"
      >
        <svg
          width={width}
          height="270"
          viewBox={`0 0 ${width} 270`}
          aria-label="收支金额图"
        >
          {[max, 0, ...(min < 0 ? [min] : [])].map((value, index) => (
            <g key={index}>
              <line
                x1="54"
                x2={width}
                y1={y(value)}
                y2={y(value)}
                className={value === 0 ? "stats-zero" : "stats-grid"}
              />
              {(value === 0 || Math.abs(y(value) - y(0)) >= 18) && (
                <text
                  x="48"
                  y={y(value) - 5}
                  textAnchor="end"
                  className="stats-axis"
                >
                  {value.toLocaleString("zh-CN", {
                    maximumFractionDigits: 1,
                    notation: "compact",
                  })}
                </text>
              )}
            </g>
          ))}
          {report.buckets.map((bucket, index) => {
            const x = 64 + index * step + step / 2;
            const title = `${periodLabel(bucket)}，${keys.map((key) => `${labels[key]} ${money(bucket[key], report.currency)}`).join("，")}`;
            return (
              <g
                key={bucket.start}
                className="stats-period"
                role="button"
                tabIndex={0}
                aria-label={title}
                onClick={() => onSelect(bucket)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(bucket);
                  }
                }}
                onMouseEnter={() => setHovered(bucket)}
                onFocus={() => setHovered(bucket)}
              >
                <title>{title}</title>
                <rect
                  x={x - step / 2}
                  y="10"
                  width={step}
                  height="247"
                  fill="transparent"
                  className="stats-hit"
                />
                {keys.map((key, i) => {
                  const value = Number(bucket[key]);
                  const barX = x + (keys.length === 2 ? i * 17 - 16 : -7);
                  return (
                    <rect
                      key={key}
                      x={barX}
                      y={Math.min(y(0), y(value))}
                      width="14"
                      height={Math.max(
                        value === 0 ? 1 : 2,
                        Math.abs(y(value) - y(0)),
                      )}
                      rx="2"
                      className={`stats-bar ${key}`}
                    />
                  );
                })}
                <text x={x} y="242" textAnchor="middle" className="stats-axis">
                  {bucket.start.slice(5)}
                </text>
                {report.grain !== "day" && (
                  <text
                    x={x}
                    y="259"
                    textAnchor="middle"
                    className="stats-axis"
                  >
                    至 {bucket.end.slice(5)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <p className="stats-readout" aria-live="polite">
        {current
          ? `${periodLabel(current)} · 收入 ${money(current.income, report.currency)} · 支出 ${money(current.expenses, report.currency)} · 净额 ${money(current.net, report.currency)}`
          : "悬停或用键盘选中时段查看精确金额；周按周一开始，边界仅统计所选日期。"}
      </p>
    </section>
  );
}

export interface DetailSelection {
  start: string;
  end: string;
  account?: string;
}

function Details({
  report,
  selected,
  onClose,
  onRefresh,
}: {
  report: Report;
  selected: DetailSelection;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const params = new URLSearchParams({
    start: selected.start,
    end: selected.end,
    currency: report.currency,
    revision: report.view_revision,
    account: selected.account || "",
  });
  const resource = useReportResource<ReportDetails>(
    `/statistics/details?${params}`,
    report.revision,
  );
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section className="panel stats-details" aria-label="统计流水">
      <div className="stats-panel-head">
        <div>
          <span className="stats-eyebrow">核对每一笔</span>
          <h2 ref={heading} tabIndex={-1}>
            {selected.account || "时段流水"}
          </h2>
          <p className="muted">
            {periodLabel(selected)} · {report.currency}
          </p>
        </div>
        <button className="ghost" onClick={onClose}>
          返回图表
        </button>
      </div>
      {resource.error && (
        <Notice
          tone="error"
          action={
            <button
              className="ghost small"
              onClick={() => {
                resource.retry();
                onRefresh();
              }}
            >
              刷新并重试
            </button>
          }
        >
          {resource.error}
          {resource.data && "。当前明细为上一次有效视图。"}
        </Notice>
      )}
      {!resource.data && !resource.error && <p role="status">正在读取流水…</p>}
      {resource.data?.stale && (
        <Notice tone="warn">账本校验失败，明细来自上一次有效视图。</Notice>
      )}
      {resource.data && resource.data.transactions.length === 0 && (
        <Empty>该时段没有所选币种的收支流水。</Empty>
      )}
      {resource.data?.transactions.map((row) => (
        <article className="stats-transaction" key={row.id}>
          <div className="stats-transaction-title">
            <time>{row.date}</time>
            <strong>{row.payee || "未填写商户"}</strong>
            <span>{row.narration}</span>
          </div>
          <ul>
            {row.contributions.map((p, index) => (
              <li key={index}>
                <span>
                  {p.account}
                  {p.note && <small> · {p.note}</small>}
                </span>
                <strong className={p.kind}>
                  {labels[p.kind]} {money(p.amount, p.currency)}
                </strong>
              </li>
            ))}
          </ul>
          <details>
            <summary>
              查看原文 · {row.file}:{row.line}
            </summary>
            <pre>{row.raw}</pre>
          </details>
        </article>
      ))}
    </section>
  );
}

export default function Statistics({ revision = "" }: { revision?: string }) {
  const today = useToday();
  const [preset, setPreset] = useState<Preset>("month");
  const [custom, setCustom] = useState(() => presetRange("month", today));
  const range = preset === "custom" ? custom : presetRange(preset, today);
  const [grain, setGrain] = useState<Grain>("day");
  const [currency, setCurrency] = useState("");
  const [selection, setSelection] = useState<{
    key: string;
    value: DetailSelection;
  }>();
  const invalid = !range.start || !range.end || range.start > range.end;
  const params = new URLSearchParams({ ...range, grain, currency });
  const key = params.toString();
  const resource = useReportResource<Report>(
    invalid ? null : `/statistics?${key}`,
    revision,
    true,
  );
  const report = resource.data;
  const selected = selection?.key === key ? selection.value : undefined;
  function select(value: DetailSelection) {
    setSelection({ key, value });
  }
  return (
    <div className="statistics">
      <header className="stats-heading">
        <div>
          <span className="stats-eyebrow">账本中的收支全貌</span>
          <h1>统计图表</h1>
          <p>从每天的一笔，到一整年的变化。</p>
        </div>
        <button
          className="ghost"
          onClick={resource.retry}
          disabled={resource.loading}
        >
          刷新统计
        </button>
      </header>
      <section className="panel stats-filters" aria-label="统计筛选">
        <Segmented
          label="日期范围"
          value={preset}
          options={presets}
          onChange={(value) => {
            setCustom(range);
            setPreset(value as Preset);
            setSelection(undefined);
          }}
        />
        <div className="stats-filter-fields">
          <label>
            开始日期
            <input
              type="date"
              min="0001-01-01"
              max="9999-12-31"
              value={range.start}
              onChange={(e) => {
                setCustom({ ...range, start: e.target.value });
                setPreset("custom");
                setSelection(undefined);
              }}
            />
          </label>
          <label>
            结束日期
            <input
              type="date"
              min="0001-01-01"
              max="9999-12-31"
              value={range.end}
              onChange={(e) => {
                setCustom({ ...range, end: e.target.value });
                setPreset("custom");
                setSelection(undefined);
              }}
            />
          </label>
          <div>
            <span className="stats-field-label">统计粒度</span>
            <Segmented
              label="统计粒度"
              value={grain}
              options={[
                { value: "day", label: "日" },
                { value: "week", label: "周" },
                { value: "month", label: "月" },
              ]}
              onChange={(value) => {
                setGrain(value as Grain);
                setSelection(undefined);
              }}
            />
          </div>
          <label>
            币种
            <select
              value={currency}
              onChange={(e) => {
                setCurrency(e.target.value);
                setSelection(undefined);
              }}
            >
              <option value="">
                账本默认
                {report?.currency && !currency ? `（${report.currency}）` : ""}
              </option>
              {[
                ...new Set([
                  ...(report?.currencies || []),
                  ...(currency ? [currency] : []),
                ]),
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>
      </section>
      {invalid && (
        <Notice tone="error">
          请选择有效的起止日期，开始日期不能晚于结束日期。
        </Notice>
      )}
      {resource.error && (
        <Notice
          tone="error"
          action={
            <button className="ghost small" onClick={resource.retry}>
              重新加载统计
            </button>
          }
        >
          {resource.error}
          {report && "。当前为上一次有效视图，无法确认最新状态。"}
        </Notice>
      )}
      {!invalid && !report && !resource.error && (
        <p className="empty" role="status">
          正在汇总账本收支…
        </p>
      )}
      {report?.stale && (
        <Notice tone="warn">
          {report.available
            ? "账本校验失败，统计保留上一次有效视图。"
            : "账本校验失败，尚无有效统计数据。"}
          {report.errors.map((item, index) => (
            <span className="diag" key={index}>
              {item.file}:{item.line} · {item.message}
            </span>
          ))}
        </Notice>
      )}
      {report?.available && (
        <>
          <div className="stats-range-caption">
            <span>{periodLabel(report)}</span>
            <span>
              {report.count} 笔收支 · {report.currency || "暂无币种"}
            </span>
          </div>
          <section className="stats-summary" aria-label="区间收支">
            {(["income", "expenses", "net"] as const).map((name) => (
              <div className={`stat ${name}`} key={name}>
                <span className="stat-label">区间{labels[name]}</span>
                <strong className="stat-value">
                  {money(report.totals[name])}
                  <small>{report.currency}</small>
                </strong>
                <span className="stat-note">
                  {name === "income"
                    ? "工资、收益与其他收入"
                    : name === "expenses"
                      ? "含退款与折扣冲减"
                      : "收入 − 支出"}
                </span>
              </div>
            ))}
          </section>
          {report.count === 0 && (
            <Empty>该区间没有所选币种的收支记录，所有时段按零展示。</Empty>
          )}
          <Trend report={report} onSelect={select} />
          <StatisticsRanking
            report={report}
            onSelect={(account) =>
              select({ start: report.start, end: report.end, account })
            }
          />
          {selected && (
            <Details
              key={`${key}:${selected.start}:${selected.end}:${selected.account || ""}`}
              report={report}
              selected={selected}
              onClose={() => setSelection(undefined)}
              onRefresh={resource.retry}
            />
          )}
          <p className="stats-footnote">
            按交易日期与收入、费用科目统计；转账、还款及未入账草稿不参与。退款计入发生当期，各币种分别查看。日期以
            Asia/Shanghai 为准。
          </p>
        </>
      )}
    </div>
  );
}
