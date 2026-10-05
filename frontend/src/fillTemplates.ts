import type { PostingLine } from "./api";
import type { EntryFields } from "./Editor";
import { inputValues, type RecordTemplate } from "./businessConfig";

export type FillData =
  | { mode: "basic"; fields: Partial<Omit<EntryFields, "date">> }
  | {
      mode: "postings";
      fields: Partial<Omit<EntryFields, "date">>;
      postings: PostingLine[];
    }
  | { mode: "record"; values: Record<string, string> };

/** Empty fields stay editable. Dates always belong to the current entry. */
export function captureFill(
  fields: EntryFields,
  postings: PostingLine[] | undefined,
  template: RecordTemplate | null | undefined,
  values: Record<string, string>,
  amounts: boolean,
): FillData {
  if (template) {
    return {
      mode: "record",
      values: Object.fromEntries(
        Object.entries(inputValues(template, values, fields.date)).filter(
          ([key, value]) =>
            value !== "" &&
            template.fields[key].type !== "date" &&
            (amounts || template.fields[key].type !== "amount"),
        ),
      ),
    };
  }
  const keys = postings
    ? (["payee", "narration", "note"] as const)
    : ([
        "payee",
        "narration",
        "note",
        "amount",
        "currency",
        "category",
        "payment",
      ] as const);
  const saved: Partial<Omit<EntryFields, "date">> = Object.fromEntries(
    keys
      .filter((key) => fields[key] !== "" && (amounts || key !== "amount"))
      .map((key) => [key, fields[key]]),
  );
  if (postings)
    return {
      mode: "postings",
      fields: saved,
      postings: postings.map(({ account, amount, currency, note }) => ({
        account,
        amount: amount === null || amounts ? amount : "",
        currency,
        note,
      })),
    };
  if (fields.splits?.length)
    saved.splits = fields.splits.map((line) => ({
      ...line,
      amount: amounts ? line.amount : "",
    }));
  return { mode: "basic", fields: saved };
}

export interface QuickFillTemplate {
  name: string;
  business: string;
  schema: string;
  data: FillData;
}

export const quickFillKey = (identity?: string) =>
  `beancount-ui.quick-fill.v1.${identity || "default"}`;

export function readFills(text: string | null): QuickFillTemplate[] {
  const items: unknown = text ? JSON.parse(text) : [];
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const strings = (v: unknown) =>
    object(v) && Object.values(v).every((s) => typeof s === "string");
  if (
    !Array.isArray(items) ||
    !items.every((item) => {
      if (
        !object(item) ||
        typeof item.name !== "string" ||
        !item.name.trim() ||
        typeof item.business !== "string" ||
        typeof item.schema !== "string" ||
        !object(item.data)
      )
        return false;
      const d = item.data;
      if (d.mode === "record") return strings(d.values);
      if (d.mode !== "basic" && d.mode !== "postings") return false;
      if (
        !object(d.fields) ||
        !Object.entries(d.fields).every(([key, value]) =>
          key === "splits"
            ? Array.isArray(value) &&
              value.length <= 100 &&
              value.every(
                (line) =>
                  object(line) &&
                  [line.category, line.amount, line.note].every(
                    (s) => typeof s === "string",
                  ),
              )
            : [
                "payee",
                "narration",
                "note",
                "amount",
                "currency",
                "category",
                "payment",
              ].includes(key) && typeof value === "string",
        )
      )
        return false;
      return (
        d.mode === "basic" ||
        (Array.isArray(d.postings) &&
          d.postings.length >= 2 &&
          d.postings.length <= 100 &&
          d.postings.every(
            (line) =>
              object(line) &&
              [line.account, line.currency, line.note].every(
                (s) => typeof s === "string",
              ) &&
              (line.amount === null || typeof line.amount === "string"),
          ))
      );
    })
  )
    throw new Error("快速填充模板数据损坏，请保留浏览器数据并恢复备份。");
  return items as QuickFillTemplate[];
}
