import { useEffect, useState } from "react";
import { api, reasonOf } from "./api";

export interface TemplateField {
  label: string;
  type: "date" | "amount" | "text" | "account" | "currency" | "token";
  mode: "input" | "fixed" | "today";
  value: string;
}
export interface RecordTemplate {
  source: string;
  fields: Record<string, TemplateField>;
}
export interface BusinessRoute {
  target: string;
  indexes: string[];
  date_source?: "record" | "write";
  label?: string;
  kind?: string | null;
  template?: RecordTemplate | null;
}
export interface Layout {
  entry: string;
  routes: Record<string, BusinessRoute>;
}
export interface BusinessConfig {
  layout: Layout;
  version: string;
  write_day?: string;
}
export const businessNames: Record<string, string> = {
  ordinary: "日常与转账",
  yuebao: "余额宝收益",
  salary: "工资奖金",
  phone: "话费",
  balance: "余额断言",
};
export function useBusinessConfig(enabled = true) {
  const [config, setConfig] = useState<BusinessConfig>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void api<BusinessConfig>("/layout")
      .then((value) => {
        if (active && value?.layout?.routes) setConfig(value);
      })
      .catch((e) => {
        if (active) setError(reasonOf(e));
      });
    return () => {
      active = false;
    };
  }, [enabled]);
  return { config, error };
}
export function inputValues(
  template: RecordTemplate,
  values: Record<string, string>,
  day: string,
) {
  return Object.fromEntries(
    Object.entries(template.fields)
      .filter(([, field]) => field.mode === "input")
      .map(([key, field]) => [
        key,
        values[key] ?? (field.value || (field.type === "date" ? day : "")),
      ]),
  );
}

export function templateDay(
  template: RecordTemplate | null | undefined,
  values: Record<string, string>,
  fallback: string,
  today: string,
) {
  if (!template) return fallback;
  const token = template.source.match(
    /^(\d{4}-\d{2}-\d{2}|\{\{([a-z][a-z0-9_]*)\}\})\s/m,
  );
  if (!token) return fallback;
  if (!token[2]) return token[1];
  const field = template.fields[token[2]];
  return field?.mode === "today"
    ? today
    : field?.mode === "fixed"
      ? field.value
      : inputValues(template, values, fallback)[token[2]] || fallback;
}

export function carryTemplateValues(
  template: RecordTemplate | null | undefined,
  values: Record<string, string>,
  day: string,
) {
  if (!template) return {};
  return Object.fromEntries(
    Object.entries(inputValues(template, values, day)).filter(([key]) =>
      ["date", "account"].includes(template.fields[key].type),
    ),
  );
}
