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
