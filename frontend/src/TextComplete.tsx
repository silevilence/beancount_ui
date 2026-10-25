import { useEffect, useId, useState } from "react";

/** 历史值只作建议，允许自由输入；选择候选不会提交表单。 */
export default function TextComplete({
  label,
  value,
  options,
  onChange,
  disabled,
  maxLength,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  disabled?: boolean;
  maxLength?: number;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const matches = options
    .filter((o) => o.toLocaleLowerCase().includes(value.toLocaleLowerCase()))
    .slice(0, 50);
  const index = Math.min(active, Math.max(0, matches.length - 1));
  const expanded = open && matches.length > 0;
  useEffect(() => {
    if (expanded)
      document
        .getElementById(`${id}-${index}`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [expanded, id, index]);
  function choose(next: string) {
    onChange(next);
    setOpen(false);
  }
  return (
    <div className="account-select">
      <input
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? id : undefined}
        aria-activedescendant={expanded ? `${id}-${index}` : undefined}
        autoComplete="off"
        value={value}
        disabled={disabled}
        maxLength={maxLength}
        onFocus={() => {
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            setActive(
              Math.max(
                0,
                Math.min(
                  matches.length - 1,
                  open ? index + (e.key === "ArrowDown" ? 1 : -1) : 0,
                ),
              ),
            );
          } else if (
            e.key === "Enter" &&
            expanded &&
            !e.ctrlKey &&
            !e.metaKey
          ) {
            e.preventDefault();
            e.stopPropagation();
            choose(matches[index]);
          }
        }}
      />
      {expanded && (
        <div
          id={id}
          role="listbox"
          aria-label={`${label}候选`}
          className="account-options"
        >
          {matches.map((option, i) => (
            <div
              key={option}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === index}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(option)}
            >
              {option}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
