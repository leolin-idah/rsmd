import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({ assetUrl: (p: string) => `asset://localhost${p}` }));

import { createPmEditor, type PmEditor } from "../pmEditor";
import { joinPosix, localImageFeature, resolveImageSrc } from "./localImage";

describe("resolveImageSrc", () => {
  it("joins relative paths onto baseDir and converts to an asset URL", () => {
    expect(resolveImageSrc("./demo.png", "/docs")).toBe("asset://localhost/docs/demo.png");
    expect(resolveImageSrc("img/a.png", "/docs/sub")).toBe("asset://localhost/docs/sub/img/a.png");
    expect(resolveImageSrc("../a/b.png", "/docs/sub")).toBe("asset://localhost/docs/a/b.png");
  });

  it("converts absolute paths and leaves URLs alone", () => {
    expect(resolveImageSrc("/x/y.png", "/docs")).toBe("asset://localhost/x/y.png");
    expect(resolveImageSrc("https://e.com/a.png", "/docs")).toBe("https://e.com/a.png");
    expect(resolveImageSrc("data:image/png;base64,AA==", "/docs")).toBe("data:image/png;base64,AA==");
    expect(resolveImageSrc("", "/docs")).toBe("");
  });

  it("normalizes . and .. segments", () => {
    expect(joinPosix("/a/b", "./c/../d.png")).toBe("/a/b/d.png");
  });
});

describe("image node view", () => {
  let editor: PmEditor | null = null;
  afterEach(async () => {
    await editor?.destroy();
    editor = null;
    document.body.innerHTML = "";
  });

  it("rewrites src for rendering but keeps the markdown untouched", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    editor = await createPmEditor({ parent, text: "![local image](./demo.png)\n", editable: false, features: [localImageFeature("/docs")] });
    const img = editor.view().dom.querySelector<HTMLImageElement>("img.rsmd-image")!;
    expect(img.getAttribute("src")).toBe("asset://localhost/docs/demo.png");
    expect(img.alt).toBe("local image");
    expect(img.dataset.raw).toBe("./demo.png");
    expect(img.loading).toBe("lazy");
    expect(editor.getMarkdown().trim()).toBe("![local image](./demo.png)");
    img.dispatchEvent(new Event("error"));
    expect(img.dataset.error).toBe("true");
  });

  it("keeps the error state across attr-only updates, and only clears it when src actually changes", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    editor = await createPmEditor({ parent, text: "![a](./demo.png)\n", editable: false, features: [localImageFeature("/docs")] });
    const view = editor.view();
    const img = view.dom.querySelector<HTMLImageElement>("img.rsmd-image")!;
    img.dispatchEvent(new Event("error"));
    expect(img.dataset.error).toBe("true");

    let pos = -1;
    view.state.doc.descendants((node, p) => {
      if (node.type.name === "image") pos = p;
    });
    expect(pos).toBeGreaterThanOrEqual(0);

    // 只改 alt，src 不变：不该重新加载图片，错误态应该保留
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...view.state.doc.nodeAt(pos)!.attrs, alt: "b" }));
    expect(img.alt).toBe("b");
    expect(img.dataset.error).toBe("true");

    // 改 src：应该重新加载并清掉错误态
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...view.state.doc.nodeAt(pos)!.attrs, src: "./other.png" }));
    expect(img.dataset.error).toBeUndefined();
    expect(img.getAttribute("src")).toBe("asset://localhost/docs/other.png");
  });
});
