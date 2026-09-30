import { useState } from "react";
import { api, type Journal } from "./api";
import { Notice } from "./ui";
import type { DraftItem } from "./BatchEditor";

export default function Finance({
  date,
  accounts,
  onAdd,
}: {
  date: string;
  accounts: Journal["accounts"];
  onAdd: (item: DraftItem) => boolean | void;
}) {
  const [form, setForm] = useState({
    kind: "transfer",
    account: "",
    target: "",
    amount: "",
    currency: "CNY",
    fee: "0",
    fee_account: "",
    note: "",
  });
  const [result, setResult] = useState<
    DraftItem & { actual?: string; expected?: string; difference?: string }
  >();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resultDate, setResultDate] = useState("");
  function change(key: keyof typeof form, value: string) {
    setForm({ ...form, [key]: value });
    setResult(undefined);
  }
  const select = (
    key: "account" | "target" | "fee_account",
    label: string,
    prefixes: string[],
  ) => (
    <label className="field">
      <span>{label}</span>
      <select
        aria-label={label}
        value={form[key]}
        onChange={(e) => change(key, e.target.value)}
      >
        <option value="">请选择</option>
        {accounts
          .filter((a) => prefixes.some((p) => a.name.startsWith(p)))
          .map((a) => (
            <option key={a.name}>{a.name}</option>
          ))}
      </select>
    </label>
  );
  async function compose() {
    setBusy(true);
    setResult(undefined);
    try {
      setResult(
        await api("/finance/compose", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...form, date }),
        }),
      );
      setResultDate(date);
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="file-card">
      <summary>转账、信用账户还款与余额核对</summary>
      <p className="muted">
        转入金额为账户实际收到金额，手续费另列。还款减少信用账户负债，不再次计入消费。余额断言检查所选日期开始时的余额（含子账户，不含当天交易）；核对日终余额请选次日。
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void compose();
        }}
      >
        <fieldset disabled={busy}>
          <div className="form-grid">
            <label className="field">
              <span>账户业务</span>
              <select
                aria-label="账户业务"
                value={form.kind}
                onChange={(e) => change("kind", e.target.value)}
              >
                <option value="transfer">转账</option>
                <option value="repayment">信用账户还款</option>
                <option value="balance">余额断言</option>
              </select>
            </label>
            {select(
              "account",
              form.kind === "balance" ? "核对账户" : "转出账户",
              ["Assets:", "Liabilities:"],
            )}
            {form.kind !== "balance" &&
              select(
                "target",
                "转入 / 还款账户",
                form.kind === "repayment"
                  ? ["Liabilities:"]
                  : ["Assets:", "Liabilities:"],
              )}
            {(["amount", "currency", "note"] as const).map((key, i) => (
              <label className="field" key={key}>
                <span>
                  {
                    [
                      form.kind === "balance" ? "预期余额" : "转入金额",
                      "账户币种",
                      "账户备注",
                    ][i]
                  }
                </span>
                <input
                  aria-label={
                    [
                      form.kind === "balance" ? "预期余额" : "转入金额",
                      "账户币种",
                      "账户备注",
                    ][i]
                  }
                  required={key !== "note"}
                  value={form[key]}
                  onChange={(e) => change(key, e.target.value)}
                />
              </label>
            ))}
            {form.kind !== "balance" && (
              <>
                <label className="field">
                  <span>手续费</span>
                  <input
                    aria-label="手续费"
                    value={form.fee}
                    onChange={(e) => change("fee", e.target.value)}
                  />
                </label>
                {select("fee_account", "手续费分类", ["Expenses:"])}
              </>
            )}
          </div>
          <button>生成分录 / 核对差额</button>
        </fieldset>
      </form>
      {result && resultDate === date && (
        <>
          <pre>{result.raw}</pre>
          {result.actual !== undefined && (
            <p>
              预期 {result.expected} · 账面实际 {result.actual} ·
              差额（实际减预期）{result.difference}。不会自动补差或增加 pad。
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              if (
                onAdd({ business: result.business, raw: result.raw }) === false
              )
                return;
              setResult(undefined);
            }}
          >
            将核对结果加入草稿
          </button>
        </>
      )}
    </details>
  );
}
