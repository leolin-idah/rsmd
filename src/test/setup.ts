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
