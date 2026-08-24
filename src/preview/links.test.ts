import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (..._a: unknown[]) => {});
const openUrl = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (...a: unknown[]) => openUrl(...a) }));

import { installLinkHandler } from "./links";

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
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    pane = addPane(host, 7);
    installLinkHandler(host);
  });

  it("opens http(s) links in system browser", () => {
    click(pane, "https://example.com");
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("opens relative markdown links via backend with the pane's docId", () => {
    click(pane, "./other.md");
    expect(invoke).toHaveBeenCalledWith("open_relative", { docId: 7, href: "./other.md" });
  });

  it("strips the fragment from markdown links before invoking", () => {
    click(pane, "./other.md#intro");
    expect(invoke).toHaveBeenCalledWith("open_relative", { docId: 7, href: "./other.md" });
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
    expect(invoke).not.toHaveBeenCalled();
  });

  it("is idempotent per host (StrictMode double-mount)", () => {
    installLinkHandler(host);
    click(pane, "https://example.com");
    expect(openUrl).toHaveBeenCalledTimes(1);
  });
});
