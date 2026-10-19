import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import Settings from "./Settings";

vi.mock("./LayoutDialog", () => ({ default: ({ onClose }: {onClose: () => void}) =>
  <button onClick={onClose}>取消布局编辑</button> }));
vi.mock("./SyncDialog", () => ({ default: ({ onClose }: {onClose: () => void}) =>
  <button onClick={onClose}>取消备份编辑</button> }));

it("设置复用既有编辑器，取消后保留统一入口", () => {
  render(<Settings onChanged={async () => {}} />);
  fireEvent.click(screen.getByText("编辑布局与模板"));
  fireEvent.click(screen.getByText("取消布局编辑"));
  expect(screen.queryByText("取消布局编辑")).toBeNull();
  fireEvent.click(screen.getByText("编辑备份设置"));
  fireEvent.click(screen.getByText("取消备份编辑"));
  expect(screen.getByRole("heading", {name: "设置"})).toBeInTheDocument();
  expect(screen.getByText(/普通记账可继续/)).toBeInTheDocument();
});
