import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { bqlCompletion, bqlLanguage } from "./bql";

function state(doc: string) {
  return EditorState.create({ doc, extensions: [bqlLanguage] });
}
describe("BQL 编辑语言", () => {
  it("区分关键字、字段、函数、日期、中文字符串与注释", () => {
    const doc =
      "SELECT date, sum(number) WHERE date >= 2026-01-01 AND narration ~ '餐饮' ; 注释\n/* 多行\n注释 */ SELECT payee";
    const tree = syntaxTree(state(doc));
    for (const [text, kind] of [
      ["SELECT", "keyword"],
      ["date", "propertyName"],
      ["sum", "function"],
      ["2026", "number"],
      ["餐饮", "string"],
      ["; 注释", "comment"],
      ["多行", "comment"],
    ]) {
      expect(tree.resolveInner(doc.indexOf(text) + 1, -1).name).toContain(kind);
    }
  });
  it("提供字段、函数片段与关键字，替换当前词前缀", () => {
    const doc = "SELECT su";
    const result = bqlCompletion(
      new CompletionContext(state(doc), doc.length, false),
    )!;
    expect(result.from).toBe(7);
    expect(result.options.find((o) => o.label === "sum")?.apply).toBeTypeOf(
      "function",
    );
    expect(result.options.map((o) => o.label)).toEqual(
      expect.arrayContaining(["payee", "WHERE", "GROUP BY"]),
    );
    expect(result.options.map((o) => o.label)).not.toContain("INSERT");
  });
  it.each([
    "SELECT '文字",
    'SELECT "文字',
    "SELECT date ; 备注",
    "SELECT /* 多行\n备注",
  ])("字符串和注释内不弹补全：%s", (doc) => {
    expect(
      bqlCompletion(new CompletionContext(state(doc), doc.length, true)),
    ).toBeNull();
  });
  it("空白处仅手动唤起补全", () => {
    expect(
      bqlCompletion(new CompletionContext(state("SELECT "), 7, false)),
    ).toBeNull();
    expect(
      bqlCompletion(new CompletionContext(state("SELECT "), 7, true)),
    ).not.toBeNull();
  });
});
