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

/** 业务显示名：优先配置名称，其次内置名称，最后业务标识。 */
export function routeLabel(business: string, label?: string) {
  return label?.trim() || businessNames[business] || business;
}

/** 与后端 Layout.chain 相同：按业务的日期来源解析路径占位符。 */
export function chainOf(
  entry: string,
  route: BusinessRoute,
  day: string,
  writeDay: string,
): string[] {
  const source = route.date_source === "write" ? writeDay : day;
  const parts = /^\d{4}-\d{2}-\d{2}$/.test(source) ? source.split("-") : null;
  return [entry, ...route.indexes, route.target].map((path) =>
    parts
      ? path
          .replaceAll("{year}", parts[0])
          .replaceAll("{month}", parts[1])
          .replaceAll("{day}", parts[2])
      : path,
  );
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** 路径规则与后端 validate_path 一致；dated 为 false 时禁止日期占位符。 */
export function pathIssue(path: string, dated = true): string {
  const value = path.trim();
  if (!value) return "路径不能为空";
  const tokens = ["{year}", "{month}", "{day}"];
  if (/[{}]/.test(value.replace(/\{(?:year|month|day)\}/g, "")))
    return dated
      ? "仅支持 {year}、{month}、{day} 占位符"
      : "入口路径不支持日期占位符";
  if (!dated && tokens.some((token) => value.includes(token)))
    return "入口路径不支持日期占位符";
  if (tokens.some((token) => value.split(token).length > 2))
    return "同一日期占位符最多出现一次";
  const plain = value
    .replaceAll("{year}", "2026")
    .replaceAll("{month}", "09")
    .replaceAll("{day}", "30");
  if (!/^[\p{L}\p{N}_/.-]+$/u.test(plain))
    return "只允许中文、字母、数字、下划线、连字符、点和斜杠";
  if (!/\.(bean|beancount)$/.test(plain))
    return "需使用 .bean 或 .beancount 扩展名";
  if (plain.length > 240) return "路径过长";
  if (
    plain.split("/").some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.startsWith(".") ||
        part.endsWith(".") ||
        RESERVED.test(part),
    )
  )
    return "存在空路径段、上级目录或保留名称";
  if (dated && plain.toLowerCase().startsWith("gnucash/"))
    return "gnucash/ 历史导入目录只读";
  return "";
}

function valueIssue(type: TemplateField["type"], value: string): string {
  switch (type) {
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(value) ? "" : "日期应为 YYYY-MM-DD";
    case "amount":
      return /^-?\d{1,16}(?:\.\d{1,8})?$/.test(value)
        ? ""
        : "金额应为最多 16 位整数、8 位小数的十进制数";
    case "account":
      return /^(?:Assets|Liabilities|Equity|Income|Expenses):[^\s";{}]+$/.test(value)
        ? ""
        : "账户需为 Assets: 等完整账户名";
    case "currency":
      return /^[A-Z][A-Z0-9._-]{0,23}$/.test(value)
        ? ""
        : "币种需为大写代码，例如 CNY";
    case "token":
      return /^(?:[*!]|[#^][A-Za-z0-9_/-]+)$/.test(value)
        ? ""
        : "标记或标签需形如 *、!、#tag 或 ^link";
    default:
      return "";
  }
}

/** 单个字段能否被后端接受；空串表示没有发现问题。 */
export function fieldIssue(field: TemplateField): string {
  if (!field.label.trim()) return "显示名称不能为空";
  if (field.mode === "today" && field.type !== "date")
    return "自动当天仅适用于日期字段";
  if (field.type === "token" && !field.value)
    return "标记或标签字段需要默认值，例如 *、#tag 或 ^link";
  if (field.mode === "fixed" || field.value)
    return valueIssue(field.type, field.value);
  return "";
}

const SLOT = /\{\{(-?)([a-z][a-z0-9_]*)\}\}/y;

/** 原文的占位符格式检查，覆盖后端拒绝的写法。 */
export function sourceIssue(template: RecordTemplate): string {
  if (!template.source.trim()) return "模板原文不能为空";
  const leftover = template.source.replace(/\{\{-?[a-z][a-z0-9_]*\}\}/g, "");
  if (leftover.includes("{{") || leftover.includes("}}"))
    return "字段占位符格式为 {{name}}，金额可用 {{-name}} 取负值";
  for (const line of template.source.split("\n")) {
    let quoted = false;
    let comment = false;
    let escaped = false;
    let pos = 0;
    while (pos < line.length) {
      SLOT.lastIndex = 0;
      const match = SLOT.exec(line.slice(pos));
      if (match) {
        const end = pos + match[0].length;
        if (
          quoted ||
          comment ||
          (pos > 0 && !/\s/.test(line[pos - 1])) ||
          (end < line.length && !/\s/.test(line[end]))
        )
          return `占位符 ${match[0]} 必须独立放置，不可放在引号、注释或其他 token 内`;
        if (match[1] && template.fields[match[2]]?.type !== "amount")
          return `只有金额字段可以取负值：${match[0]}`;
        pos = end;
        continue;
      }
      const char = line[pos];
      if (!comment) {
        if (char === '"' && !escaped) quoted = !quoted;
        if (char === ";" && !quoted) comment = true;
        escaped = char === "\\" && !escaped;
      }
      pos += 1;
    }
  }
  return "";
}

/** 单个业务的规则问题；为空表示没有发现客户端可确认的问题。 */
export function routeIssues(
  layout: Layout,
  business: string,
  day: string,
  writeDay: string,
): string[] {
  const route = layout.routes[business];
  if (!route) return [];
  const issues: string[] = [];
  const target = pathIssue(route.target);
  if (target) issues.push(`目标文件：${target}`);
  route.indexes.forEach((index, position) => {
    if (!index.trim()) return;
    const issue = pathIssue(index);
    if (issue) issues.push(`索引链第 ${position + 1} 行：${issue}`);
  });
  if (route.template) {
    const source = sourceIssue(route.template);
    if (source) issues.push(`模板原文：${source}`);
    for (const [key, field] of Object.entries(route.template.fields)) {
      const issue = fieldIssue(field);
      if (issue) issues.push(`{{${key}}}：${issue}`);
    }
  }
  // 同一文件被两处使用：完全相同可确定命中后端校验；索引之间共享同一文件是允许的。
  const chain = chainOf(layout.entry, route, day, writeDay);
  const forIndex = new Map<string, string>([
    [layout.entry.toLowerCase(), "账本入口"],
  ]);
  const forTarget = new Map<string, string>([
    [layout.entry.toLowerCase(), "账本入口"],
  ]);
  for (const other of Object.keys(layout.routes)) {
    if (other === business) continue;
    const label = routeLabel(other, layout.routes[other].label);
    const otherChain = chainOf(layout.entry, layout.routes[other], day, writeDay);
    forTarget.set(otherChain.at(-1)!.toLowerCase(), label);
    forIndex.set(otherChain.at(-1)!.toLowerCase(), label);
    otherChain.slice(1, -1).forEach((path) => {
      if (!forTarget.has(path.toLowerCase()))
        forTarget.set(path.toLowerCase(), `${label}的索引`);
    });
  }
  route.indexes.forEach((index, position) => {
    const resolved = chain[position + 1];
    const owner = forIndex.get(resolved.toLowerCase());
    if (owner)
      issues.push(`索引链第 ${position + 1} 行与「${owner}」使用同一文件 ${resolved}`);
  });
  const resolvedTarget = chain.at(-1)!;
  const owner = forTarget.get(resolvedTarget.toLowerCase());
  if (owner)
    issues.push(`目标文件与「${owner}」使用同一文件 ${resolvedTarget}`);
  if (
    route.indexes.some(
      (_, position) =>
        chain[position + 1].toLowerCase() === resolvedTarget.toLowerCase(),
    )
  )
    issues.push(`目标文件与自身索引使用同一文件 ${resolvedTarget}`);
  return issues;
}

export interface TemplateSummary {
  input: { key: string; field: TemplateField }[];
  fixed: { key: string; field: TemplateField }[];
  today: { key: string; field: TemplateField }[];
}

/** 模板字段按填写方式分组，用于录入提示与设置概览。 */
export function templateSummary(template: RecordTemplate): TemplateSummary {
  const entries = Object.entries(template.fields).map(([key, field]) => ({
    key,
    field,
  }));
  return {
    input: entries.filter((item) => item.field.mode === "input"),
    fixed: entries.filter((item) => item.field.mode === "fixed"),
    today: entries.filter((item) => item.field.mode === "today"),
  };
}

/** 记录模板的填写示意：用户填写项以〈名称〉占位，其余按固定值渲染。 */
export function renderExample(template: RecordTemplate, today: string): string {
  return template.source.replace(
    /\{\{(-?)([a-z][a-z0-9_]*)\}\}/g,
    (_, negative: string, key: string) => {
      const field = template.fields[key];
      if (!field) return `{{${negative}${key}}}`;
      const value =
        field.mode === "today"
          ? today
          : field.mode === "fixed" || field.value
            ? field.type === "text"
              ? JSON.stringify(field.value)
              : field.value
            : `〈${field.label}〉`;
      return negative ? `-${value}` : value;
    },
  );
}

/** 与当前生效配置相比有改动的业务；入口或整体结构变化由调用方另行比较。 */
export function changedRoutes(current: Layout, proposed: Layout): string[] {
  const keys = new Set([
    ...Object.keys(current.routes),
    ...Object.keys(proposed.routes),
  ]);
  return [...keys].filter(
    (key) =>
      JSON.stringify(current.routes[key]) !== JSON.stringify(proposed.routes[key]),
  );
}
