import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Settings } from "../ipc";

const ipc = vi.hoisted(() => ({
  setSettings: vi.fn(async (_s: Settings) => {}),
}));
vi.mock("../ipc", () => ipc);

const editor = vi.hoisted(() => ({ focus: vi.fn() }));
vi.mock("../preview/document", () => ({
  editorFor: (docId: number) => (docId === 1 ? { focus: editor.focus } : null),
}));

import { SettingsPanel } from "./SettingsPanel";
import { useShellStore } from "../store";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const base: Settings = { layout: "tabs", toc: true, tocSide: "right", wrapCode: false };
const s = () => useShellStore.getState();

describe("SettingsPanel", () => {
  let root: Root;
  let container: HTMLDivElement;

  const mount = async (settings: Settings | null = base): Promise<void> => {
    useShellStore.setState({
      settings,
      settingsOpen: true,
      active: 1,
      tabs: [{ docId: 1, path: "/x/1.md", fileName: "1.md", label: "1.md" }],
      error: null,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<SettingsPanel />);
    });
  };
  const input = (label: string): HTMLInputElement => {
    const el = Array.from(container.querySelectorAll("label")).find((l) =>
      l.textContent?.includes(label)
    );
    if (!el) throw new Error(`no control labelled ${label}`);
    return el.querySelector("input")!;
  };
  const click = (el: HTMLElement) => act(() => el.click());

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders nothing until settings have arrived", async () => {
    await mount(null);
    expect(container.querySelector(".settings-panel")).toBeNull();
  });

  it("reflects the current settings in its controls", async () => {
    await mount({ layout: "sideList", toc: true, tocSide: "left", wrapCode: true });
    expect(input("Side list").checked).toBe(true);
    expect(input("Tabs").checked).toBe(false);
    expect(input("Show table of contents").checked).toBe(true);
    expect(input("Left").checked).toBe(true);
    expect(input("Wrap long lines").checked).toBe(true);
  });

  it("focuses the first control so keystrokes stop reaching the editor", async () => {
    await mount();
    expect(document.activeElement).toBe(input("Tabs"));
  });

  it("toggling a checkbox updates the store first, then tells Rust the full settings", async () => {
    await mount();
    await click(input("Wrap long lines"));
    expect(s().settings).toEqual({ ...base, wrapCode: true }); // 本地先行
    expect(ipc.setSettings).toHaveBeenCalledWith({ ...base, wrapCode: true });
    expect(input("Wrap long lines").checked).toBe(true);
  });

  it("choosing a radio sends the merged settings", async () => {
    await mount();
    await click(input("Side list"));
    expect(ipc.setSettings).toHaveBeenCalledWith({ ...base, layout: "sideList" });
    expect(input("Side list").checked).toBe(true);
  });

  it("disables the TOC position radios while the TOC is hidden", async () => {
    await mount({ ...base, toc: false });
    expect(input("Left").disabled).toBe(true);
    expect(input("Right").disabled).toBe(true);
    await click(input("Show table of contents"));
    expect(input("Left").disabled).toBe(false);
  });

  it("Escape closes the panel and hands focus back to the active editor", async () => {
    await mount();
    await act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(s().settingsOpen).toBe(false);
    expect(editor.focus).toHaveBeenCalledTimes(1);
  });

  it("clicking the backdrop closes, clicking inside the panel does not", async () => {
    await mount();
    await click(container.querySelector<HTMLElement>(".settings-panel")!);
    expect(s().settingsOpen).toBe(true);
    await click(container.querySelector<HTMLElement>(".settings-backdrop")!);
    expect(s().settingsOpen).toBe(false);
  });

  it("the close button closes the panel", async () => {
    await mount();
    await click(container.querySelector<HTMLElement>(".settings-close")!);
    expect(s().settingsOpen).toBe(false);
  });

  it("a rejected set_settings becomes the global error banner", async () => {
    ipc.setSettings.mockRejectedValueOnce("disk full");
    await mount();
    await click(input("Wrap long lines"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(s().error).toBe("disk full");
  });
});
