import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const ipc = vi.hoisted(() => ({
  setActiveDoc: vi.fn(async (_id: number) => {}),
  closeDoc: vi.fn(async (_id: number) => {}),
}));
vi.mock("./ipc", () => ipc);

import App from "./App";
import { useShellStore } from "./store";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const meta = (docId: number) => ({ docId, path: `/x/${docId}.md`, fileName: `${docId}.md` });
const s = () => useShellStore.getState();

/// 只放行微任务：store 更新经 useSyncExternalStore 以 SyncLane 调度，React 在微任务里提交。
/// 这里绝不等待宏任务——配合 fake timers，若 React 需要一个 timer 才能提交，断言会失败。
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("App shell", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    useShellStore.setState({ tabs: [], active: null, notices: {}, error: null });
    vi.clearAllMocks();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });
    // 下面在 act 之外更新 store，观察真实的提交时机而非 act 的强制刷新
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });

  afterEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    act(() => root.unmount());
    container.remove();
  });

  const tabEls = () => Array.from(container.querySelectorAll<HTMLElement>(".tab"));

  it("removes the welcome text before the next paint (no macrotask needed)", async () => {
    expect(container.querySelector(".welcome")).not.toBeNull();
    vi.useFakeTimers();
    try {
      // events.ts 在同一任务里紧接着把正文同步插入 DOM：欢迎语必须在绘制前消失，
      // 否则两者会同显一帧，并被随后的同步高亮冻住
      s().addDoc(meta(1), true);
      await settle();
      expect(container.querySelector(".welcome")).toBeNull();
      expect(tabEls().length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("switches the active tab on click, locally first, then tells Rust", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      s().addDoc(meta(1), true);
      s().addDoc(meta(2), true); // active = 2
      await settle();
      const [tabA, tabB] = tabEls();
      expect(tabB.classList.contains("active")).toBe(true);

      tabA.click();
      expect(s().active).toBe(1); // 本地先行：store 同步切换
      await settle();
      expect(tabA.classList.contains("active")).toBe(true);
      expect(tabB.classList.contains("active")).toBe(false);
      expect(ipc.setActiveDoc).toHaveBeenCalledWith(1);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("asks Rust to close a tab without selecting it", async () => {
    s().addDoc(meta(1), true);
    s().addDoc(meta(2), true);
    await settle();
    const [tabA] = tabEls();
    tabA.querySelector<HTMLElement>(".tab-close")!.click();
    expect(ipc.closeDoc).toHaveBeenCalledWith(1);
    expect(ipc.setActiveDoc).not.toHaveBeenCalled();
    expect(s().active).toBe(2); // 列表变更由 Rust 的 document-closed 回来驱动
  });

  it("scrolls the active tab into view when the active doc changes", async () => {
    // tab 条溢出后横向滚动：从菜单/快捷键切到滚动区外的文档时，得把 active tab 拉回可见区
    const scrolled: Element[] = [];
    // jsdom 不实现 scrollIntoView，装一个只记录 this 的桩
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      s().addDoc(meta(1), true);
      s().addDoc(meta(2), true); // active = 2
      await settle();
      const [tabA, tabB] = tabEls();
      expect(scrolled.at(-1)).toBe(tabB);
      s().setActive(1);
      await settle();
      expect(scrolled.at(-1)).toBe(tabA);
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it("shows the global error banner until the next successful open", async () => {
    s().setError("Cannot open: nope");
    await settle();
    expect(container.querySelector(".banner")?.textContent).toBe("Cannot open: nope");
    s().addDoc(meta(1), true);
    await settle();
    expect(container.querySelector(".banner")).toBeNull();
  });

  it("shows a doc's notice and tab dot only while that doc is active", async () => {
    s().addDoc(meta(1), true);
    s().addDoc(meta(2), true); // active = 2
    s().setNotice(1, "File was deleted");
    await settle();
    expect(container.querySelector(".banner")).toBeNull();
    const [tabA, tabB] = tabEls();
    expect(tabA.querySelector(".tab-dot")).not.toBeNull();
    expect(tabB.querySelector(".tab-dot")).toBeNull();

    s().setActive(1);
    await settle();
    expect(container.querySelector(".banner")?.textContent).toBe("File was deleted");
  });
});
