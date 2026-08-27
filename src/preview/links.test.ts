import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  openRelative: vi.fn(async (_docId: number, _href: string) => {}),
  openExternal: vi.fn(async (_url: string) => {}),
}));
vi.mock("../ipc", () => ipc);

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
    useShellStore.setState({ error: null });
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

  it("resolves anchors inside the clicked pane only (跨文档同名 id)", () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    const paneA = addPane(host, 1, '<h2 id="intro">A</h2>');
    const paneB = addPane(host, 2, '<h2 id="intro">B</h2>');

    click(paneB, "#intro");
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy.mock.contexts[0]).toBe(paneB.querySelector("#intro"));
    expect(scrollSpy.mock.contexts[0]).not.toBe(paneA.querySelector("#intro"));
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
