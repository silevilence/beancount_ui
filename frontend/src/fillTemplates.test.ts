import { expect, it } from "vitest";
import type { EntryFields } from "./Editor";
import { captureFill, readFills } from "./fillTemplates";

const fields: EntryFields = {
  date: "2026-10-05",
  payee: "商店",
  narration: "购物",
  note: "",
  amount: "90",
  currency: "CNY",
  category: "Expenses:Shopping",
  payment: "Assets:Cash",
  splits: [
    { category: "Expenses:Shopping", amount: "100", note: "商品" },
    { category: "Expenses:Shopping", amount: "-10", note: "折扣" },
  ],
};
const item = (data: unknown) => ({
  name: "购物",
  business: "ordinary",
  schema: "form:expense",
  data,
});
const posting = {
  account: "Assets:Cash",
  amount: "-90",
  currency: "CNY",
  note: "",
};
const split = fields.splits![0];

it.each([false, true])(
  "round-trips shopping splits with save amounts = %s",
  (amounts) => {
    const data = captureFill(fields, undefined, null, {}, amounts);
    const expected = {
      mode: "basic",
      fields: {
        payee: "商店",
        narration: "购物",
        ...(amounts ? { amount: "90" } : {}),
        currency: "CNY",
        category: "Expenses:Shopping",
        payment: "Assets:Cash",
        splits: [
          {
            category: "Expenses:Shopping",
            amount: amounts ? "100" : "",
            note: "商品",
          },
          {
            category: "Expenses:Shopping",
            amount: amounts ? "-10" : "",
            note: "折扣",
          },
        ],
      },
    };
    expect(data).toEqual(expected);
    expect(readFills(JSON.stringify([item(data)]))).toEqual([item(expected)]);
    expect(fields.splits!.map((line) => line.amount)).toEqual(["100", "-10"]);
  },
);

it("reads editable record values and posting templates with an inferred amount", () => {
  const templates = [
    item({ mode: "record", values: { merchant: "商店", amount: "90" } }),
    item({
      mode: "postings",
      fields: {},
      postings: [posting, { ...posting, amount: null }],
    }),
    item({ mode: "basic", fields: {} }),
  ];
  expect(readFills(JSON.stringify(templates))).toEqual(templates);
  expect(readFills(null)).toEqual([]);
});

it.each([
  ["unknown mode", { mode: "unknown", fields: {} }],
  ["missing fields", { mode: "basic" }],
  ["date in saved fields", { mode: "basic", fields: { date: "2020-01-01" } }],
  ["non-text field", { mode: "basic", fields: { amount: 90 } }],
  ["missing record values", { mode: "record" }],
  ["non-text record value", { mode: "record", values: { amount: 90 } }],
  ["non-array splits", { mode: "basic", fields: { splits: {} } }],
  [
    "too many splits",
    { mode: "basic", fields: { splits: Array(101).fill(split) } },
  ],
  ["null split", { mode: "basic", fields: { splits: [null] } }],
  [
    "non-text split amount",
    { mode: "basic", fields: { splits: [{ ...split, amount: 90 }] } },
  ],
  ["missing postings", { mode: "postings", fields: {} }],
  ["one posting", { mode: "postings", fields: {}, postings: [posting] }],
  [
    "too many postings",
    { mode: "postings", fields: {}, postings: Array(101).fill(posting) },
  ],
  ["null posting", { mode: "postings", fields: {}, postings: [posting, null] }],
  [
    "non-text account",
    {
      mode: "postings",
      fields: {},
      postings: [posting, { ...posting, account: 1 }],
    },
  ],
  [
    "numeric posting amount",
    {
      mode: "postings",
      fields: {},
      postings: [posting, { ...posting, amount: 90 }],
    },
  ],
])(
  "rejects %s without returning a partially valid collection",
  (_label, data) => {
    const templates = [item({ mode: "basic", fields: {} }), item(data)];
    expect(() => readFills(JSON.stringify(templates))).toThrow(
      "快速填充模板数据损坏",
    );
  },
);

it.each([
  { value: {} },
  { value: [null] },
  { value: [{ ...item({ mode: "basic", fields: {} }), name: " " }] },
  { value: [{ ...item({ mode: "basic", fields: {} }), business: null }] },
  { value: [{ ...item({ mode: "basic", fields: {} }), schema: null }] },
  { value: [item([])] },
])("rejects invalid stored template metadata: $value", ({ value }) => {
  expect(() => readFills(JSON.stringify(value))).toThrow(
    "快速填充模板数据损坏",
  );
});
