import { useState } from "react";
import { Notice } from "./ui";
import {
  quickFillKey,
  readFills,
  type FillData,
  type QuickFillTemplate,
} from "./fillTemplates";

/** Mounted per ledger/business; writes compare the latest storage to avoid lost updates. */
export default function QuickFill({
  identity,
  business,
  schema,
  capture,
  onApply,
}: {
  identity?: string;
  business: string;
  schema: string;
  capture: (amounts: boolean) => FillData | undefined;
  onApply: (data: FillData) => void;
}) {
  const key = quickFillKey(identity);
  const [initial] = useState(() => {
    try {
      const text = localStorage.getItem(key);
      return { text, items: readFills(text), error: "" };
    } catch (e) {
      return { text: null, items: [], error: String(e) };
    }
  });
  const [original, setOriginal] = useState(initial.text);
  const [items, setItems] = useState<QuickFillTemplate[]>(initial.items);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [amounts, setAmounts] = useState(false);
  const [error, setError] = useState(initial.error);
  const [message, setMessage] = useState("");
  const choices = items.filter((item) => item.business === business);
  const current = choices.find((item) => item.name === selected);
  function write(next: QuickFillTemplate[]) {
    if (initial.error) throw new Error(initial.error);
    if (localStorage.getItem(key) !== original)
      throw new Error("另一页面已修改模板，请关闭并重新打开编辑窗口后重试。");
    const text = JSON.stringify(next);
    localStorage.setItem(key, text);
    setOriginal(text);
    setItems(next);
  }
  function act(action: () => void) {
    try {
      setError("");
      setMessage("");
      action();
    } catch (e) {
      setError(String(e));
    }
  }
  function save(update: boolean) {
    act(() => {
      const title = update ? selected : name.trim();
      if (!title) throw new Error("请填写模板名称。");
      if (!update && choices.some((item) => item.name === title))
        throw new Error("同名模板已存在，请选择后使用「更新所选模板」。");
      const data = capture(amounts);
      if (!data)
        throw new Error(
          "请切换到表单并填写要保存的字段；原文模式不保存快速填充模板。",
        );
      write([
        ...items.filter(
          (item) => item.business !== business || item.name !== title,
        ),
        { name: title, business, schema, data },
      ]);
      setSelected(title);
      setName("");
      setMessage(`已保存「${title}」，可在当前业务重复使用。`);
    });
  }
  return (
    <section className="quick-fill" aria-label="快速填充设置">
      <div className="work-head">
        <h3>快速填充</h3>
        <p>按业务保存到此浏览器；日期保持当前值，填写后仍需预览确认。</p>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {message && <p role="status">{message}</p>}
      <div className="quick-fill-actions">
        <label className="field">
          <span>快速填充模板</span>
          <select
            aria-label="快速填充模板"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setMessage("");
            }}
          >
            <option value="">选择当前业务的模板</option>
            {choices.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="chip-btn"
          disabled={!current || current.schema !== schema}
          onClick={() =>
            act(() => {
              onApply(structuredClone(current!.data));
              setMessage(`已填充「${current!.name}」，请核对金额与账户。`);
            })
          }
        >
          应用模板
        </button>
        <button
          type="button"
          className="ghost small"
          disabled={!current}
          onClick={() =>
            act(() => {
              write(items.filter((item) => item !== current));
              setSelected("");
              setMessage("已删除模板。");
            })
          }
        >
          删除所选模板
        </button>
      </div>
      {current && current.schema !== schema && (
        <Notice>业务字段已变化，请按当前表单重新填写并更新模板。</Notice>
      )}
      <details>
        <summary>保存或更新当前填写</summary>
        <p className="muted small">
          可只填账户、币种、摘要等常用字段。应用时覆盖模板包含的字段；多行分录和商品明细会整体替换并自动展开。
        </p>
        <div className="quick-fill-actions">
          <label className="field">
            <span>快速模板名称</span>
            <input
              aria-label="快速模板名称"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={amounts}
              onChange={(e) => setAmounts(e.target.checked)}
            />
            包含已填金额
          </label>
          <button
            type="button"
            className="chip-btn"
            onClick={() => save(false)}
          >
            保存为快速模板
          </button>
          <button
            type="button"
            className="ghost small"
            disabled={!current}
            onClick={() => save(true)}
          >
            更新所选模板
          </button>
        </div>
      </details>
    </section>
  );
}
