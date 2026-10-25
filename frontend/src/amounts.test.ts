import { expect, it } from "vitest";
import { normalizeAmount } from "./amounts";
import { decimalSum, money } from "./format";
import { decimalTotal } from "./SplitFields";

it.each([
  [" 2,000 ", "2000"],
  ["\t-12,345,678.00000001\n", "-12345678.00000001"],
  [" 0.10 ", "0.10"],
  ["", ""],
  ["2,00", "2,00"],
  ["2,", "2,"],
  ["1 000", "1 000"],
  ["1.000,50", "1.000,50"],
])("金额规范化 %s", (input, expected) => {
  expect(normalizeAmount(input)).toBe(expected);
});

it("分组金额与高精度小数汇总不丢精度，错误分组不参与合计", () => {
  expect(decimalSum([" 9,007,199,254,740,991.00000001 ", " 0.00000002"])).toBe(
    "9007199254740991.00000003",
  );
  expect(decimalTotal([" 2,000.10 ", "-1,000.01"])).toBe("1000.09");
  expect(decimalTotal(["2,00", "1"])).toBe("待填写有效金额");
  expect(money(" -2,000.12345678 ", "CNY")).toBe("-2,000.12345678 CNY");
});
