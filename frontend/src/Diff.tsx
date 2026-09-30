import { diffRows, diffStat } from "./format";

/** 行级差异渲染：增删着色并给出增删行数。 */
export default function Diff({ diff }: { diff: string }) {
  const stat = diffStat(diff);
  return (
    <>
      <div className="diff-stat" aria-label="差异统计">
        <span className="add">+{stat.added}</span>
        <span className="del">-{stat.removed}</span>
      </div>
      <pre className="diff">
        {diffRows(diff).map((row, index) => (
          <span className={`diff-line ${row.kind}`} key={index}>
            {row.text}
            {"\n"}
          </span>
        ))}
      </pre>
    </>
  );
}
