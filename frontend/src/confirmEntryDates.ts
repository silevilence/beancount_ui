import { shanghaiToday } from "./format";

/** 使用服务器已校验、已展开模板的预览原文，避免表单日期与实际入账日期不一致。 */
export function confirmEntryDates(items: { raw: string }[]): boolean {
  if (!items?.length) throw new Error("预览缺少条目日期，请重新预览后保存。");
  const today = shanghaiToday();
  const counts = new Map<string, number>();
  for (const item of items) {
    const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ \t]/m.exec(item.raw);
    if (!match) throw new Error("无法识别预览条目日期，请重新预览后保存。");
    const day = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
    if (day !== today) counts.set(day, (counts.get(day) || 0) + 1);
  }
  if (!counts.size) return true;
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const details = [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, count]) => `${day}：${count} 笔`)
    .join("\n");
  return window.confirm(
    `本次有 ${total} 笔条目的日期不是今日（${today}，上海时间）：\n\n${details}\n\n确认按这些日期入账吗？取消将保留填写内容与草稿。`,
  );
}
