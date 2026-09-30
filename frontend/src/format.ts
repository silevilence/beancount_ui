/** 金额、日期与差异的纯展示工具；金额始终按精确十进制字符串处理，不经过浮点数。 */

export interface AmountLine {
  currency: string;
  amount: string;
}

export interface DiffRow {
  kind: "add" | "del" | "hunk" | "meta" | "ctx";
  text: string;
}

export interface AccountGroup {
  label: string;
  items: string[];
}

export function shanghaiToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** 日期只有 2026-09-30 形式，UTC 加减避免时区与夏令时换算。 */
export function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function dayFull(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = WEEKDAYS[date.getUTCDay()];
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日 ${weekday}`;
}

export function dayRelative(day: string, today = shanghaiToday()): string {
  if (day === today) return "今天";
  if (day === shiftDay(today, -1)) return "昨天";
  if (day === shiftDay(today, -2)) return "前天";
  return "";
}

export function clockOf(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

/** 千分位分组，小数至少两位、更多位保留原样；精确值不丢失。 */
export function money(amount: string, currency = ""): string {
  const negative = amount.startsWith("-");
  const [whole = "0", fraction = ""] = (negative
    ? amount.slice(1)
    : amount
  ).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const text = `${grouped}.${fraction.padEnd(2, "0")}`;
  return `${negative ? "-" : ""}${text}${currency ? ` ${currency}` : ""}`;
}

function scaleOf(value: string): number {
  const dot = value.indexOf(".");
  return dot < 0 ? 0 : value.length - dot - 1;
}

function scaled(value: string, scale: number): bigint {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (negative
    ? value.slice(1)
    : value
  ).split(".");
  const digits = BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
  return negative ? -digits : digits;
}

/** 十进制字符串求和，位数按输入最大小数位对齐，结果不带多余尾零以外的修饰。 */
export function decimalSum(values: string[]): string {
  const scale = values.reduce((max, value) => Math.max(max, scaleOf(value)), 0);
  const total = values.reduce((sum, value) => sum + scaled(value, scale), 0n);
  const negative = total < 0n;
  const digits = (negative ? -total : total)
    .toString()
    .padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function byCurrency(record?: Record<string, string>): AmountLine[] {
  return Object.entries(record ?? {})
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/** 当日净额：收入减去支出，逐币种计算。 */
export function netTotals(
  expenses?: Record<string, string>,
  income?: Record<string, string>,
): AmountLine[] {
  const currencies = [
    ...new Set([...Object.keys(expenses ?? {}), ...Object.keys(income ?? {})]),
  ].sort();
  return currencies.map((currency) => {
    const spent = expenses?.[currency] ?? "0";
    const received = income?.[currency] ?? "0";
    return {
      currency,
      amount: decimalSum([
        received,
        spent.startsWith("-") ? spent.slice(1) : `-${spent}`,
      ]),
    };
  });
}

/** 单笔业务的金额量级：各分录中正向金额按币种合计。 */
export function magnitudes(
  postings: { amount: string; currency: string }[],
): AmountLine[] {
  const sums: Record<string, string[]> = {};
  for (const posting of postings) {
    if (posting.amount.startsWith("-")) continue;
    (sums[posting.currency] ??= []).push(posting.amount);
  }
  return Object.entries(sums)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amounts]) => ({
      currency,
      amount: decimalSum(amounts),
    }));
}

const KIND_TONE: Record<string, "expense" | "income" | "transfer"> = {
  消费: "expense",
  收入: "income",
};

const KIND_MARK: Record<string, string> = { 消费: "支", 收入: "收" };

export function kindTone(kind: string): "expense" | "income" | "transfer" {
  return KIND_TONE[kind] ?? "transfer";
}

export function kindMark(kind: string): string {
  return KIND_MARK[kind] ?? "转";
}

export function diffRows(diff: string): DiffRow[] {
  return diff
    .split("\n")
    .filter((line) => line !== "")
    .map((text) => {
      let kind: DiffRow["kind"] = "ctx";
      if (/^(\+\+\+|---)/.test(text)) kind = "meta";
      else if (text.startsWith("@@")) kind = "hunk";
      else if (text.startsWith("+")) kind = "add";
      else if (text.startsWith("-")) kind = "del";
      return { kind, text };
    });
}

export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of diffRows(diff)) {
    if (row.kind === "add") added += 1;
    if (row.kind === "del") removed += 1;
  }
  return { added, removed };
}

const ROOT_LABEL: Record<string, string> = {
  Assets: "资产",
  Liabilities: "负债",
  Expenses: "支出",
};

function groupBy(
  names: string[],
  roots: string[],
  label: (segments: string[]) => string,
): AccountGroup[] {
  const groups: Record<string, string[]> = {};
  for (const name of [...names].sort()) {
    const segments = name.split(":");
    if (!roots.includes(segments[0])) continue;
    (groups[label(segments)] ??= []).push(name);
  }
  return Object.entries(groups).map(([text, items]) => ({
    label: ROOT_LABEL[text] ?? text,
    items,
  }));
}

/** 支出分类按二级科目分组，账户名仍是完整名称。 */
export function expenseGroups(names: string[]): AccountGroup[] {
  return groupBy(names, ["Expenses"], (segments) => segments[1] ?? segments[0]);
}

/** 付款与还款账户按资产 / 负债分组。 */
export function fundingGroups(names: string[]): AccountGroup[] {
  return groupBy(names, ["Assets", "Liabilities"], (segments) => segments[0]);
}

/** 短日期，用于网格与列表：09-30。 */
export function shortDay(day: string): string {
  return day.slice(5);
}

/** 星期几，用于逐日列表与网格。 */
export function weekdayShort(day: string): string {
  return WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()];
}

/** 一组带币种的金额按币种精确求和。 */
export function sumByCurrency(
  items: { amount: string; currency: string }[],
): AmountLine[] {
  const groups: Record<string, string[]> = {};
  for (const item of items) (groups[item.currency] ??= []).push(item.amount);
  return Object.entries(groups)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amounts]) => ({
      currency,
      amount: decimalSum(amounts),
    }));
}

/** 业务类型标签，与后端 business 取值一一对应。 */
export const BUSINESS_LABEL: Record<string, string> = {
  ordinary: "日常消费",
  yuebao: "余额宝收益",
  salary: "工资 / 奖金",
  phone: "话费",
  balance: "余额断言",
};

export function businessLabel(business: string): string {
  return BUSINESS_LABEL[business] ?? BUSINESS_LABEL.ordinary;
}

/** 淘宝订单处理方式的标签与语义提示。 */
export const ORDER_KIND: Record<string, { label: string; hint: string }> = {
  paid: {
    label: "直接付款下单",
    hint: "生成消费，由付款账户承担本金",
  },
  deferred: {
    label: "挂待付款负债",
    hint: "生成消费，由待付款负债账户承担本金",
  },
  settle: {
    label: "确认收货 / 部分结算",
    hint: "只把负债结转到实际付款账户，不再生成消费",
  },
  refund_paid: {
    label: "已付款退款",
    hint: "冲回原费用，退款进入实际收款账户",
  },
  refund_unpaid: {
    label: "未结算负债冲回",
    hint: "冲回原费用，减少原待付款负债",
  },
};

export function orderKindLabel(kind: string): string {
  return ORDER_KIND[kind]?.label ?? "订单处理";
}

/** 金额正负对应的展示色，用于净额与差额。 */
export function signedTone(amount: string): "pos" | "neg" | "zero" {
  if (/^-?0*(\.0*)?$/.test(amount)) return "zero";
  return amount.startsWith("-") ? "neg" : "pos";
}
