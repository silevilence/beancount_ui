import { describe, expect, it } from "vitest";
import {
  businessLabel,
  byCurrency,
  clockOf,
  dayFull,
  dayRelative,
  decimalSum,
  diffRows,
  diffStat,
  expenseGroups,
  fundingGroups,
  kindMark,
  kindTone,
  magnitudes,
  money,
  netTotals,
  orderKindLabel,
  shiftDay,
  shortDay,
  signedTone,
  sumByCurrency,
  weekdayShort,
} from "./format";

describe("money", () => {
  it("groups thousands and pads to two decimals", () => {
    expect(money("1234567.5", "CNY")).toBe("1,234,567.50 CNY");
    expect(money("-25.5")).toBe("-25.50");
    expect(money("0")).toBe("0.00");
  });

  it("keeps extra decimals exactly as stored", () => {
    expect(money("0.001", "USD")).toBe("0.001 USD");
  });
});

describe("decimalSum", () => {
  it("adds decimal strings without floating point drift", () => {
    expect(decimalSum(["0.1", "0.2"])).toBe("0.3");
    expect(decimalSum(["1.5", "-1.5"])).toBe("0.0");
    expect(decimalSum([])).toBe("0");
    expect(decimalSum(["-100"])).toBe("-100");
  });
});

describe("day helpers", () => {
  it("shifts dates across month and year boundaries", () => {
    expect(shiftDay("2026-09-30", 1)).toBe("2026-10-01");
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("labels recent days and describes others by weekday", () => {
    const today = "2026-09-30";
    expect(dayRelative(today, today)).toBe("今天");
    expect(dayRelative("2026-09-29", today)).toBe("昨天");
    expect(dayRelative("2026-09-28", today)).toBe("前天");
    expect(dayRelative("2026-09-01", today)).toBe("");
    expect(dayFull("2026-09-30")).toBe("9月30日 周三");
  });

  it("renders the update clock in Shanghai time", () => {
    expect(clockOf(new Date("2026-09-30T10:24:05Z"))).toBe("18:24:05");
  });
});

describe("totals", () => {
  it("lists amounts by currency", () => {
    expect(byCurrency({ CNY: "25.50", USD: "5" })).toEqual([
      { currency: "CNY", amount: "25.50" },
      { currency: "USD", amount: "5" },
    ]);
    expect(byCurrency()).toEqual([]);
  });

  it("computes net per currency including missing sides", () => {
    expect(netTotals({ CNY: "25.50" }, { CNY: "100.12" })).toEqual([
      { currency: "CNY", amount: "74.62" },
    ]);
    expect(netTotals(undefined, { USD: "10" })).toEqual([
      { currency: "USD", amount: "10" },
    ]);
    expect(netTotals({ CNY: "3" })).toEqual([
      { currency: "CNY", amount: "-3" },
    ]);
    expect(netTotals({ CNY: "-3" }, { CNY: "1" })).toEqual([
      { currency: "CNY", amount: "4" },
    ]);
  });

  it("measures a transaction by its positive postings", () => {
    expect(
      magnitudes([
        { amount: "25.50", currency: "CNY" },
        { amount: "-25.50", currency: "CNY" },
      ]),
    ).toEqual([{ currency: "CNY", amount: "25.50" }]);
    expect(magnitudes([{ amount: "-5", currency: "CNY" }])).toEqual([]);
    expect(
      magnitudes([
        { amount: "1", currency: "HOOL" },
        { amount: "2", currency: "HOOL" },
        { amount: "3", currency: "CNY" },
      ]),
    ).toEqual([
      { currency: "CNY", amount: "3" },
      { currency: "HOOL", amount: "3" },
    ]);
  });
});

describe("kinds", () => {
  it("maps kinds to tone and mark with a transfer fallback", () => {
    expect(kindTone("消费")).toBe("expense");
    expect(kindTone("收入")).toBe("income");
    expect(kindTone("转账 / 还款")).toBe("transfer");
    expect(kindMark("消费")).toBe("支");
    expect(kindMark("收入")).toBe("收");
    expect(kindMark("转账 / 还款")).toBe("转");
  });
});

describe("diff", () => {
  const diff = [
    "--- a/txs/2026/09.bean",
    "+++ b/txs/2026/09.bean",
    "@@ -1,2 +1,3 @@",
    " 2026-09-30 * \"食堂\" \"午饭\"",
    "+  Expenses:Food 25.50 CNY",
    "-  Expenses:Food 12.00 CNY",
  ].join("\n");

  it("classifies unified diff lines", () => {
    expect(diffRows(diff).map((row) => row.kind)).toEqual([
      "meta",
      "meta",
      "hunk",
      "ctx",
      "add",
      "del",
    ]);
    expect(diffStat(diff)).toEqual({ added: 1, removed: 1 });
  });
});

describe("account groups", () => {
  it("groups expenses by second segment and funds by root", () => {
    expect(
      expenseGroups(["Expenses:Food:Cafe", "Expenses:Food", "Assets:Cash"]),
    ).toEqual([
      { label: "Food", items: ["Expenses:Food", "Expenses:Food:Cafe"] },
    ]);
    expect(expenseGroups(["Expenses"])).toEqual([
      { label: "支出", items: ["Expenses"] },
    ]);
    expect(
      fundingGroups(["Assets:Cash", "Liabilities:Card", "Expenses:Food"]),
    ).toEqual([
      { label: "资产", items: ["Assets:Cash"] },
      { label: "负债", items: ["Liabilities:Card"] },
    ]);
  });
});

describe("workbench labels", () => {
  it("shortens dates and names weekdays", () => {
    expect(shortDay("2026-09-30")).toBe("09-30");
    expect(weekdayShort("2026-09-30")).toBe("周三");
    expect(weekdayShort("2026-10-04")).toBe("周日");
  });

  it("sums amounts per currency without floats", () => {
    expect(
      sumByCurrency([
        { amount: "0.1", currency: "CNY" },
        { amount: "0.2", currency: "CNY" },
        { amount: "3", currency: "USD" },
      ]),
    ).toEqual([
      { currency: "CNY", amount: "0.3" },
      { currency: "USD", amount: "3" },
    ]);
    expect(sumByCurrency([])).toEqual([]);
  });

  it("labels businesses, order kinds and amount signs", () => {
    expect(businessLabel("salary")).toBe("工资 / 奖金");
    expect(businessLabel("unknown")).toBe("日常消费");
    expect(orderKindLabel("refund_unpaid")).toBe("未结算负债冲回");
    expect(orderKindLabel("unknown")).toBe("订单处理");
    expect(signedTone("-0.00")).toBe("zero");
    expect(signedTone("0")).toBe("zero");
    expect(signedTone("-1.20")).toBe("neg");
    expect(signedTone("10")).toBe("pos");
  });
});
