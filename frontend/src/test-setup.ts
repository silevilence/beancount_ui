import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { resetSync } from "./syncStatus";
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
};
beforeEach(() => {
  for (const name of ["alert", "confirm", "prompt"] as const) {
    vi.stubGlobal(
      name,
      vi.fn(() => {
        throw new Error(
          `业务交互必须使用页面内对话框，不得调用 window.${name}`,
        );
      }),
    );
  }
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  resetSync();
});
