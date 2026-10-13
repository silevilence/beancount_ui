import { money } from "./format";
import type { Report } from "./statisticsData";
import { Empty } from "./ui";

export default function StatisticsRanking({
  report,
  onSelect,
}: {
  report: Report;
  onSelect: (account: string) => void;
}) {
  return (
    <div className="stats-rankings">
      {(["expenses", "income"] as const).map((kind) => {
        const items = report.categories[kind];
        const limit = Math.max(
          1,
          ...items.map((item) => Math.abs(Number(item.amount))),
        );
        const title = kind === "expenses" ? "支出分类" : "收入来源";
        return (
          <section
            key={kind}
            className={`panel stats-ranking ${kind}`}
            aria-label={title}
          >
            <div className="stats-panel-head">
              <div>
                <span className="stats-eyebrow">
                  {kind === "expenses" ? "钱花在哪里" : "收入从何而来"}
                </span>
                <h2>{title}</h2>
              </div>
              <span className="stats-rank-count">{items.length} 类</span>
            </div>
            <p className="stats-ranking-hint">
              按净额排序 · 负值向左 · 点击核对分录
            </p>
            {items.length === 0 && <Empty>该区间暂无{title}。</Empty>}
            <ol>
              {items.map((item, index) => {
                const value = Number(item.amount);
                const width = (Math.abs(value) / limit) * 50;
                return (
                  <li key={item.account}>
                    <button
                      className="stats-rank-item"
                      onClick={() => onSelect(item.account)}
                    >
                      <span className="stats-rank-label">
                        <small>{String(index + 1).padStart(2, "0")}</small>
                        <span>{item.account}</span>
                        <strong>{money(item.amount, report.currency)}</strong>
                      </span>
                      <span className="stats-rank-track" aria-hidden="true">
                        <i
                          style={{
                            left: `${value < 0 ? 50 - width : 50}%`,
                            width: `${width}%`,
                            // 负值从零轴向左生长，正值向右。
                            transformOrigin:
                              value < 0 ? "right center" : "left center",
                          }}
                        />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <div className="stats-rank-total">
              <span>全部分类合计</span>
              <strong>{money(report.totals[kind], report.currency)}</strong>
            </div>
          </section>
        );
      })}
    </div>
  );
}
