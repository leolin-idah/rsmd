import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const docMod = vi.hoisted(() => ({ setDocMode: vi.fn() }));
vi.mock("./preview/document", () => docMod);

import { StatusBar } from "./StatusBar";
import { useShellStore } from "./store";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const s = () => useShellStore.getState();
const meta = (docId: number, path: string) => ({ docId, path, fileName: path.split("/").pop()! });

describe("StatusBar", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    useShellStore.setState({ tabs: [], active: null, modes: {}, stats: {} });
    vi.clearAllMocks();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<StatusBar />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const text = (sel: string) => container.querySelector(sel)?.textContent ?? null;
  const radio = (mode: string) =>
    container.querySelector<HTMLInputElement>(`input[name="mode"][value="${mode}"]`)!;

  it("is empty with the mode control disabled when no document is open", () => {
    expect(container.querySelector("#statusbar")).not.toBeNull();
    expect(text(".status-path")).toBe("");
    expect(container.querySelector(".status-stats")).toBeNull();
    expect(radio("preview").disabled).toBe(true);
  });

  it("shows the active document's folder, file name, counts and mode", async () => {
    await act(async () => {
      s().addDoc(meta(1, "/x/docs/1.md"), true);
      s().setStats(1, { words: 3, chars: 10 });
      s().setMode(1, "live");
    });
    expect(text(".status-dir")).toBe("/x/docs/");
    expect(text(".status-name")).toBe("1.md");
    expect(text(".status-stats")).toBe("3 words · 10 chars");
    expect(radio("live").checked).toBe(true);
    expect(radio("live").disabled).toBe(false);
  });

  it("uses singular labels for a single word / character", async () => {
    await act(async () => {
      s().addDoc(meta(1, "/x/1.md"), true);
      s().setStats(1, { words: 1, chars: 1 });
    });
    expect(text(".status-stats")).toBe("1 word · 1 char");
  });

  it("follows the active tab: switching docs shows that doc's mode and counts", async () => {
    await act(async () => {
      s().addDoc(meta(1, "/x/1.md"), true);
      s().addDoc(meta(2, "/x/2.md"), false);
      s().setStats(2, { words: 7, chars: 30 });
      s().setMode(2, "source");
    });
    expect(radio("preview").checked).toBe(true);
    await act(async () => {
      s().setActive(2);
    });
    expect(text(".status-name")).toBe("2.md");
    expect(text(".status-stats")).toBe("7 words · 30 chars");
    expect(radio("source").checked).toBe(true);
  });

  it("picking a mode switches the active document through setDocMode", async () => {
    await act(async () => {
      s().addDoc(meta(1, "/x/1.md"), true);
    });
    await act(async () => {
      radio("source").click();
    });
    expect(docMod.setDocMode).toHaveBeenCalledWith(1, "source");
  });
});
