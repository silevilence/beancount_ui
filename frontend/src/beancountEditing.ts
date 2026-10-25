import type { EntryCompletions } from "./api";

export const emptyCompletions: EntryCompletions = {
  payees: [],
  narrations: [],
  currencies: [],
  tags: [],
  links: [],
};

const tokenPattern =
  /;[^\n]*|"(?:[^"\\]|\\.)*(?:"|$)|\b\d{4}-\d{2}-\d{2}\b|\b(?:Assets|Liabilities|Expenses|Income|Equity):[^\s;{}@]+|[#^][\w-]+|@@?|[{}]|[+-]?\b\d+(?:\.\d+)?\b|\b[A-Z][A-Z0-9._-]*\b|\b(?:balance|open|close|commodity|price|pad|note|document|event|query|custom)\b/gm;

/** 高亮只渲染文本节点，不解释原文中的 HTML。 */
export function highlightBeancount(value: string) {
  const tokens: { text: string; kind?: string }[] = [];
  let cursor = 0;
  for (const match of value.matchAll(tokenPattern)) {
    if (match.index > cursor)
      tokens.push({ text: value.slice(cursor, match.index) });
    const text = match[0];
    const kind = text.startsWith(";")
      ? "comment"
      : text.startsWith('"')
        ? "string"
        : /^\d{4}-/.test(text)
          ? "date"
          : text.includes(":")
            ? "account"
            : /^[#^]/.test(text)
              ? "tag"
              : /^[@{}]/.test(text)
                ? "operator"
                : /^[+-]?\d/.test(text)
                  ? "number"
                  : "keyword";
    tokens.push({ text, kind });
    cursor = match.index + text.length;
  }
  tokens.push({ text: value.slice(cursor) });
  return tokens;
}

export interface Completion {
  from: number;
  to: number;
  options: { label: string; insert: string }[];
}

export function completeBeancount(
  value: string,
  cursor: number,
  accounts: string[],
  history: EntryCompletions,
  explicit = false,
): Completion | undefined {
  const start = value.lastIndexOf("\n", cursor - 1) + 1;
  const before = value.slice(start, cursor);
  let quote = -1;
  let strings = 0;
  let comment = false;
  for (let i = 0; i < before.length; i++) {
    if (quote >= 0 && before[i] === "\\") {
      i++;
      continue;
    }
    if (before[i] === '"') {
      if (quote < 0) quote = i;
      else {
        quote = -1;
        strings++;
      }
    } else if (quote < 0 && before[i] === ";") {
      comment = true;
      break;
    }
  }
  if (comment) return;
  let from: number;
  let to = cursor;
  let candidates: string[];
  let query: string;
  let quoted = false;
  if (quote >= 0) {
    if (!/^\d{4}-\d{2}-\d{2}\s+\S\s/.test(before) || strings > 1) return;
    quoted = true;
    from = start + quote + 1;
    query = value.slice(from, cursor);
    try {
      query = JSON.parse(`"${query}"`) as string;
    } catch {
      /* 正在填写转义字符。 */
    }
    candidates = strings === 0 ? history.payees : history.narrations;
    while (to < value.length && value[to] !== '"' && value[to] !== "\n") {
      if (value[to] === "\\" && to + 1 < value.length) to++;
      to++;
    }
  } else {
    const token = /[^\s";{}@]*$/.exec(before)![0];
    query = token;
    from = cursor - token.length;
    const prefix = value.slice(start, from);
    if (!token && !explicit) return;
    if (token.startsWith("#")) candidates = history.tags.map((t) => `#${t}`);
    else if (token.startsWith("^"))
      candidates = history.links.map((t) => `^${t}`);
    else if (
      token.includes(":") ||
      /^\s+(?:[*!]\s+)?$/.test(prefix) ||
      /\b(?:balance|open|close|pad|note|document)\s+$/.test(prefix)
    )
      candidates = accounts;
    else if (/[\d.]\s+$/.test(prefix) && !/^\d{4}-\d{2}-\d{2}\s+$/.test(prefix))
      candidates = history.currencies;
    else if (/^\d{4}-\d{2}-\d{2}\s+$/.test(prefix))
      candidates = [
        "balance",
        "open",
        "close",
        "price",
        "commodity",
        "pad",
        "note",
        "document",
        "event",
      ];
    else return;
    while (to < value.length && /[^\s";{}@]/.test(value[to])) to++;
  }
  const options = [...new Set(candidates)]
    .filter(
      (text) =>
        text.toLocaleLowerCase().includes(query.toLocaleLowerCase()) &&
        text !== query,
    )
    .slice(0, 50)
    .map((label) => ({
      label,
      insert: quoted ? JSON.stringify(label).slice(1, -1) : label,
    }));
  return options.length ? { from, to, options } : undefined;
}
