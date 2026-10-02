import { useEffect, useState } from "react";
import { shanghaiToday } from "./format";

/** 长时间打开或从休眠恢复时，仍按上海日期判断今天。 */
export function useToday() {
  const [today, setToday] = useState(shanghaiToday);
  useEffect(() => {
    const refresh = () => setToday(shanghaiToday());
    const timer = window.setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return today;
}
