import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "./App";
import type { TabsState } from "./tabs";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe("App welcome placeholder", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });
    // 下面要在 act 之外派发原生事件，观察真实的提交时机而非 act 的强制刷新
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });

  afterEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    act(() => root.unmount());
    container.remove();
  });

  it("removes the welcome text in the same task as the first tabs event", () => {
    expect(container.querySelector(".welcome")).not.toBeNull();
    const detail: TabsState = {
      tabs: [{ docId: 1, path: "/x/a.md", fileName: "a.md", label: "a.md", marked: false }],
      active: 1,
    };
    window.dispatchEvent(new CustomEvent("rsmd:tabs", { detail }));
    // events.ts 在同一任务里紧接着把正文同步插入 DOM：欢迎语必须在本任务内消失，
    // 否则两者会同显一帧，并被随后的同步高亮冻住
    expect(container.querySelector(".welcome")).toBeNull();
    expect(container.querySelectorAll(".tab").length).toBe(1);
  });

  it("switches the active tab synchronously from a TabBar click without React warnings", async () => {
    // 第二条 rsmd:tabs 派发路径：TabBar 的 onClick（React 事件处理器内）→ setActiveTab → flushSync
    const tabs = await import("./tabs");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      tabs.addTab(1, "/x/a.md", "a.md", true);
      tabs.addTab(2, "/x/b.md", "b.md", true); // active = 2
      const [tabA, tabB] = Array.from(container.querySelectorAll<HTMLElement>(".tab"));
      expect(tabB.classList.contains("active")).toBe(true);
      tabA.click();
      expect(tabA.classList.contains("active")).toBe(true);
      expect(tabB.classList.contains("active")).toBe(false);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      tabs.removeTab(1, 2);
      tabs.removeTab(2, null);
    }
  });

  it("scrolls the active tab into view when the active doc changes", async () => {
    // tab 条溢出后横向滚动：从菜单/快捷键切到滚动区外的文档时，得把 active tab 拉回可见区
    const tabs = await import("./tabs");
    const scrolled: Element[] = [];
    // jsdom 不实现 scrollIntoView，装一个只记录 this 的桩
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      tabs.addTab(1, "/x/a.md", "a.md", true);
      tabs.addTab(2, "/x/b.md", "b.md", true); // active = 2
      const [tabA, tabB] = Array.from(container.querySelectorAll<HTMLElement>(".tab"));
      expect(scrolled.at(-1)).toBe(tabB);
      tabs.setActiveTab(1);
      expect(scrolled.at(-1)).toBe(tabA);
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
      tabs.removeTab(1, 2);
      tabs.removeTab(2, null);
    }
  });
});
