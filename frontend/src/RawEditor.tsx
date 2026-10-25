import { useId, useLayoutEffect, useRef, useState } from "react";
import type { EntryCompletions, Journal } from "./api";
import { indentRaw } from "./rawIndentation";
import {
  completeBeancount,
  emptyCompletions,
  highlightBeancount,
} from "./beancountEditing";

/** 保留原始文本与原生编辑行为，叠加高亮和光标处候选。 */
export default function RawEditor({
  label,
  value,
  onChange,
  accounts,
  completions = emptyCompletions,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  accounts: Journal["accounts"];
  completions?: EntryCompletions;
}) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const highlight = useRef<HTMLElement>(null);
  const nextSelection = useRef<{
    start: number;
    end: number;
    direction?: "forward" | "backward" | "none";
  } | null>(null);
  const composing = useRef(false);
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState(false);
  const [explicit, setExplicit] = useState(false);
  const [active, setActive] = useState(0);
  const history = {
    ...completions,
    currencies: [
      ...new Set([
        ...completions.currencies,
        ...accounts.flatMap((a) => a.currencies),
      ]),
    ],
  };
  const result = open
    ? completeBeancount(
        value,
        cursor,
        accounts.map((a) => a.name),
        history,
        explicit,
      )
    : undefined;
  const index = Math.min(active, (result?.options.length || 1) - 1);
  useLayoutEffect(() => {
    if (nextSelection.current !== null) {
      const { start, end, direction } = nextSelection.current;
      input.current?.setSelectionRange(start, end, direction);
      nextSelection.current = null;
    }
  }, [value, open]);
  useLayoutEffect(() => {
    if (result)
      document
        .getElementById(`${id}-${index}`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [id, index, result?.from]);
  function choose(index: number) {
    if (!result) return;
    const option = result.options[index];
    const position = result.from + option.insert.length;
    nextSelection.current = { start: position, end: position };
    onChange(
      value.slice(0, result.from) + option.insert + value.slice(result.to),
    );
    setOpen(false);
    input.current?.focus();
  }
  return (
    <div className="raw-editor">
      <div className="raw-surface">
        <pre className="raw-highlight" aria-hidden="true">
          <code ref={highlight}>
            {highlightBeancount(value).map((token, i) =>
              token.kind ? (
                <span key={i} className={`bean-token-${token.kind}`}>
                  {token.text}
                </span>
              ) : (
                token.text
              ),
            )}
            {"\n"}
          </code>
        </pre>
        <textarea
          ref={input}
          aria-label={label}
          className="raw-input"
          required
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          value={value}
          wrap="off"
          aria-autocomplete="list"
          aria-controls={result ? id : undefined}
          aria-activedescendant={result ? `${id}-${index}` : undefined}
          aria-describedby={`${id}-help`}
          onChange={(e) => {
            onChange(e.target.value);
            setCursor(e.target.selectionStart);
            setOpen(!composing.current);
            setActive(0);
            setExplicit(false);
          }}
          onSelect={(e) => {
            setCursor(e.currentTarget.selectionStart);
            if (e.currentTarget.selectionStart !== e.currentTarget.selectionEnd)
              setOpen(false);
          }}
          onBlur={() => setOpen(false)}
          onCompositionStart={() => {
            composing.current = true;
            setOpen(false);
          }}
          onCompositionEnd={(e) => {
            composing.current = false;
            setCursor(e.currentTarget.selectionStart);
            setOpen(true);
          }}
          onScroll={(e) => {
            if (highlight.current) {
              // 直接同步位移，避免两层滚动条宽度不同导致末端文字错位。
              highlight.current.style.transform = `translate(${-e.currentTarget.scrollLeft}px, ${-e.currentTarget.scrollTop}px)`;
            }
          }}
          onKeyDown={(e) => {
            const tab =
              e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey;
            if (tab) e.preventDefault();
            if (
              e.nativeEvent.isComposing ||
              e.keyCode === 229 ||
              composing.current
            )
              return;
            if (tab) {
              e.stopPropagation();
              const { selectionStart, selectionEnd, selectionDirection } =
                e.currentTarget;
              const edit = indentRaw(
                value,
                selectionStart,
                selectionEnd,
                e.shiftKey,
              );
              if (edit) {
                if (edit.text !== value) {
                  nextSelection.current = {
                    ...edit,
                    direction: selectionDirection,
                  };
                  onChange(edit.text);
                  setCursor(edit.start);
                }
                setOpen(false);
                setExplicit(false);
              } else if (!e.shiftKey && result) {
                choose(index);
              }
            } else if ((e.ctrlKey || e.metaKey) && e.code === "Space") {
              e.preventDefault();
              setOpen(true);
              setExplicit(true);
              setActive(0);
              setCursor(e.currentTarget.selectionStart);
            } else if (e.key === "Escape" && open) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            } else if (
              result &&
              (e.key === "ArrowDown" || e.key === "ArrowUp")
            ) {
              e.preventDefault();
              setActive(
                Math.max(
                  0,
                  Math.min(
                    result.options.length - 1,
                    index + (e.key === "ArrowDown" ? 1 : -1),
                  ),
                ),
              );
            } else if (
              result &&
              e.key === "Enter" &&
              !e.ctrlKey &&
              !e.metaKey
            ) {
              e.preventDefault();
              e.stopPropagation();
              choose(index);
            } else if (
              ["ArrowLeft", "ArrowRight", "Home", "End", "Tab"].includes(e.key)
            )
              setOpen(false);
          }}
        />
      </div>
      {result && (
        <div
          id={id}
          role="listbox"
          aria-label={`${label}候选`}
          className="raw-options account-options"
        >
          {result.options.map((option, i) => (
            <div
              key={option.label}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === index}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(i)}
            >
              {option.label}
            </div>
          ))}
        </div>
      )}
      <small id={`${id}-help`} className="muted">
        输入时显示候选；Ctrl+Space 唤起，↑↓ 选择，Enter 采纳，Esc 关闭。 Tab /
        Shift+Tab 在行首或选区增减两空格；其他位置 Tab
        采纳候选，无候选时不移动焦点。
      </small>
    </div>
  );
}
