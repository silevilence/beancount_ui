import { useEffect, useId, useState } from "react";

/** 可搜索的账户选择：搜索文字不作为账户提交，只有现有选项可以选中。 */
export default function AccountSelect({
  label,
  value,
  options,
  onChange,
  required,
  disabled,
}: {
  label: string;
  value: string;
  options: { value: string; label?: string }[];
  onChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<{ base: string; text: string }>();
  const [active, setActive] = useState(0);
  const query = edit?.base === value ? edit.text : "";
  const terms = query.trim().toLocaleLowerCase().split(/\s+/);
  const filtered = options.filter((o) =>
    terms.every((term) =>
      `${o.value} ${o.label ?? ""}`.toLocaleLowerCase().includes(term),
    ),
  );
  const index = Math.min(active, Math.max(filtered.length - 1, 0));
  useEffect(() => {
    if (open)
      document
        .getElementById(`${id}-${index}`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [id, index, open]);
  function choose(next: string) {
    onChange(next);
    setEdit(undefined);
    setOpen(false);
  }
  return (
    <div className="account-select">
      <input
        ref={(node) => {
          node?.setCustomValidity(
            edit?.base === value &&
              edit.text &&
              !options.some((o) => o.value === edit.text)
              ? "请从候选中选择有效账户"
              : "",
          );
        }}
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={id}
        aria-activedescendant={
          open && filtered.length ? `${id}-${index}` : undefined
        }
        autoComplete="off"
        placeholder="输入账户名称筛选"
        required={required}
        disabled={disabled}
        value={edit?.base === value ? edit.text : value}
        onFocus={() => {
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => {
          setOpen(false);
          setEdit(undefined);
        }}
        onChange={(e) => {
          const text = e.target.value;
          const next = options.some((o) => o.value === text) ? text : "";
          setEdit({ base: next, text });
          onChange(next);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
            setEdit(undefined);
          } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            setActive(
              Math.max(
                0,
                Math.min(
                  filtered.length - 1,
                  open ? index + (e.key === "ArrowDown" ? 1 : -1) : 0,
                ),
              ),
            );
          } else if (e.key === "Enter" && open) {
            e.preventDefault();
            if (filtered[index]) choose(filtered[index].value);
          }
        }}
      />
      {open && (
        <div
          id={id}
          role="listbox"
          aria-label={`${label}候选`}
          className="account-options"
        >
          {filtered.length ? (
            filtered.map((o, i) => (
              <div
                key={o.value}
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === index}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(o.value)}
              >
                {o.label ?? o.value}
              </div>
            ))
          ) : (
            <div className="muted small">没有匹配账户</div>
          )}
        </div>
      )}
    </div>
  );
}
