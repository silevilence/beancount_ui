import { useState } from "react";
import { bqlEntries } from "./bql";

export default function BqlReference({
  onInsert,
}: {
  onInsert: (text: string) => void;
}) {
  const [search, setSearch] = useState("");
  const matches = bqlEntries.filter((entry) =>
    `${entry.label} ${entry.detail} ${entry.category}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  return (
    <aside
      className="bql-reference"
      id="bql-reference"
      aria-label="BQL 手册速查"
    >
      <h3>手册速查</h3>
      <p className="muted">点击条目插入光标处；选中文字时替换选中部分。</p>
      <label>
        查语句、字段或函数
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="例如：日期、sum、商家"
        />
      </label>
      <p className="muted" role="status">
        {matches.length} 个条目
      </p>
      <div
        className="bql-reference-list"
        tabIndex={0}
        aria-label="速查条目，可滚动"
      >
        {["语句", "字段", "函数", "条件"].map((category) => {
          const entries = matches.filter(
            (entry) => entry.category === category,
          );
          return (
            entries.length > 0 && (
              <section key={category}>
                <h4>{category}</h4>
                {entries.map((entry) => (
                  <button
                    type="button"
                    className="bql-reference-entry"
                    key={entry.label}
                    onClick={() => onInsert(entry.insert ?? entry.label)}
                    aria-label={`插入 ${entry.label}`}
                  >
                    <code>{entry.label}</code>
                    <span>{entry.detail}</span>
                  </button>
                ))}
              </section>
            )
          );
        })}
        {!matches.length && <p>没有匹配条目，试试字段名或中文用途。</p>}
      </div>
      <p className="muted">
        BQL 按分录查询，一笔交易可能有多行。汇总金额时请区分币种。
      </p>
      <a
        href="https://beancount.github.io/docs/beancount_query_language/"
        target="_blank"
        rel="noreferrer"
      >
        完整 BQL 手册 ↗
      </a>
    </aside>
  );
}
