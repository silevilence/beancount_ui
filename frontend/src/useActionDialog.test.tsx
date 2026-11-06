import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useActionDialog } from "./useActionDialog";

function Harness({
  onResult,
  onOuterCancel = vi.fn(),
  input = false,
}: {
  onResult: (result: boolean | string | null) => void;
  onOuterCancel?: () => void;
  input?: boolean;
}) {
  const { confirm, prompt, actionDialog } = useActionDialog();
  return (
    <dialog open aria-label="编辑记录" onCancel={onOuterCancel}>
      {actionDialog}
      <button
        onClick={async () =>
          onResult(
            await (input ? prompt("请填写核对依据") : confirm("确认此操作？")),
          )
        }
      >
        发起操作
      </button>
    </dialog>
  );
}

it("在编辑器之上展示页面对话框，默认焦点为取消，Escape 只取消当前确认", async () => {
  const result = vi.fn();
  const outerCancel = vi.fn();
  render(
    <StrictMode>
      <Harness onResult={result} onOuterCancel={outerCancel} />
    </StrictMode>,
  );
  const trigger = screen.getByRole("button", { name: "发起操作" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "确认操作" });
  expect(dialog).toBeVisible();
  expect(dialog).toHaveAccessibleDescription("确认此操作？");
  expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("button", { name: "取消" }), {
    key: "Tab",
    shiftKey: true,
  });
  expect(screen.getByRole("button", { name: "确认继续" })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("button", { name: "确认继续" }), {
    key: "Tab",
  });
  expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
  expect(result).not.toHaveBeenCalled();
  fireEvent(dialog, new Event("cancel", { bubbles: true, cancelable: true }));
  await waitFor(() => expect(result).toHaveBeenCalledExactlyOnceWith(false));
  expect(outerCancel).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "编辑记录" })).toBeVisible();
  await waitFor(() => expect(trigger).toHaveFocus());
});

it("连续点击不叠加确认，也不把一次确认用于多次操作", async () => {
  const result = vi.fn();
  render(<Harness onResult={result} />);
  const trigger = screen.getByRole("button", { name: "发起操作" });
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  expect(screen.getAllByRole("dialog", { name: "确认操作" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "确认继续" }));
  await waitFor(() => expect(result).toHaveBeenCalledTimes(2));
  expect(result.mock.calls.filter(([accepted]) => accepted)).toHaveLength(1);
  expect(window.confirm).not.toHaveBeenCalled();
});

it("离开发起页面会取消等待中的确认并移除浮层", async () => {
  const result = vi.fn();
  const view = render(<Harness onResult={result} />);
  fireEvent.click(screen.getByRole("button", { name: "发起操作" }));
  view.unmount();
  await waitFor(() => expect(result).toHaveBeenCalledExactlyOnceWith(false));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("输入框内校验并保留不足十字的依据，修正后返回去除首尾空白的文本", async () => {
  const result = vi.fn();
  render(<Harness input onResult={result} />);
  fireEvent.click(screen.getByRole("button", { name: "发起操作" }));
  const input = screen.getByLabelText("核对依据");
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: "   短依据   " } });
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
  expect(result).not.toHaveBeenCalled();
  expect(input).toHaveValue("   短依据   ");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("alert")).toHaveTextContent("至少 10 字");
  fireEvent.change(input, {
    target: { value: "  已核对完整日志且原执行已停止  " },
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
  await waitFor(() =>
    expect(result).toHaveBeenCalledExactlyOnceWith(
      "已核对完整日志且原执行已停止",
    ),
  );
  expect(window.prompt).not.toHaveBeenCalled();
});
