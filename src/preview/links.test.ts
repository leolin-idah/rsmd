import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  openRelative: vi.fn(async (_docId: number, _href: string) => {}),
  openExternal: vi.fn(async (_url: string) => {}),
}));
vi.mock("../ipc", () => ipc);

const editor = vi.hoisted(() => ({
  scrollToLine: vi.fn(),
  headings: () => [{ id: "intro", line: 12 }],
}));
vi.mock("./document", () => ({ editorFor: (docId: number) => (docId === 7 ? editor : null) }));

import { installLinkHandler } from "./links";
import { useShellStore } from "../store";

function addPane(host: HTMLElement, docId: number, inner = ""): HTMLElement {
  const pane = document.createElement("div");
  pane.className = "pane";
  pane.dataset.docId = String(docId);
  pane.innerHTML = inner;
  host.appendChild(pane);
  return pane;
}

function click(pane: HTMLElement, href: string): void {
  const a = document.createElement("a");
  a.setAttribute("href", href);
  a.textContent = "x";
  pane.appendChild(a);
  a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

describe("installLinkHandler", () => {
  let host: HTMLElement;
  let pane: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    useShellStore.setState({ error: null, modes: {} });
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    pane = addPane(host, 7);
    installLinkHandler(host);
  });

  it("opens http(s) links in system browser", () => {
    click(pane, "https://example.com");
    expect(ipc.openExternal).toHaveBeenCalledWith("https://example.com");
    expect(ipc.openRelative).not.toHaveBeenCalled();
  });

  it("opens relative markdown links via backend with the pane's docId", () => {
    click(pane, "./other.md");
    expect(ipc.openRelative).toHaveBeenCalledWith(7, "./other.md");
  });

  it("strips the fragment from markdown links before invoking", () => {
    click(pane, "./other.md#intro");
    expect(ipc.openRelative).toHaveBeenCalledWith(7, "./other.md");
  });

  it("reports a failed relative open as the global error banner", async () => {
    ipc.openRelative.mockRejectedValueOnce("Cannot open: missing.md");
    click(pane, "./missing.md");
    await Promise.resolve();
    await Promise.resolve();
    expect(useShellStore.getState().error).toBe("Cannot open: missing.md");
  });

  it("scrolls anchors via the pane's editor heading index (target may not be in the DOM)", () => {
    click(pane, "#intro");
    expect(editor.scrollToLine).toHaveBeenCalledWith(12);
  });

  it("ignores anchors whose heading is unknown to the editor", () => {
    click(pane, "#nope");
    expect(editor.scrollToLine).not.toHaveBeenCalled();
  });

  it("in edit mode a plain click on a link inside a rendered block is left to the editor; ⌘+click follows it", () => {
    useShellStore.setState({ modes: { 7: "live" } });
    const block = document.createElement("div");
    block.className = "rsmd-block";
    pane.appendChild(block);
    const a = document.createElement("a");
    a.setAttribute("href", "https://example.com");
    // 编辑态下处理器放行块内链接（不 preventDefault），测试里拦掉默认导航以免 jsdom 报未实现
    a.addEventListener("click", (e) => e.preventDefault());
    block.appendChild(a);
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(ipc.openExternal).not.toHaveBeenCalled();
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
    expect(ipc.openExternal).toHaveBeenCalledWith("https://example.com");
  });

  it("in edit mode links outside rendered blocks (e.g. the TOC) still work on plain click", () => {
    useShellStore.setState({ modes: { 7: "live" } });
    click(pane, "#intro");
    expect(editor.scrollToLine).toHaveBeenCalledWith(12);
  });

  it("ignores links outside any pane", () => {
    const stray = document.createElement("a");
    stray.setAttribute("href", "./other.md");
    // 处理器对 pane 外链接直接放行；测试里拦掉默认导航以免 jsdom 报未实现
    stray.addEventListener("click", (e) => e.preventDefault());
    host.appendChild(stray);
    stray.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(ipc.openRelative).not.toHaveBeenCalled();
  });

  it("is idempotent per host (StrictMode double-mount)", () => {
    installLinkHandler(host);
    click(pane, "https://example.com");
    expect(ipc.openExternal).toHaveBeenCalledTimes(1);
  });
});
