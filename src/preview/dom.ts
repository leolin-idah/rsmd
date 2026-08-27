import morphdom from "morphdom";

export function rawOf(el: Element): string | null {
  if (el.matches("pre")) {
    const code = el.querySelector("code");
    return code ? code.textContent : null;
  }
  if (el.matches("span[data-math-style]")) return el.textContent;
  if (el.matches("img")) return el.getAttribute("src");
  return null;
}

export function updatePreview(container: HTMLElement, html: string): void {
  const next = container.cloneNode(false) as HTMLElement;
  next.innerHTML = html;
  morphdom(container, next, {
    onBeforeElUpdated(fromEl, toEl) {
      const from = fromEl as HTMLElement;
      if (from.dataset?.enhanced !== undefined && from.dataset.raw === rawOf(toEl)) {
        return false;
      }
      return !fromEl.isEqualNode(toEl);
    },
  });
}
