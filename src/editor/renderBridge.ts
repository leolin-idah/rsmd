import { Annotation } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { RenderPayload } from "../ipc";
import { blocksField, segmentIndexAt } from "./blockWidgets";

/// 外部同步（热刷新 / 冲突重载）事务的标记：blocks 随文本一起到达，不触发再渲染
export const externalSync = Annotation.define<boolean>();

export type RenderRequest = (text: string) => Promise<RenderPayload | null>;
export type RenderApply = (view: EditorView, payload: RenderPayload) => void;

/// 渲染时机：文档改动后停顿 idleMs；或改动尚未渲染而光标已离开所在段（该段要立刻变回 widget）。
/// 请求携带文档版本号，回包时版本不符即丢弃——idle 计时器会再发一次。
export function renderBridge(request: RenderRequest, apply: RenderApply, idleMs = 500) {
  return ViewPlugin.fromClass(
    class {
      private version = 0;
      private rendered = 0;
      private timer: ReturnType<typeof setTimeout> | null = null;
      private lastSegment: number;
      private destroyed = false;

      constructor(private readonly view: EditorView) {
        this.lastSegment = this.segmentAt(view);
      }

      update(u: ViewUpdate): void {
        if (u.docChanged) {
          this.version++;
          if (u.transactions.some((tr) => tr.annotation(externalSync))) this.rendered = this.version;
          else this.schedule(idleMs);
        }
        const seg = this.segmentAt(u.view);
        if (u.selectionSet && seg !== this.lastSegment && this.rendered !== this.version) this.schedule(0);
        this.lastSegment = seg;
      }

      renderNow(): Promise<void> {
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        return this.run();
      }

      destroy(): void {
        this.destroyed = true;
        if (this.timer) clearTimeout(this.timer);
      }

      private segmentAt(view: EditorView): number {
        return segmentIndexAt(view.state.field(blocksField).segments, view.state.selection.main.head);
      }

      private schedule(ms: number): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.run();
        }, ms);
      }

      private async run(): Promise<void> {
        const version = this.version;
        // 渲染失败（IPC 出错）视同无结果：不能让拒绝冒泡到 endEditing，否则编辑器会卡在可编辑态
        let payload: RenderPayload | null;
        try {
          payload = await request(this.view.state.doc.toString());
        } catch (err) {
          console.warn("render_markdown failed", err);
          payload = null;
        }
        if (!payload || this.destroyed || version !== this.version) return;
        this.rendered = version;
        apply(this.view, payload);
      }
    }
  );
}
