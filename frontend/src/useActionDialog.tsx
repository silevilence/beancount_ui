import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Request = {
  id: number;
  message: string;
  title: string;
  acceptLabel: string;
  input: boolean;
  returnFocus: HTMLElement | null;
};

/** Owned by the initiating screen: leaving it cancels any unanswered question. */
export function useActionDialog() {
  const [request, setRequest] = useState<Request | null>(null);
  const resolve = useRef<((value: string | null) => void) | null>(null);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      resolve.current?.(null);
      resolve.current = null;
    };
  }, []);

  function ask(
    next: Omit<Request, "id" | "returnFocus">,
  ): Promise<string | null> {
    // A second click must not start another action behind the same question.
    if (!mounted.current || resolve.current) return Promise.resolve(null);
    const active = document.activeElement;
    if (active instanceof HTMLElement && !active.closest(".action-dialog")) {
      returnFocus.current = active;
    }
    return new Promise((done) => {
      resolve.current = done;
      setRequest({
        ...next,
        id: ++sequence.current,
        returnFocus: returnFocus.current,
      });
    });
  }
  function finish(value: string | null) {
    const done = resolve.current;
    resolve.current = null;
    setRequest(null);
    done?.(value);
  }

  return {
    confirm: async (
      message: string,
      title = "确认操作",
      acceptLabel = "确认继续",
    ) => (await ask({ message, title, acceptLabel, input: false })) !== null,
    prompt: (message: string) =>
      ask({
        message,
        title: "填写核对依据",
        acceptLabel: "下一步",
        input: true,
      }),
    actionDialog: request
      ? createPortal(
          <ActionDialog key={request.id} request={request} onFinish={finish} />,
          document.body,
        )
      : null,
  };
}

function ActionDialog({
  request,
  onFinish,
}: {
  request: Request;
  onFinish: (value: string | null) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    const target = request.returnFocus;
    return () => {
      dialog.close();
      // Wait for the initiating action to clear its busy state after cancellation.
      window.setTimeout(() => {
        if (
          target?.isConnected &&
          !document.querySelector(".action-dialog[open]")
        ) {
          target.focus();
        }
      }, 0);
    };
  }, []);
  function finish(value: string | null) {
    ref.current?.close();
    onFinish(value);
  }
  return (
    <dialog
      ref={ref}
      className="action-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-message`}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      }}
      onClose={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = event.currentTarget.querySelectorAll<HTMLElement>(
          "button:not(:disabled), textarea:not(:disabled)",
        );
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <h2 id={`${id}-title`}>{request.title}</h2>
      <p id={`${id}-message`} className="action-dialog-message">
        {request.message}
      </p>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (request.input && value.trim().length < 10) {
            setError(
              "核对依据至少 10 字，请补充远端日志、批次和原执行已停止的核对结果。此次未提交。",
            );
            return;
          }
          finish(request.input ? value.trim() : "confirmed");
        }}
      >
        {request.input && (
          <label>
            核对依据
            <textarea
              autoFocus
              rows={5}
              required
              minLength={10}
              value={value}
              aria-invalid={!!error}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(event) => {
                setValue(event.target.value);
                setError("");
              }}
            />
          </label>
        )}
        {error && (
          <p id={`${id}-error`} role="alert">
            {error}
          </p>
        )}
        <div className="action-dialog-actions">
          <button
            type="button"
            className="ghost"
            autoFocus={!request.input}
            onClick={() => finish(null)}
          >
            取消
          </button>
          <button type="submit">{request.acceptLabel}</button>
        </div>
      </form>
    </dialog>
  );
}
