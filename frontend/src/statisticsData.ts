import { useEffect, useState } from "react";
import { api, reasonOf, type Diagnostic } from "./api";
import { shiftDay } from "./format";

export type Grain = "day" | "week" | "month";
export type Preset = "week" | "month" | "year" | "recent" | "custom";
export interface Totals {
  income: string;
  expenses: string;
  net: string;
}
export interface Bucket extends Totals {
  start: string;
  end: string;
  count: number;
}
export interface ReportStatus {
  revision: string;
  view_revision: string;
  stale: boolean;
  available: boolean;
  errors: Diagnostic[];
}
export interface Report extends ReportStatus {
  categories: Record<
    "income" | "expenses",
    { account: string; amount: string }[]
  >;
  start: string;
  end: string;
  grain: Grain;
  currency: string;
  currencies: string[];
  totals: Totals;
  count: number;
  buckets: Bucket[];
}
export interface ReportDetails extends ReportStatus {
  transactions: (Totals & {
    id: string;
    date: string;
    payee: string;
    narration: string;
    file: string;
    line: number;
    raw: string;
    contributions: {
      account: string;
      amount: string;
      currency: string;
      kind: "income" | "expenses";
      note: string;
    }[];
  })[];
}

export function presetRange(preset: Exclude<Preset, "custom">, today: string) {
  if (preset === "recent") return { start: shiftDay(today, -29), end: today };
  if (preset === "year")
    return {
      start: `${today.slice(0, 4)}-01-01`,
      end: `${today.slice(0, 4)}-12-31`,
    };
  if (preset === "week") {
    const offset = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    const start = shiftDay(today, -offset);
    return { start, end: shiftDay(start, 6) };
  }
  const nextMonth = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  return {
    start: `${today.slice(0, 7)}-01`,
    end: shiftDay(nextMonth.toISOString().slice(0, 10), -1),
  };
}

/** Cancel obsolete requests; retain a failed refresh only for the identical query. */
export function useReportResource<T>(
  path: string | null,
  refreshKey: string,
  poll = false,
) {
  const [result, setResult] = useState<{ path: string; data: T }>();
  const [failure, setFailure] = useState<{ path: string; message: string }>();
  const [loading, setLoading] = useState(false);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let timer: number | undefined;
    async function load() {
      setLoading(true);
      try {
        const data = await api<T>(path!, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setResult({ path: path!, data });
          setFailure(undefined);
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setFailure({ path: path!, message: reasonOf(e) });
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          if (poll) timer = window.setTimeout(() => void load(), 5000);
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [path, refreshKey, attempt, poll]);
  return {
    data: result?.path === path ? result.data : undefined,
    error: failure?.path === path ? failure.message : "",
    loading,
    retry: () => retry((value) => value + 1),
  };
}
