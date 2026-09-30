import type { ReactNode } from "react";

export function Notice({
  tone = "info",
  children,
  action,
}: {
  tone?: "info" | "warn" | "error";
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`notice ${tone}`} role={tone === "error" ? "alert" : "status"}>
      <p>{children}</p>
      {action && <div className="notice-action">{action}</div>}
    </div>
  );
}

export type ChipTone =
  | "muted"
  | "expense"
  | "income"
  | "transfer"
  | "warn"
  | "ok";

/** 状态小标签：类型、草稿、未结清、已退款等短标记。 */
export function Chip({
  tone = "muted",
  title,
  children,
}: {
  tone?: ChipTone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={`chip ${tone}`} title={title}>
      {children}
    </span>
  );
}

export interface SegmentedOption {
  value: string;
  label: string;
  hint?: string;
}

/** 一组互斥选项，用于作业类型与处理方式切换。 */
export function Segmented({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: SegmentedOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          title={option.hint}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface Fact {
  label: string;
  value: ReactNode;
}

/** 键值清单：来源、账户、状态等事实密度高的信息。 */
export function Facts({ items }: { items: Fact[] }) {
  return (
    <dl className="facts">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
