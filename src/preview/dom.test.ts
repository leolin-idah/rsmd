import { describe, expect, it } from "vitest";
import { rawOf, updatePreview } from "./dom";

function container(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("rawOf", () => {
  it("reads code text for pre blocks", () => {
    const el = container('<pre><code class="language-rust">fn x() {}</code></pre>');
    expect(rawOf(el.firstElementChild!)).toBe("fn x() {}");
  });

  it("reads text for math spans and src for images", () => {
    const math = container('<span data-math-style="inline">x^2</span>');
    expect(rawOf(math.firstElementChild!)).toBe("x^2");
    const img = container('<img src="/a/b.png">');
    expect(rawOf(img.firstElementChild!)).toBe("/a/b.png");
  });
});

describe("updatePreview", () => {
  it("updates changed text", () => {
    const c = container('<p data-sourcepos="1:1-1:5">old</p>');
    updatePreview(c, '<p data-sourcepos="1:1-1:5">new</p>');
    expect(c.textContent).toBe("new");
  });

  it("preserves element identity of unchanged siblings", () => {
    const c = container("<p>same</p><p>old</p>");
    const first = c.children[0];
    updatePreview(c, "<p>same</p><p>new</p>");
    expect(c.children[0]).toBe(first);
  });

  it("keeps enhanced node when raw content is unchanged", () => {
    const c = container(
      '<pre data-enhanced="mermaid" data-raw="graph TD"><svg id="keep"></svg></pre><p>x</p>'
    );
    updatePreview(
      c,
      '<pre><code class="language-mermaid">graph TD</code></pre><p>y</p>'
    );
    expect(c.querySelector("#keep")).not.toBeNull();
    expect(c.querySelector("p")!.textContent).toBe("y");
  });

  it("replaces enhanced node when raw content changed", () => {
    const c = container(
      '<pre data-enhanced="mermaid" data-raw="graph TD"><svg id="stale"></svg></pre>'
    );
    updatePreview(c, '<pre><code class="language-mermaid">graph LR</code></pre>');
    expect(c.querySelector("#stale")).toBeNull();
    expect(c.querySelector("code")!.textContent).toBe("graph LR");
  });
});
