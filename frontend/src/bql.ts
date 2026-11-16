import { StreamLanguage, syntaxTree } from "@codemirror/language";
import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
} from "@codemirror/autocomplete";
import reference from "./bql-reference.json";

export interface ReferenceEntry {
  category: string;
  label: string;
  detail: string;
  insert?: string;
}
export const bqlEntries: ReferenceEntry[] = reference.entries;
export const bqlExamples = reference.examples;
const keywords = new Set(
  "SELECT DISTINCT FROM WHERE GROUP BY HAVING ORDER ASC DESC LIMIT AS AND OR NOT IN IS NULL TRUE FALSE BALANCES JOURNAL OPEN CLOSE CLEAR FLATTEN PIVOT ON".split(
    " ",
  ),
);
const columns = new Set(
  bqlEntries.filter((e) => e.category === "字段").map((e) => e.label),
);

// beanquery 0.2 uses semicolon line comments (not SQL -- comments).
export const bqlLanguage = StreamLanguage.define<{
  quote: string;
  comment: boolean;
}>({
  startState: () => ({ quote: "", comment: false }),
  token(stream, state) {
    if (state.comment) {
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.comment = false;
      } else stream.skipToEnd();
      return "comment";
    }
    if (state.quote) {
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === "\\") stream.next();
        else if (ch === state.quote) {
          state.quote = "";
          break;
        }
      }
      return "string";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("/*")) {
      state.comment = true;
      return "comment";
    }
    if (stream.match(";")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match(/["']/)) {
      state.quote = stream.current();
      return "string";
    }
    if (stream.match(/\d{4}-\d{2}-\d{2}\b/)) return "number";
    if (stream.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/))
      return "number";
    if (stream.match(/[a-zA-Z_][\w]*/)) {
      const word = stream.current();
      if (keywords.has(word.toUpperCase())) return "keyword";
      if (stream.match(/^\s*\(/, false)) return "variableName.function";
      return columns.has(word.toLowerCase()) ? "propertyName" : "variableName";
    }
    if (stream.match(/[~!=<>+*/%-]+/)) return "operator";
    stream.next();
    return "punctuation";
  },
  languageData: {
    commentTokens: { line: ";", block: { open: "/*", close: "*/" } },
  },
});

const options: Completion[] = [
  ...bqlEntries
    .filter((e) => e.category !== "条件")
    .map((e) =>
      e.insert
        ? snippetCompletion(e.insert, {
            label: e.label,
            type: "function",
            detail: e.category,
            info: e.detail,
          })
        : {
            label: e.label,
            type: e.category === "字段" ? "property" : "keyword",
            detail: e.category,
            info: e.detail,
          },
    ),
  ...[
    "AND",
    "OR",
    "NOT",
    "IN",
    "IS",
    "NULL",
    "ASC",
    "DESC",
    "TRUE",
    "FALSE",
  ].map((label) => ({ label, type: "keyword", detail: "关键字" })),
];

export function bqlCompletion(context: CompletionContext) {
  const node = syntaxTree(context.state).resolveInner(context.pos, -1);
  if (/string|comment/i.test(node.name)) return null;
  const word = context.matchBefore(/[\w]*/);
  if (!word || (!context.explicit && word.from === word.to)) return null;
  return { from: word.from, options, validFor: /^\w*$/ };
}
