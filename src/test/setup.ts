// jsdom 的 navigator.platform 默认是空串，prosemirror-keymap 在模块顶层用它判断
// mac（`/Mac|iP(hone|[oa]d)/.test(navigator.platform)`），据此把 "Mod-" 归一化成
// "Cmd-"（Mac）还是 "Ctrl-"（其它平台）——这个常量只在模块首次加载时算一次。
// rsmd 是仅面向 macOS 的 Tauri 应用，真机上 Mod-K 就是 Cmd-K；这里把 setup 阶段的
// navigator.platform 也设成 Mac，让 ⌘K 一类快捷键测试（dispatch 的是 metaKey）与生产行为一致。
if (typeof navigator !== "undefined" && !/Mac|iP(hone|[oa]d)/.test(navigator.platform)) {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
}

// CodeMirror 6 的测量代码依赖 Range.getClientRects / getBoundingClientRect，jsdom 未实现。
// 返回零矩形即可：测试只断言 EditorState 与装饰集，不依赖真实布局。
const zeroRect = () =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
if (typeof Range !== "undefined") {
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () =>
      ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = zeroRect;
  }
}

// ProseMirror / floating-ui / 懒渲染在 jsdom 下需要的桩：无布局环境里只要"不抛错"。
// 测试断言 doc 与属性，不断言像素。
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (typeof globalThis.IntersectionObserver === "undefined") {
  // observe 即视为可见：懒渲染在测试里同步发生，用例不必手动触发
  globalThis.IntersectionObserver = class {
    constructor(private readonly cb: IntersectionObserverCallback) {}
    observe(el: Element) {
      this.cb(
        [{ isIntersecting: true, target: el } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver
      );
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
}
