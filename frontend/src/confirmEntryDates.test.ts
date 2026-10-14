import { afterEach, expect, it, vi } from "vitest";
import { confirmEntryDates } from "./confirmEntryDates";

afterEach(() => vi.useRealTimers());

const entry = (day: string) => ({
  raw: `; 1999-01-01 is only a comment\n${day} * "日期测试"\n  memo: "2000-01-01"\n  Expenses:Food 1 CNY\n  Assets:Cash -1 CNY\n`,
});

function clock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T15:59:59Z"));
  const confirm = vi.fn((_message: string) => true);
  vi.stubGlobal("confirm", confirm);
  return confirm;
}

it("全部上海今日时不提醒，包括同日多条和斜线日期", () => {
  const confirm = clock();
  expect(confirmEntryDates([entry("2026-10-14"), entry("2026/10/14")])).toBe(
    true,
  );
  expect(confirm).not.toHaveBeenCalled();
});

it.each([true, false])(
  "混合过去、今日、未来与余额条目只汇总提醒一次，返回确认结果 %s",
  (accepted) => {
    const confirm = clock().mockReturnValue(accepted);
    expect(
      confirmEntryDates([
        entry("2026-10-14"),
        entry("2026-10-13"),
        entry("2026-10-15"),
        { raw: "2026-10-13 balance Assets:Cash 0 CNY\n" },
      ]),
    ).toBe(accepted);
    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        "本次有 3 笔条目的日期不是今日（2026-10-14，上海时间）",
      ),
    );
    expect(confirm.mock.calls[0][0]).toContain(
      "2026-10-13：2 笔\n2026-10-15：1 笔",
    );
  },
);

it("跨上海午夜时重新判断实际日期，不缓存先前的今日", () => {
  const confirm = clock();
  expect(confirmEntryDates([entry("2026-10-14")])).toBe(true);
  vi.setSystemTime(new Date("2026-10-14T16:00:00Z"));
  confirmEntryDates([entry("2026-10-14")]);
  expect(confirm).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("今日（2026-10-15，上海时间）"),
  );
});

it("缺失预览日期时阻止保存，不当成今日", () => {
  const confirm = clock();
  expect(() => confirmEntryDates([])).toThrow("预览缺少条目日期");
  expect(() => confirmEntryDates([{ raw: "错误的原文" }])).toThrow(
    "无法识别预览条目日期",
  );
  expect(confirm).not.toHaveBeenCalled();
});
